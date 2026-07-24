/**
 * 阈限月台：两节车厢顶板横版走动；角色复用 Avatar 皮套与程序化动作。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Entity = window.AvatarEntity;
  const canvas = document.getElementById('lpCanvas');
  const ctx = canvas.getContext('2d');

  const userId = document.body.dataset.userId || '';
  const nickname = document.body.dataset.nickname || '旅人';

  const JUMP_SPEED = 520;
  const GRAVITY = 1400;
  const MOVE_SPEED = Entity.MOVE_SPEED;
  const RUN_SPEED = Entity.RUN_SPEED || Entity.MOVE_SPEED * 1.6;
  const HALF_W = (Entity.AVATAR_COLLISION_WIDTH * Entity.AVATAR_DRAW_SCALE) / 2;

  const platforms = Spec.buildWalkPlatforms();
  const worldLeft = platforms[0].left + HALF_W;
  const worldRight = platforms[platforms.length - 1].right - HALF_W;

  const local = {
    x: Spec.defaultSpawnX(),
    y: 0,
    vx: 0,
    vy: 0,
    onGround: true,
    kneel: 0,
  };

  /** 本地生命与受击硬直（小怪触碰）；联机权威伤害为后续项。 */
  const PLAYER_MAX_HP = 100;
  let playerHp = PLAYER_MAX_HP;
  let hitStunT = 0;
  let hitInvulnT = 0;

  const avatar = Entity.createAvatarEntity({
    id: userId,
    nickname,
    x: local.x,
    y: Spec.FLOOR_Y,
  });

  const keys = new Set();
  const carImages = new Map();
  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let baseZoom = 1;
  let zoom = 1;
  /** 加燃料模式镜头倍率（平滑插值到 1.7）。 */
  let feedZoomMul = 1;
  let lastTs = 0;
  let loopStarted = false;

  /** 电脑端准星（屏幕坐标）与平滑镜头焦点（世界坐标）。 */
  const pointer = { x: 0, y: 0, known: false };
  const camFocus = { x: local.x, y: Spec.FLOOR_Y };
  const LOOK_WEIGHT = 0.58;
  const LOOK_WEIGHT_Y = 0.36;
  const CAM_SMOOTH = 9;
  const crosshairEl = document.getElementById('lpCrosshair');
  const crosshairAltEl = document.getElementById('lpCrosshairAlt');

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)');

  /** 读取触控输入（移动端；无模块时回退并带上自动奔跑偏好）。 */
  function readTouchInput() {
    return (
      window.LpTouchControls?.read() || {
        direction: 0,
        jump: false,
        interact: false,
        fire: false,
        sprintToggle: Boolean(window.LpInputBindings?.getAutoRun?.()),
        look: { x: 0, y: 0, mag: 0, active: false, ready: false },
      }
    );
  }

  /** 交互键显示文案。 */
  function formatInteractKey() {
    const label = window.LpInputBindings?.formatAction('interact') || 'F';
    return label.split(' / ')[0];
  }

  /** 物品栏键显示文案。 */
  function formatInventoryKey() {
    const label = window.LpInputBindings?.formatAction('inventory') || 'Tab';
    return label.split(' / ')[0];
  }

  /** 是否有全屏 UI（物品栏 / 列车地图 / 锅炉 / 加燃料 / 弹药箱 / 雷达 / 枢机）。 */
  function isUiOpen() {
    return (
      (window.LpInventory?.isOpen() ?? false) ||
      (window.LpTrainMap?.isOpen() ?? false) ||
      (window.LpBoilerPanel?.isOpen() ?? false) ||
      (window.LpFuelFeed?.isOpen() ?? false) ||
      (window.LpGuardCrateUi?.isOpen() ?? false) ||
      (window.LpRadarScope?.isOpen() ?? false) ||
      (window.LpAutoConsole?.isOpen() ?? false)
    );
  }

  /** 物品栏是否打开。 */
  function isInventoryOpen() {
    return window.LpInventory?.isOpen() ?? false;
  }

  /** 是否触屏设备布局。 */
  function isCoarsePointer() {
    return coarsePointer.matches;
  }

  /** 是否处于准星镜头模式（桌面鼠标 / 移动端瞄准摇杆）。 */
  function isAimCameraMode() {
    return !isUiOpen();
  }

  let desktopFireHeld = false;

  /** 同步准星显示与系统光标（双联时另跟对角线 2 号准星）。 */
  function syncAimCursor() {
    const aim = isAimCameraMode() && pointer.known;
    const turret = window.LpGuardTurret?.isManned?.() ?? false;
    const dual = Boolean(turret && window.LpGuardTurret?.isSoloDual?.());
    document.body.classList.toggle('lp-aim-mode', !isCoarsePointer() && !isUiOpen());
    document.body.classList.toggle('lp-turret-mode', turret);
    if (!crosshairEl) return;
    crosshairEl.hidden = !aim;
    if (aim) {
      crosshairEl.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
      window.LpCombat?.syncCrosshairBloom?.();
    }
    if (crosshairAltEl) {
      const showAlt = aim && dual;
      crosshairAltEl.hidden = !showAlt;
      if (showAlt) {
        crosshairAltEl.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
      }
    }
  }

  /** 屏幕坐标 → 世界坐标（基于当前相机）。 */
  function screenToWorld(screenX, screenY, view) {
    return {
      x: (screenX - view.offsetX) / view.zoom,
      y: (screenY - view.offsetY) / view.zoom,
    };
  }

  /** 世界坐标 → 屏幕坐标。 */
  function worldToScreen(worldX, worldY, view) {
    return {
      x: worldX * view.zoom + view.offsetX,
      y: worldY * view.zoom + view.offsetY,
    };
  }

  /** 用当前 camFocus 估算相机（供瞄准换算，避免循环依赖）。 */
  function provisionalCameraView() {
    return {
      zoom,
      offsetX: viewW * 0.5 - camFocus.x * zoom,
      offsetY: viewH * 0.5 - camFocus.y * zoom,
    };
  }

  /** 移动端准星吸附：屏幕半径（px）；越近拉力越强，不硬锁。 */
  const TOUCH_AIM_ASSIST_RADIUS_PX = 88;
  /** 最大朝目标中心的混合比例（0–1）；留足余量做微调。 */
  const TOUCH_AIM_ASSIST_MAX_PULL = 0.46;

  /**
   * 对原始触控准星做软磁吸附：在半径内拉向最近存活敌方（LpMobs / 战斗敌方）。
   * 拉力随距离二次衰减；不硬锁，桌面鼠标路径不调用。
   */
  function applyTouchAimAssist(screenX, screenY, view) {
    const hostiles =
      window.LpMobs?.listHostiles?.() ||
      window.LpCombat?.listHostiles?.() ||
      [];
    if (!hostiles.length) return { x: screenX, y: screenY };

    let bestX = 0;
    let bestY = 0;
    let bestDist = Infinity;
    let bestRadius = TOUCH_AIM_ASSIST_RADIUS_PX;

    for (let i = 0; i < hostiles.length; i += 1) {
      const h = hostiles[i];
      const sx = Number(h.x);
      const sy = Number(h.y);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      const scr = worldToScreen(sx, sy, view);
      if (
        scr.x < -48 ||
        scr.x > viewW + 48 ||
        scr.y < -48 ||
        scr.y > viewH + 48
      ) {
        continue;
      }
      const mobScreenR = Math.max(0, Number(h.radius) || 0) * view.zoom;
      const assistR = TOUCH_AIM_ASSIST_RADIUS_PX + mobScreenR * 0.4;
      const dist = Math.hypot(screenX - scr.x, screenY - scr.y);
      if (dist >= assistR || dist >= bestDist) continue;
      bestDist = dist;
      bestRadius = assistR;
      bestX = scr.x;
      bestY = scr.y;
    }

    if (bestDist === Infinity) return { x: screenX, y: screenY };

    const t = 1 - bestDist / bestRadius;
    const pull = TOUCH_AIM_ASSIST_MAX_PULL * t * t;
    return {
      x: screenX + (bestX - screenX) * pull,
      y: screenY + (bestY - screenY) * pull,
    };
  }

  /**
   * 移动端：瞄准摇杆方向 × 把手距离 → 准星屏幕位置（松手保持方向与距离）。
   * lead = maxLead * mag；mag 为死区外归一化 0–1。近敌时再软吸附。
   */
  function syncTouchAimPointer() {
    if (!isCoarsePointer() || isUiOpen()) return;
    const look =
      window.LpTouchControls?.getLook?.() || {
        x: 0,
        y: 0,
        mag: 0,
        ready: false,
      };
    const view = provisionalCameraView();
    const aimAnchorY = avatar.y - 56;
    const playerScreen = worldToScreen(local.x, aimAnchorY, view);
    const maxLead = Math.min(viewW, viewH) * 0.42 * (window.LpGuardTurret?.getAimLeadScale?.() ?? 1);
    const maxLeadY = maxLead * (window.LpGuardTurret?.isManned?.() ? 1.15 : 0.9);
    let rawX;
    let rawY;
    if (look.ready) {
      const mag = Math.min(1, Math.max(0, Number(look.mag) || 0));
      rawX = playerScreen.x + look.x * maxLead * mag;
      rawY = playerScreen.y + look.y * maxLeadY * mag;
    } else {
      const facing = avatar.facing >= 0 ? 1 : -1;
      rawX = playerScreen.x + facing * maxLead * 0.55;
      rawY = playerScreen.y - maxLeadY * 0.08;
    }
    const assisted = applyTouchAimAssist(rawX, rawY, view);
    pointer.x = assisted.x;
    pointer.y = assisted.y;
    pointer.known = true;
  }

  /** 准星对应的世界瞄准点。 */
  function getAimWorld() {
    if (pointer.known) {
      return screenToWorld(pointer.x, pointer.y, provisionalCameraView());
    }
    const facing = avatar.facing >= 0 ? 1 : -1;
    return { x: local.x + facing * 160, y: avatar.y - 56 };
  }

  /** 持枪/换弹用瞄准点（换弹时抬枪露顶匣；调试面板可锁定瞄准角）。 */
  function getWeaponAimWorld() {
    return (
      window.LpHoldPoseDebug?.getAimWorld?.(avatar)
      || window.LpReloadAction?.getAimOverride?.(avatar)
      || getAimWorld()
    );
  }

  /** 枪口世界坐标（持枪时沿瞄准方向；否则胸部占位）。 */
  function getMuzzleWorld() {
    const aim = getWeaponAimWorld();
    const item = window.LpCombat?.getHeldWeaponItem?.();
    if (item && window.LpWeaponHold?.getMuzzleWorld) {
      return window.LpWeaponHold.getMuzzleWorld(avatar, aim, item);
    }
    const facing = avatar.facing >= 0 ? 1 : -1;
    return {
      x: local.x + facing * 22,
      y: avatar.y - 58,
    };
  }

  /** 抛壳口世界坐标。 */
  function getEjectWorld() {
    const aim = getWeaponAimWorld();
    const item = window.LpCombat?.getHeldWeaponItem?.();
    if (item && window.LpWeaponHold?.getEjectWorld) {
      return window.LpWeaponHold.getEjectWorld(avatar, aim, item);
    }
    return getMuzzleWorld();
  }

  /** 向当前瞄准方向开火（手持武器或卫兵防御炮塔）；持医疗箱时改走治疗。 */
  function requestFire() {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (isUiOpen() || !window.LpCombat) return;
    if (window.LpMedkit?.isHoldingMedkit?.()) return;
    window.LpPressure?.noteAction?.();
    const aim = getAimWorld();
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.tryFire(aim.x, aim.y);
      return;
    }
    const muzzle = getMuzzleWorld();
    const eject = getEjectWorld();
    window.LpCombat.tryFire({
      originX: muzzle.x,
      originY: muzzle.y,
      ejectX: eject.x,
      ejectY: eject.y,
      dirX: aim.x - muzzle.x,
      dirY: aim.y - muzzle.y,
      facing: avatar.facing,
      moveSpeed: local.vx,
    });
  }

  /**
   * 按住时是否应连发：入座机炮，或手持全自动/机炮类武器，或持医疗箱持续治疗。
   * 半自动仅依赖 pointerdown / keydown / lp:fire 单发。
   */
  function shouldHoldFire() {
    if (window.LpGuardTurret?.isManned?.()) return true;
    if (window.LpMedkit?.isHoldingMedkit?.()) return true;
    return Boolean(window.LpCombat?.isHeldWeaponFullAuto?.());
  }

  /**
   * 每帧轮询开火键/指针是否仍按住；全自动或入座机炮或医疗箱时触发。
   * 入座 early-return 路径也必须调用，否则长按无法连发。
   */
  function pollHoldFire() {
    const touch = readTouchInput();
    const fireHeld =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    if (fireHeld && window.LpMedkit?.isHoldingMedkit?.() && !window.LpGuardTurret?.isManned?.()) {
      return;
    }
    if (fireHeld && shouldHoldFire()) requestFire();
  }

  /** 每帧推进医疗箱持续治疗（与 pollHoldFire 共用按住判定）。 */
  function tickMedkit(dt) {
    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) return;
    const touch = readTouchInput();
    const fireHeld =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    if (!fireHeld) return;
    const aim = getAimWorld();
    const remotes = [];
    const remoteMap = window.LiminalSession?.remotes?.();
    if (remoteMap && typeof remoteMap.values === 'function') {
      for (const r of remoteMap.values()) remotes.push(r);
    }
    window.LpMedkit?.tick?.(dt, {
      fireHeld: true,
      aimX: aim.x,
      aimY: aim.y,
      selfX: local.x,
      selfY: avatar.y,
      remotes,
      localUserId: userId,
    });
  }

  /** 回复本地生命（医疗箱等）；不超过上限。濒死/死亡中忽略（复活走专用路径）。 */
  function healPlayer(amount) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return playerHp;
    const add = Math.max(0, Number(amount) || 0);
    if (add <= 0) return playerHp;
    playerHp = Math.min(PLAYER_MAX_HP, playerHp + add);
    syncHpHud();
    return playerHp;
  }

  /** 刷新左上角生命条（委托 LpHudVitals）。 */
  function syncHpHud() {
    window.LpHudVitals?.syncHp?.(playerHp, PLAYER_MAX_HP);
  }

  /** 装填：优先无人机（选中时），否则手持武器。 */
  function requestReload() {
    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) return;
    if (window.LpHummingbirdDrone?.tryReloadIfSelected?.()) return;
    window.LpCombat?.tryReload?.();
  }

  /** 与 avatar-lobby 一致：把 skins API 条目转成 appearance。 */
  function appearanceFromSkin(skin) {
    if (!skin) {
      return {
        skinId: null,
        kind: 'plain',
        heightScale: Entity.DEFAULT_HEIGHT_SCALE,
        contentHash: '',
      };
    }
    return {
      skinId: skin.id,
      kind: skin.kind || 'plain',
      heightScale: skin.height_scale ?? Entity.DEFAULT_HEIGHT_SCALE,
      contentHash: skin.content_hash || skin.created_at || '',
    };
  }

  /** 拉取当前穿戴皮套并应用到本地 avatar（与大厅同一 API / Entity.loadAppearance）。 */
  async function loadWornAppearance() {
    try {
      const response = await fetch('/avatar-lobby/skins');
      if (!response.ok) {
        console.warn('[liminal] skins API', response.status);
        return;
      }
      const payload = await response.json();
      const skins = payload.skins || [];
      const wornId = payload.worn;
      // 与大厅一致：只应用已穿戴皮套，不擅自换成 skins[0]
      const skin = wornId ? skins.find((item) => item.id === wornId) || null : null;
      const appearance = appearanceFromSkin(skin);
      // 先预热本地皮套库（含当前穿戴），远端同 URL 复用 Cache Storage
      window.AvatarSkinCache?.preloadSkins?.(skins);
      await Entity.loadAppearance(avatar, appearance);
      window.LiminalSession?.setAppearance?.(appearance);
      syncAvatarPose();
      avatar._lpSkinMeta = skin
        ? { id: skin.id, name: skin.name, kind: skin.kind }
        : null;
    } catch (error) {
      console.warn('[liminal] loadWornAppearance failed', error);
    }
  }

  /** 脚底相对当前平台顶边的世界 Y → avatar 绘制锚点（与大厅一致：锚点在身中，脚在 +AVATAR_SIZE/2）。 */
  function stageYFromPhysics(physicsY, entity = avatar, atX = local.x) {
    const floorY = floorAt(atX) ?? Spec.FLOOR_Y;
    return (
      floorY
      + physicsY
      - Entity.AVATAR_SIZE / 2
      - Entity.footGroundLiftPx(entity)
    );
  }

  /** 同步运动状态到 avatar 实体（供绘制与程序化动作）。 */
  function syncAvatarPose() {
    avatar.x = local.x;
    avatar.y = stageYFromPhysics(local.y);
    avatar.vx = local.vx;
    avatar.vy = local.vy;
    avatar.onGround = local.onGround;
    avatar.kneel = local.kneel;
  }

  /** 远端实体的舞台 Y。 */
  function remoteStageY(entity, physicsY) {
    return stageYFromPhysics(physicsY, entity, entity.x);
  }

  /** 预加载两节车厢贴图。 */
  function loadCarImages() {
    return Promise.all(
      Spec.CARRIAGES.map(
        (car) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              carImages.set(car.id, img);
              resolve();
            };
            img.onerror = reject;
            img.src = car.image;
          })
      )
    );
  }

  /** 根据视口高度计算基础缩放，移动端略缩小以露出触控区。 */
  function updateZoom() {
    const base = isCoarsePointer() ? viewH / 1040 : viewH / 860;
    baseZoom = Math.min(Math.max(base, 0.32), 1.2);
    zoom = baseZoom * feedZoomMul;
  }

  /** 同步 canvas 像素尺寸。 */
  function resizeStage() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    updateZoom();
  }

  /** 限制镜头相对玩家的最大偏移，避免角色跑出安全区。 */
  function clampLookLead(targetX, targetY) {
    const turret = window.LpGuardTurret?.isManned?.() ?? false;
    const lead = window.LpGuardTurret?.getAimLeadScale?.() ?? 1;
    const maxLeadX = (viewW * (turret ? 0.40 : 0.36) * lead) / zoom;
    /* 炮塔需要更大仰角视野，纵向领先明显高于步行瞄准 */
    const maxLeadY = (viewH * (turret ? 0.52 : 0.26) * lead) / zoom;
    return {
      x: Math.max(local.x - maxLeadX, Math.min(local.x + maxLeadX, targetX)),
      y: Math.max(Spec.FLOOR_Y - maxLeadY, Math.min(Spec.FLOOR_Y + maxLeadY, targetY)),
    };
  }

  /**
   * 世界坐标相机。
   * 桌面：焦点偏向鼠标准星；移动端：偏向瞄准摇杆虚拟准星。
   * 驾驶台：人物落在操作台上方空白区；加燃料 / 其它 UI 对准站立角色。
   */
  function cameraView() {
    const boilerOpen = window.LpBoilerPanel?.isOpen?.() ?? false;
    const feedOpen =
      (window.LpFuelFeed?.isOpen?.() ?? false) ||
      (window.LpGuardCrateUi?.isOpen?.() ?? false);

    if (boilerOpen) {
      /* 操作台约占下半屏，把角色锚到上方空白区中部 */
      const focusX = viewW * 0.5;
      const avatarScreenY = viewH * (isCoarsePointer() ? 0.28 : 0.30);
      return {
        zoom,
        offsetX: focusX - camFocus.x * zoom,
        offsetY: avatarScreenY - camFocus.y * zoom,
      };
    }

    if (feedOpen || isUiOpen() || !pointer.known) {
      const focusX = viewW * (isCoarsePointer() ? 0.5 : 0.48);
      const floorScreenY = viewH * (isCoarsePointer() ? 0.58 : 0.62);
      return {
        zoom,
        offsetX: focusX - camFocus.x * zoom,
        offsetY: floorScreenY - camFocus.y * zoom,
      };
    }
    return {
      zoom,
      offsetX: viewW * 0.5 - camFocus.x * zoom,
      offsetY: viewH * 0.5 - camFocus.y * zoom,
    };
  }

  /** 每帧平滑更新镜头焦点与控制台 / 加燃料放大 / 炮塔缩小。 */
  function stepCamera(dt) {
    const feedOpen =
      (window.LpFuelFeed?.isOpen?.() ?? false) ||
      (window.LpGuardCrateUi?.isOpen?.() ?? false);
    const boilerOpen = window.LpBoilerPanel?.isOpen?.() ?? false;
    const turretManned = window.LpGuardTurret?.isManned?.() ?? false;
    /* 驾驶台略放大；加燃料 / 弹药箱更近；炮塔拉远以便仰射 */
    const wantMul = feedOpen ? 2.35 : boilerOpen ? 1.55 : turretManned ? 0.52 : 1;
    const zoomEase = turretManned || Math.abs(feedZoomMul - 1) > 0.02 ? 3.4 : 5.8;
    feedZoomMul += (wantMul - feedZoomMul) * (1 - Math.exp(-zoomEase * dt));
    zoom = baseZoom * feedZoomMul;

    let targetX = local.x;
    let targetY = Spec.FLOOR_Y;
    if (boilerOpen) {
      /* 焦点略抬到躯干，配合上方构图 */
      targetY = Spec.FLOOR_Y - 48;
    } else if (feedOpen) {
      targetY = Spec.FLOOR_Y - 70;
    } else if (isAimCameraMode() && pointer.known) {
      const provisional = {
        zoom,
        offsetX: viewW * 0.5 - camFocus.x * zoom,
        offsetY: viewH * 0.5 - camFocus.y * zoom,
      };
      const world = screenToWorld(pointer.x, pointer.y, provisional);
      const lookY = turretManned ? 0.58 : LOOK_WEIGHT_Y;
      targetX = local.x * (1 - LOOK_WEIGHT) + world.x * LOOK_WEIGHT;
      targetY = Spec.FLOOR_Y * (1 - lookY) + world.y * lookY;
      const clamped = clampLookLead(targetX, targetY);
      targetX = clamped.x;
      targetY = clamped.y;
    }

    const focusEase = turretManned ? CAM_SMOOTH * 0.72 : CAM_SMOOTH;
    const t = 1 - Math.exp(-focusEase * dt);
    camFocus.x += (targetX - camFocus.x) * t;
    camFocus.y += (targetY - camFocus.y) * t;
  }

  /** 查询某 x 处最高的可走平台顶边（世界 Y）。 */
  function floorAt(x) {
    let best = null;
    for (const platform of platforms) {
      if (x >= platform.left && x <= platform.right) {
        if (best === null || platform.y < best) best = platform.y;
      }
    }
    return best;
  }

  function approach(value, target, maxStep) {
    if (value < target) return Math.min(value + maxStep, target);
    return Math.max(value - maxStep, target);
  }

  /**
   * 小怪触碰：若在炮塔等岗位上则先离席，再扣血、击飞，并给关节初速做简易布娃娃。
   * 仅走 mob onHit 路径；其它伤害源不经此函数，不会误踢下岗。
   * @param {{ damage?: number, knockVx?: number, knockVy?: number }} hit
   */
  function applyMobHit(hit) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (hitInvulnT > 0 || hitStunT > 0.2) return;
    /* 岗位上受击：走与 F 离席相同的 exitTurret，再按站立受击处理击退 */
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
    }
    const dmg = Math.max(0, Number(hit?.damage) || 0);
    playerHp = Math.max(0, playerHp - dmg);
    syncHpHud();
    window.LpPressure?.noteMobHit?.(local.x);
    if (playerHp <= 0) {
      window.LpPlayerDeath?.onLethalHit?.({
        x: local.x,
        exitTurret: () => window.LpGuardTurret?.exitTurret?.(),
      });
    }
    const kx = Number(hit?.knockVx) || 0;
    const ky = Number(hit?.knockVy) || -280;
    local.vx = kx;
    local.vy = Math.min(local.vy, ky);
    local.onGround = false;
    hitStunT = 0.62;
    hitInvulnT = 0.9;
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    avatar.leanVelocity += Math.sign(kx || 1) * 9;
    avatar.squashVelocity = Math.max(avatar.squashVelocity, 3.2);
    const joints = avatar.joints;
    if (joints) {
      const flop = 14 + Math.abs(kx) * 0.012;
      for (const key of Object.keys(joints)) {
        const j = joints[key];
        if (!j) continue;
        j.velocity += (Math.random() - 0.5) * flop * 2;
      }
    }
  }

  /** 组装重生钩子（仓储传送 / 满血 / 短暂无敌）。 */
  function respawnHooks() {
    return {
      local,
      avatar,
      restoreHp() {
        playerHp = PLAYER_MAX_HP;
        syncHpHud();
      },
      syncPose: syncAvatarPose,
      setInvuln(t) {
        hitInvulnT = Math.max(0, Number(t) || 0);
        hitStunT = 0;
      },
    };
  }

  /** 濒死时仅保留重力落地与倒地姿势，忽略移动/开火。 */
  function stepIncapacitatedPhysics(dt) {
    if (hitInvulnT > 0) hitInvulnT = Math.max(0, hitInvulnT - dt);
    hitStunT = 0;
    local.vx *= Math.exp(-3.2 * dt);
    local.x = Math.max(worldLeft, Math.min(worldRight, local.x + local.vx * dt));
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;
    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
      if (Math.abs(local.vx) < 40) local.vx *= 0.5;
    } else {
      local.onGround = false;
    }
    Entity.updateEntityMotion(avatar, dt);
    window.LpPlayerDeath?.applyDownedPose?.(avatar, dt);
    local.kneel = avatar.kneel || 0;
    syncAvatarPose();
    const extras = window.LpPlayerDeath?.poseExtras?.() || {};
    window.LiminalSession?.maybeSendPose?.({
      x: local.x,
      y: local.y,
      vx: local.vx,
      vy: local.vy,
      facing: avatar.facing,
      onGround: local.onGround,
      gait: avatar.gait,
      headLook: 0,
      aimX: null,
      aimY: null,
      lifeState: extras.lifeState,
      downedRemain: extras.downedRemain,
      deathCause: extras.deathCause,
    });
  }

  /** 受击硬直期间：忽略移动输入，只保留击飞动量与重力落地。 */
  function stepHitStunPhysics(dt) {
    hitStunT = Math.max(0, hitStunT - dt);
    local.vx *= Math.exp(-2.4 * dt);
    local.x = Math.max(worldLeft, Math.min(worldRight, local.x + local.vx * dt));
    avatar.moveDirection = 0;
    avatar.gait = 'walk';
    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;
    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
      if (Math.abs(local.vx) < 40) local.vx *= 0.5;
    } else {
      local.onGround = false;
    }
    Entity.updateEntityMotion(avatar, dt);
    syncAvatarPose();
  }

  /** 积分玩家运动；y 为相对平台顶边的物理高度（地面 0，腾空为负）。 */
  function stepPhysics(dt) {
    if (hitInvulnT > 0) hitInvulnT = Math.max(0, hitInvulnT - dt);

    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      stepIncapacitatedPhysics(dt);
      return;
    }

    if (hitStunT > 0 && !isUiOpen() && !window.LpGuardTurret?.isManned?.()) {
      stepHitStunPhysics(dt);
      {
        const aim = getWeaponAimWorld();
        window.LiminalSession?.maybeSendPose?.({
          x: local.x,
          y: local.y,
          vx: local.vx,
          vy: local.vy,
          facing: avatar.facing,
          onGround: local.onGround,
          gait: avatar.gait,
          headLook: avatar.headLook,
          aimX: aim?.x,
          aimY: aim?.y,
        });
      }
      return;
    }

    if (isUiOpen() || window.LpGuardTurret?.isManned?.()) {
      local.vx = 0;
      avatar.gait = 'walk';
      avatar.moveDirection = 0;
      if (window.LpGuardTurret?.isManned?.() && isAimCameraMode() && pointer.known) {
        const world = screenToWorld(pointer.x, pointer.y, provisionalCameraView());
        window.LpGuardTurret.aimBoth(world.x, world.y);
        if (Math.abs(world.x - local.x) > 12) {
          avatar.facing = world.x < local.x ? -1 : 1;
        }
      }
      if (local.y < 0) {
        local.vy += GRAVITY * dt;
        local.y += local.vy * dt;
        if (local.y >= 0) {
          local.y = 0;
          local.vy = 0;
          local.onGround = true;
        }
      } else {
        local.y = 0;
        local.vy = 0;
        local.onGround = true;
      }
      Entity.updateEntityMotion(avatar, dt);
      syncAvatarPose();
      if (
        !isUiOpen() &&
        !window.LpGuardTurret?.isManned?.() &&
        window.LpCombat?.getHeldWeaponItem?.()
      ) {
        if (window.LpReloadAction?.isBusy?.()) {
          window.LpReloadAction.applyArmPose(avatar);
        } else {
          const held = window.LpCombat?.getHeldWeaponItem?.();
          window.LpWeaponHold?.applyAimArmPose?.(avatar, getWeaponAimWorld(), held);
        }
      }
      {
        const aim = getWeaponAimWorld();
        window.LiminalSession?.maybeSendPose?.({
          x: local.x,
          y: local.y,
          vx: local.vx,
          vy: local.vy,
          facing: avatar.facing,
          onGround: local.onGround,
          gait: avatar.gait,
          headLook: avatar.headLook,
          aimX: aim?.x,
          aimY: aim?.y,
        });
      }
      // 入座机炮时本分支会 return，须在此轮询长按连发（与下方步行路径共用 pollHoldFire）
      if (!isUiOpen() && window.LpGuardTurret?.isManned?.()) pollHoldFire();
      return;
    }

    const touch = readTouchInput();
    let direction = touch.direction;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) direction = -1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) direction = 1;

    if (direction !== 0) avatar.facing = direction;
    avatar.moveDirection = direction;
    if (direction !== 0) window.LpPressure?.noteAction?.();

    // 瞄准时朝向跟随准星（可边走边看）
    if (isAimCameraMode() && pointer.known) {
      const world = screenToWorld(pointer.x, pointer.y, provisionalCameraView());
      if (Math.abs(world.x - local.x) > 12) {
        avatar.facing = world.x < local.x ? -1 : 1;
      }
    }

    const autoRun = Boolean(window.LpInputBindings?.getAutoRun?.());
    let wantRun = false;
    if (direction !== 0) {
      if (isCoarsePointer() || autoRun) {
        /* 触控 / 自动奔跑：共用锁定；进房时 applyAutoRunPreference 已按偏好置位。 */
        wantRun = Boolean(
          window.LpTouchControls?.isSprintOn?.() ?? touch.sprintToggle
        );
      } else {
        /* 桌面且未开自动奔跑：按住奔跑键。 */
        wantRun = Boolean(window.LpInputBindings?.isPressed('sprint', keys));
      }
    }
    avatar.gait = wantRun ? 'run' : 'walk';

    const moveSpeed = wantRun ? RUN_SPEED : MOVE_SPEED;
    const targetVelocity = direction * moveSpeed;
    const acceleration = direction === 0 ? 1100 : wantRun ? 1900 : 1500;
    local.vx = approach(local.vx, targetVelocity, acceleration * dt);
    local.x = Math.max(worldLeft, Math.min(worldRight, local.x + local.vx * dt));

    const jumpPressed =
      touch.jump ||
      keys.has('Space') ||
      keys.has('ArrowUp') ||
      keys.has('KeyW');
    if (jumpPressed && local.onGround) {
      local.vy = -JUMP_SPEED;
      local.onGround = false;
      window.LpPressure?.noteAction?.();
    }

    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;

    const floorY = floorAt(local.x);
    if (floorY !== null && local.y >= 0) {
      local.y = 0;
      if (!wasOnGround) {
        avatar.squashVelocity = Math.min(Math.max(local.vy - 180, 0) / 100, 4.6);
      }
      local.vy = 0;
      local.onGround = true;
    } else {
      local.onGround = false;
    }

    Entity.updateEntityMotion(avatar, dt);
    syncAvatarPose();
    if (
      !isUiOpen() &&
      !window.LpGuardTurret?.isManned?.() &&
      window.LpCombat?.getHeldWeaponItem?.()
    ) {
      if (window.LpReloadAction?.isBusy?.()) {
        window.LpReloadAction.applyArmPose(avatar);
      } else {
        const held = window.LpCombat?.getHeldWeaponItem?.();
        window.LpWeaponHold?.applyAimArmPose?.(avatar, getWeaponAimWorld(), held);
      }
    }
    {
      const aim = getWeaponAimWorld();
      window.LiminalSession?.maybeSendPose?.({
        x: local.x,
        y: local.y,
        vx: local.vx,
        vy: local.vy,
        facing: avatar.facing,
        onGround: local.onGround,
        gait: avatar.gait,
        headLook: avatar.headLook,
        aimX: aim?.x,
        aimY: aim?.y,
      });
    }

    pollHoldFire();

    const activeSpot = window.LiminalInteract?.findActive(local) || null;
    window.LpTouchControls?.setInteractVisible(Boolean(activeSpot), activeSpot?.actionLabel);
    const inStorage =
      !isUiOpen() &&
      window.LiminalCarriageSpec?.carriageAt?.(local.x)?.id === 'storage';
    window.LpTouchControls?.setStorageHint?.(inStorage);
  }

  /**
   * 绘制单节车厢贴图（世界坐标）。
   * 颠簸仅经 LpCarriageBob 作用于本贴图；地板/碰撞/交互坐标不变。
   */
  function drawCarriage(car, carIndex) {
    const img = carImages.get(car.id);
    if (!img) return;
    const paint = () => {
      ctx.drawImage(img, car.worldX, 0, Spec.MODULE_W, Spec.MODULE_H);
    };
    if (window.LpCarriageBob?.withCarDraw) {
      window.LpCarriageBob.withCarDraw(ctx, car, carIndex, paint);
    } else {
      paint();
    }
  }

  /** 单帧渲染。 */
  function drawFrame() {
    const view = cameraView();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const gradient = ctx.createLinearGradient(0, 0, 0, viewH);
    gradient.addColorStop(0, '#0b1220');
    gradient.addColorStop(1, '#111827');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.setTransform(
      view.zoom * dpr, 0, 0, view.zoom * dpr,
      view.offsetX * dpr, view.offsetY * dpr
    );

    /* 轨道在车厢之下；炮管亦在贴图下，白球/车身挡住炮尾；火光/抛壳在贴图之上 */
    window.LpTrack?.draw?.(ctx);
    window.LpGuardTurret?.draw?.(ctx);
    Spec.CARRIAGES.forEach((car, i) => drawCarriage(car, i));
    window.LpGuardTurret?.drawFx?.(ctx);
    window.LiminalSession?.drawRemotes?.(ctx, view, dpr);
    const heldItem = window.LpCombat?.getHeldWeaponItem?.();
    /* 控制台/面板打开或濒死/死亡时仅隐藏持枪绘制与持枪层序，不卸装备 */
    const holdingGun =
      Boolean(heldItem) &&
      !window.LpGuardTurret?.isManned?.() &&
      !isUiOpen() &&
      !window.LpPlayerDeath?.isIncapacitated?.();
    /* 持枪层序（远→近）：后腿→前臂(橙/护木)→身→前腿→头→枪→换弹匣→后臂(红/握把) */
    Entity.drawAvatar(ctx, avatar, view, dpr, holdingGun ? { skipBackArm: true } : {});
    if (holdingGun) {
      const weaponAim = getWeaponAimWorld();
      window.LpWeaponHold?.drawHeldWeapon?.(ctx, avatar, weaponAim, heldItem);
      window.LpReloadAction?.draw?.(ctx, avatar, weaponAim);
      Entity.drawBackArm?.(ctx, avatar);
    }
    window.LpGroundLoot?.draw?.(ctx);
    /* 小怪在车厢之上，避免被贴图完全挡住；轨面怪仍可见于底盘外 */
    window.LpMobs?.draw?.(ctx);
    window.LpHummingbirdDrone?.draw?.(ctx);
    window.LpCombat?.draw(ctx);
    window.LpImpactFx?.draw?.(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    window.LiminalInteract?.drawActivePrompt(ctx, local, view, dpr, formatInteractKey(), {
      showPrompt: !isCoarsePointer() && !isUiOpen(),
      inventoryKeyLabel: formatInventoryKey(),
      mobile: isCoarsePointer(),
    });
  }

  /** 主循环。 */
  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min((ts - lastTs) / 1000, 0.05);
    lastTs = ts;
    syncTouchAimPointer();
    stepPhysics(dt);
    window.LpPlayerDeath?.tick?.(dt, {
      avatar,
      keys,
      coarse: isCoarsePointer(),
    });
    window.LpPlayerDeath?.watchAllyDeaths?.(local.x);
    window.LiminalSession?.tickRemotes?.(dt, remoteStageY);
    window.LpTrainDrive?.tick(dt);
    window.LpTrack?.tick?.(dt);
    window.LpCarriageBob?.tick?.(dt);
    window.LpCombat?.tick(dt, {
      floorY: Spec.FLOOR_Y,
      moveSpeed: local.vx,
    });
    window.LpImpactFx?.tick?.(dt);
    window.LpReloadAction?.tick?.(dt);
    window.LpGuardTurret?.tick?.(dt);
    if (!window.LpPlayerDeath?.isIncapacitated?.() && !window.LpGuardTurret?.isManned?.()) {
      const aim = getAimWorld();
      window.LpHummingbirdDrone?.tick?.(dt, {
        playerX: local.x,
        playerY: avatar.y,
        aimX: aim.x,
        aimY: aim.y,
        facing: avatar.facing,
      });
    } else {
      window.LpHummingbirdDrone?.despawn?.();
    }
    {
      const avatarH = Entity.AVATAR_SIZE * Entity.AVATAR_DRAW_SCALE * (avatar.heightScale || 1);
      const incap = Boolean(window.LpPlayerDeath?.isIncapacitated?.());
      window.LpMobs?.tick?.(dt, {
        player: {
          x: local.x,
          y: avatar.y,
          halfW: HALF_W,
          height: avatarH,
          /* 濒死/死亡期间无敌；入座仍可被打 */
          invuln: hitInvulnT > 0 || incap,
        },
        onHit: applyMobHit,
        view: cameraView(),
        viewW,
        viewH,
      });
    }
    window.LpAutoSensors?.tick?.(dt);
    window.LpAutoExecutors?.tick?.(dt);
    if (!window.LpPlayerDeath?.isIncapacitated?.()) tickMedkit(dt);
    window.LpPressure?.tick?.(dt, {
      localX: local.x,
      active: !window.LpPlayerDeath?.isIncapacitated?.(),
    });
    window.LpHudVitals?.tick?.();
    stepCamera(dt);
    syncAimCursor();
    updateLocalHeadLook(dt);
    window.LpBoilerPanel?.syncFromState?.();
    window.LpTrainAudio?.tick(dt);
    window.LpTrainMinimap?.syncFromWorldX?.(local.x);
    window.LpTrainMap?.syncFromWorldX?.(local.x);
    drawFrame();
    requestAnimationFrame(frame);
  }

  /** 电脑端：头看向鼠标（身后或仰角过大则回正）。 */
  function updateLocalHeadLook(dt) {
    if (!Entity.updateHeadLook) return;
    if (isCoarsePointer() || isUiOpen() || !pointer.known) {
      Entity.updateHeadLook(avatar, null, dt);
      return;
    }
    const view = cameraView();
    Entity.updateHeadLook(avatar, screenToWorld(pointer.x, pointer.y, view), dt);
  }

  /** 启动游戏循环（素材与皮套就绪后）。 */
  function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    syncAvatarPose();
    window.LpInventory?.flushSeedOverflow?.(local.x);
    window.LpMobs?.reset?.({
      view: cameraView(),
      viewW,
      viewH,
    });
    requestAnimationFrame(frame);
  }

  /** 首次按键/触控时解锁音频，并开启列车行驶环境音。 */
  function bindAudioUnlock() {
    const unlockOnce = () => {
      const sfxReady = window.LpSfx?.unlock?.() || Promise.resolve();
      Promise.resolve(sfxReady)
        .then(() => {
          const held = window.LpCombat?.getHeldWeaponItem?.();
          if (held?.fireSound) window.LpSfx?.preload?.([held.fireSound]);
          else {
            window.LpSfx?.preload?.([
              '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1',
            ]);
          }
        })
        .catch(() => {});
      window.LpTrainAudio?.unlock()
        .then(() => window.LpTrainAudio?.setAmbient(true))
        .catch(() => {});
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
    window.addEventListener('pointerdown', unlockOnce, { passive: true });
    window.addEventListener('keydown', unlockOnce);
  }

  /** 关闭燃料/驾驶台/弹药箱/雷达/列车地图等操作台；若有关闭则返回 true。 */
  function closeConsoleUi() {
    if (window.LpTrainMap?.isOpen()) {
      window.LpTrainMap.close();
      return true;
    }
    if (window.LpFuelFeed?.isOpen()) {
      window.LpFuelFeed.close();
      return true;
    }
    if (window.LpGuardCrateUi?.isOpen()) {
      window.LpGuardCrateUi.close();
      return true;
    }
    if (window.LpBoilerPanel?.isOpen()) {
      window.LpBoilerPanel.close();
      return true;
    }
    if (window.LpRadarScope?.isOpen()) {
      window.LpRadarScope.close();
      return true;
    }
    if (window.LpAutoConsole?.isOpen()) {
      window.LpAutoConsole.close();
      return true;
    }
    return false;
  }

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    keys.add(event.code);

    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
      return;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'Tab'].includes(event.code)) {
        event.preventDefault();
      }
      return;
    }

    if (window.LpInputBindings?.matchesKeyEvent('inventory', event)) {
      event.preventDefault();
      if (window.LpTrainMap?.isOpen()) window.LpTrainMap.close();
      if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
      if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
      if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
      if (window.LpRadarScope?.isOpen()) window.LpRadarScope.close();
      if (window.LpAutoConsole?.isOpen()) window.LpAutoConsole.close();
      window.LpInventory?.toggle(local.x);
      return;
    }

    /* 列车地图：可与其它操作台互关；不与物品栏抢 Tab */
    if (window.LpInputBindings?.matchesKeyEvent('trainMap', event)) {
      event.preventDefault();
      if (window.LpInventory?.isOpen()) return;
      if (window.LpTrainMap?.isOpen()) {
        window.LpTrainMap.close();
        return;
      }
      if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
      if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
      if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
      if (window.LpRadarScope?.isOpen()) window.LpRadarScope.close();
      if (window.LpAutoConsole?.isOpen()) window.LpAutoConsole.close();
      window.LpTrainMap?.open?.(local.x);
      return;
    }

    if (isUiOpen()) {
      if (event.code === 'Escape') {
        if (!closeConsoleUi()) window.LpInventory?.close();
        return;
      }
      // 操作台离席与交互键一致（默认 F）；地图仅 Esc / M / 点空白关闭
      if (
        window.LpInputBindings?.matchesKeyEvent('interact', event) &&
        !window.LpTrainMap?.isOpen() &&
        closeConsoleUi()
      ) {
        event.preventDefault();
      }
      return;
    }

    if (window.LpInputBindings?.matchesKeyEvent('interact', event)) {
      window.LiminalInteract?.tryInteract(local);
    }
    if (window.LpInputBindings?.matchesKeyEvent('handsHud', event)) {
      event.preventDefault();
      /* 武装入座：与手部共用键，循环弹种；否则切换手部槽。 */
      if (window.LpArmedAmmo?.isActive?.()) {
        window.LpArmedAmmo.cycle();
      } else {
        window.LpHandsHud?.cycleActive?.();
      }
    }
    /* 武装入座时数字键 1…N 直接选弹种（左→右）。 */
    if (window.LpArmedAmmo?.isActive?.()) {
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) {
        event.preventDefault();
        window.LpArmedAmmo.selectByNumber(Number(digit[1]));
      }
    }
    if (window.LpInputBindings?.matchesKeyEvent('fire', event)) {
      event.preventDefault();
      requestFire();
    }
    if (window.LpInputBindings?.matchesKeyEvent('reload', event)) {
      event.preventDefault();
      requestReload();
    }
    if (window.LpInputBindings?.matchesKeyEvent('sprint', event)) {
      /* 自动奔跑（或触控）下 Shift 边沿切换锁定；未开自动奔跑时桌面仍靠按住。 */
      if (
        isCoarsePointer() ||
        Boolean(window.LpInputBindings?.getAutoRun?.())
      ) {
        event.preventDefault();
        window.LpTouchControls?.toggleSprint?.();
      }
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'Tab'].includes(event.code)) {
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('pointermove', (event) => {
    if (isCoarsePointer()) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.known = true;
  });
  canvas.addEventListener('pointerdown', (event) => {
    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
      return;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) return;
    if (isCoarsePointer() || isUiOpen()) return;
    if (event.button !== 0) return;
    desktopFireHeld = true;
    requestFire();
  });
  window.addEventListener('pointerdown', (event) => {
    if (!window.LpPlayerDeath?.canAcceptRespawnInput?.()) return;
    if (event.target === canvas) return;
    if (window.LpPlayerDeath.tryRespawnFromEvent(event, respawnHooks())) {
      event.preventDefault();
    }
  });
  canvas.addEventListener('contextmenu', (event) => {
    if (window.LpPlayerDeath?.tryRespawnFromEvent?.(event, respawnHooks())) {
      event.preventDefault();
    }
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) desktopFireHeld = false;
  });
  window.addEventListener('pointercancel', () => {
    desktopFireHeld = false;
  });
  window.addEventListener('pointerleave', () => {
    if (isCoarsePointer()) return;
    pointer.known = false;
    desktopFireHeld = false;
    syncAimCursor();
  });
  window.addEventListener('blur', () => {
    keys.clear();
    if (!isCoarsePointer()) pointer.known = false;
    desktopFireHeld = false;
    syncAimCursor();
  });
  window.addEventListener('resize', resizeStage);
  coarsePointer.addEventListener('change', () => {
    updateZoom();
    syncAimCursor();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      window.LpTrainAudio?.resume();
      window.LpSfx?.resume?.();
      loadWornAppearance().then(syncAvatarPose);
    } else {
      keys.clear();
      window.LpTrainAudio?.suspend();
      window.LpSfx?.suspend?.();
    }
  });

  bindAudioUnlock();
  window.LpTouchControls?.applyAutoRunPreference?.();
  window.LiminalSession?.start?.({ userId, nickname });
  syncHpHud();
  window.LpGame = {
    getLocalAvatar: () => avatar,
    /** 本地玩家世界 X（压力同车判定 / HUD）。 */
    getLocalX: () => local.x,
    /** 全屏 UI（物品栏/锅炉/燃料/弹药箱/雷达/枢机）是否打开；联机上报可据此隐藏持枪。 */
    isUiOpen,
    /** 本地玩家当前生命值。 */
    getHp: () => playerHp,
    getMaxHp: () => PLAYER_MAX_HP,
    /** 回复生命（医疗箱等）；返回回血后的当前 HP。 */
    heal: healPlayer,
    /** 是否濒死或最终死亡（不可移动/开火）。 */
    isIncapacitated: () => Boolean(window.LpPlayerDeath?.isIncapacitated?.()),
    isDowned: () => Boolean(window.LpPlayerDeath?.isDowned?.()),
    isDead: () => Boolean(window.LpPlayerDeath?.isDead?.()),
    getLifeState: () => window.LpPlayerDeath?.getLifeState?.() || 'alive',
    /** 调试：直接触发一次击飞受击。 */
    debugMobHit(hit) {
      applyMobHit(hit || { damage: 10, knockVx: 400, knockVy: -320 });
    },
    /** 调试：直接扣至 0 血进入濒死/死亡。 */
    debugKill() {
      playerHp = 0;
      syncHpHud();
      window.LpPlayerDeath?.onLethalHit?.({ x: local.x });
    },
    /** 令本地角色朝向列车前进方向（屏幕右 / 世界 +X）。 */
    faceTrainForward() {
      const dir = Spec.TRAIN_FORWARD_X >= 0 ? 1 : -1;
      avatar.facing = dir;
      syncAvatarPose();
    },
    /** 调试：传送到指定车厢走道内。 */
    teleportToCar(carId) {
      const car = Spec.CARRIAGES.find((c) => c.id === carId);
      if (!car) return false;
      local.x = car.worldX + Spec.WALK_LEFT + Spec.scaleArt(80);
      local.vx = 0;
      syncAvatarPose();
      return true;
    },
  };

  /** 应用服务端广播的队友医箱复活（本机为目标或复活者）。 */
  window.addEventListener('lp:player-revived', (event) => {
    const d = event.detail || {};
    const localId = String(userId || '');
    const targetId = String(d.targetId || '');
    const byId = String(d.by || '');
    if (targetId && targetId === localId) {
      window.LpPlayerDeath?.applyAllyRevive?.({
        maxHp: PLAYER_MAX_HP,
        setHp(hp) {
          playerHp = Math.max(0, Math.min(PLAYER_MAX_HP, Number(hp) || 0));
          syncHpHud();
        },
        avatar,
        local,
        syncPose: syncAvatarPose,
        setInvuln(t) {
          hitInvulnT = Math.max(0, Number(t) || 0);
          hitStunT = 0;
        },
      });
    }
    if (byId && byId === localId) {
      window.LpPlayerDeath?.applyReviverPressureRelief?.(local.x);
    }
  });
  window.addEventListener('lp:turret-enter', (event) => {
    const turretId = event.detail?.turretId === 'right' ? 'right' : 'left';
    const spotId = turretId === 'right' ? 'guard-turret-right' : 'guard-turret-left';
    const spot = window.LiminalInteract?.INTERACTABLES?.find((s) => s.id === spotId);
    if (spot) {
      local.x = spot.worldX;
      local.vx = 0;
      syncAvatarPose();
    }
  });
  window.addEventListener('lp:interact', () => {
    window.LpPressure?.noteAction?.();
    if (closeConsoleUi()) return;
    if (isUiOpen()) return;
    window.LiminalInteract?.tryInteract(local);
  });
  window.addEventListener('lp:fire', () => {
    if (isUiOpen()) return;
    requestFire();
  });
  window.addEventListener('lp:inventory-toggle', () => {
    window.LpInventory?.toggle(local.x);
  });
  resizeStage();
  // 车厢与皮套分开加载：皮套失败不阻断进关，也不误报「车厢素材失败」
  loadCarImages()
    .then(() => {
      startLoop();
      return loadWornAppearance();
    })
    .catch(() => {
      const hint = document.getElementById('lpLoadError');
      if (hint) hint.hidden = false;
      window.LpTouchControls?.setEnabled(false);
    });
})();
