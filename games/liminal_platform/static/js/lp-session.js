/**
 * 阈限月台联机绑定：远端玩家、姿态上报、共享列车/燃料/开火。
 */
(() => {
  const Entity = window.AvatarEntity;
  const Net = window.LiminalNetwork;
  if (!Entity || !Net) return;

  const POSE_INTERVAL = 1000 / (Net.POSE_RATE_HZ || 20);
  const INTERP_DELAY_MS = 120;

  const remotePlayers = new Map();
  let session = null;
  let localUserId = '';
  let poseSequence = 0;
  let lastPoseSentAt = 0;
  let lastTrainSentAt = 0;
  let clockOffsetMs = null;

  /** 把服务端 wall-clock 映到 performance.now 时间轴。 */
  function mapServerMs(serverTimeMs) {
    const now = performance.now();
    if (serverTimeMs == null || !Number.isFinite(serverTimeMs)) return now;
    const offset = now - serverTimeMs;
    if (clockOffsetMs === null || Math.abs(offset - clockOffsetMs) > 1000) {
      clockOffsetMs = offset;
    } else {
      clockOffsetMs += (offset - clockOffsetMs) * 0.1;
    }
    return serverTimeMs + clockOffsetMs;
  }

  /** 创建并连接会话。 */
  function start(identity) {
    localUserId = String(identity.userId || '');
    session = Net.createSession();
    window.LiminalMultiplayerUi?.bindMultiplayerUi?.(session);
    session.connect(identity);
    window.addEventListener('beforeunload', () => session.disconnect());

    session.addEventListener('worldsnapshot', (event) => {
      applyWorldSnapshot(event.detail);
    });
    session.addEventListener('playerleave', (event) => {
      const id = String(event.detail?.playerId || '');
      if (!id) return;
      // 宽限期内仅标记断开，保留最后姿态；永久离开再删。
      if (event.detail?.temporary) {
        const remote = remotePlayers.get(id);
        if (remote) remote._lpDisconnected = true;
        return;
      }
      remotePlayers.delete(id);
    });
    session.addEventListener('appearance', (event) => {
      const detail = event.detail || {};
      const remote = remotePlayers.get(String(detail.playerId));
      if (remote && detail.appearance) Entity.loadAppearance(remote, detail.appearance);
    });
    session.addEventListener('roomchange', () => {
      remotePlayers.clear();
      clockOffsetMs = null;
    });
    session.addEventListener('fuelchanged', (event) => {
      const level = event.detail?.level;
      if (level != null) window.LiminalInteract?.setFuelLevel?.(level);
    });
    session.addEventListener('weaponfired', (event) => {
      const detail = event.detail || {};
      if (String(detail.playerId) === localUserId) return;
      window.LpCombat?.spawnProjectile?.({
        originX: detail.x,
        originY: detail.y,
        dirX: detail.dirX,
        dirY: detail.dirY,
        facing: detail.facing,
        weaponId: detail.weaponId,
        style: detail.style,
      });
    });

    window.addEventListener('lp:weapon-fired', (event) => {
      if (!session?.connected) return;
      session.sendFire(event.detail || {});
    });
  }

  /** 确保远端实体存在。 */
  function ensureRemote(playerId, snapshot) {
    let remote = remotePlayers.get(playerId);
    if (!remote) {
      remote = Entity.createAvatarEntity({
        id: playerId,
        nickname: snapshot.nickname || '旅人',
        x: snapshot.x ?? 0,
        y: 0,
      });
      remote._physicsY = snapshot.y ?? 0;
      remotePlayers.set(playerId, remote);
    }
    remote._lpDisconnected = false;
    return remote;
  }

  /** 把快照中的持枪/瞄准写到远端实体。 */
  function applyRemoteHold(remote, player) {
    remote._heldId = player.heldId || null;
    if (player.aimX != null && player.aimY != null) {
      remote._aimX = Number(player.aimX);
      remote._aimY = Number(player.aimY);
    } else {
      remote._aimX = null;
      remote._aimY = null;
    }
  }

  /** 应用世界快照：远端姿态 + 共享列车/燃料。 */
  function applyWorldSnapshot(payload) {
    if (!payload) return;
    const serverMs = mapServerMs(payload.serverTimeMs);
    const seen = new Set();
    for (const player of payload.players || []) {
      const id = String(player.id);
      if (!id || id === localUserId) continue;
      seen.add(id);
      if (player.connected === false) {
        const existing = remotePlayers.get(id);
        if (existing) existing._lpDisconnected = true;
        continue;
      }
      const remote = ensureRemote(id, player);
      Entity.pushSnapshot(
        remote,
        {
          x: player.x,
          y: player.y,
          vx: player.vx,
          vy: player.vy,
          facing: player.facing,
          onGround: player.onGround,
          gait: player.gait,
          headLook: player.headLook,
          nickname: player.nickname,
        },
        serverMs
      );
      applyRemoteHold(remote, player);
      if (player.appearance) Entity.loadAppearance(remote, player.appearance);
      remote.nickname = player.nickname || remote.nickname;
    }
    for (const id of [...remotePlayers.keys()]) {
      if (!seen.has(id)) remotePlayers.delete(id);
    }

    const world = payload.world;
    if (world?.train) window.LpTrainDrive?.applyAuthority?.(world.train);
    if (world?.fuel?.level != null) {
      window.LiminalInteract?.setFuelLevel?.(world.fuel.level);
    }
  }

  /** 上报本地姿态（限频）；持枪 id 由战斗模块读取，避免主循环改协议字段。 */
  function maybeSendPose(frame) {
    if (!session?.connected) return;
    const now = performance.now();
    if (now - lastPoseSentAt < POSE_INTERVAL) return;
    lastPoseSentAt = now;
    poseSequence += 1;
    const held = window.LpCombat?.getHeldWeaponItem?.();
    const turretManned = Boolean(window.LpGuardTurret?.isManned?.());
    session.sendPose({
      sequence: poseSequence,
      x: frame.x,
      y: frame.y,
      vx: frame.vx,
      vy: frame.vy,
      facing: frame.facing,
      onGround: frame.onGround,
      gait: frame.gait,
      headLook: frame.headLook,
      heldId: turretManned ? null : held?.id || null,
      aimX: frame.aimX,
      aimY: frame.aimY,
    });
  }

  /** 上报列车操作（限频；仅用户操作调用，勿在 applyAuthority 后调用）。force 用于急刹松手等必须送达的状态。 */
  function notifyTrain(state, options = {}) {
    if (!session?.connected || !state) return;
    const now = performance.now();
    if (!options.force && now - lastTrainSentAt < 50) return;
    lastTrainSentAt = now;
    session.sendTrain({
      throttle: state.throttle,
      brake: state.brake,
    });
  }

  /** 上报加燃料。 */
  function notifyFuelAdd(amount) {
    if (!session?.connected) return;
    session.sendFuelAdd(amount);
  }

  /**
   * 插值远端姿态并推进程序化动作。
   * stageYFromPhysics(entity, physicsY) 由主循环提供。
   */
  function tickRemotes(dt, stageYFromPhysics) {
    const renderMs = performance.now() - INTERP_DELAY_MS;
    for (const remote of remotePlayers.values()) {
      if (remote._lpDisconnected) continue;
      const sample = Entity.sampleRemote(remote, renderMs);
      if (!sample) continue;
      if (sample.x != null) remote.x = sample.x;
      remote._physicsY = sample.y ?? 0;
      remote.y = stageYFromPhysics(remote, remote._physicsY);
      remote.vx = sample.vx ?? 0;
      remote.vy = sample.vy ?? 0;
      remote.facing = sample.facing || remote.facing;
      remote.onGround = Boolean(sample.onGround);
      remote.gait = sample.gait === 'run' ? 'run' : 'walk';
      remote.headLook = sample.headLook ?? 0;
      remote.headLookVelocity = 0;
      remote.moveDirection = Math.sign(remote.vx) || 0;
      remote.nickname = sample.nickname || remote.nickname;
      Entity.updateEntityMotion(remote, dt);
    }
  }

  /** 远端默认瞄准点（无 aim 同步时按朝向前方）。 */
  function remoteAimWorld(remote) {
    if (remote._aimX != null && remote._aimY != null) {
      return { x: remote._aimX, y: remote._aimY };
    }
    const facing = remote.facing >= 0 ? 1 : -1;
    return { x: remote.x + facing * 140, y: remote.y - 56 };
  }

  /** 绘制远端玩家（含持枪层，避免只画本地枪导致远端缺武器）。 */
  function drawRemotes(ctx, view, dpr) {
    for (const remote of remotePlayers.values()) {
      if (remote._lpDisconnected) continue;
      const heldId = remote._heldId;
      const item = heldId ? window.LpItemCatalog?.getItem?.(heldId) : null;
      if (item && window.LpWeaponHold?.drawHeldWeapon) {
        const aim = remoteAimWorld(remote);
        Entity.applyAimArmPose?.(remote, aim);
        Entity.drawAvatar(ctx, remote, view, dpr);
        window.LpWeaponHold.drawHeldWeapon(ctx, remote, aim, item);
      } else {
        Entity.drawAvatar(ctx, remote, view, dpr);
      }
    }
  }

  function setAppearance(appearance) {
    session?.setAppearance?.(appearance);
  }

  function isConnected() {
    return Boolean(session?.connected);
  }

  window.LiminalSession = {
    start,
    maybeSendPose,
    notifyTrain,
    notifyFuelAdd,
    tickRemotes,
    drawRemotes,
    setAppearance,
    isConnected,
    getSession: () => session,
    remotes: () => remotePlayers,
  };
})();
