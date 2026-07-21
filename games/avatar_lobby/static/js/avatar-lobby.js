/**
 * 虚拟形象大厅：本地像素自绘 + 服务端权威广播远端。
 *
 * 自身移动完全在屏幕像素里积分，不跟服务端快照校正（避免瞬移）。
 * 输入仍发给服务端，供他人看到权威位置；只在进房时对齐一次出生点。
 */
(() => {
  const canvas = document.getElementById('lobbyCanvas');
  const ctx = canvas.getContext('2d');
  const lobbyRoot = document.querySelector('.stage-ui');
  // 与快照里的 id 统一成字符串，避免 number/string 不相等把自己当成远端。
  const localUserId = String(lobbyRoot.dataset.userId || '');
  const playerNickname = lobbyRoot.dataset.nickname || '玩家';

  const Entity = window.AvatarEntity;
  const MOVE_SPEED = Entity.MOVE_SPEED;
  const JUMP_SPEED = 520;
  const GRAVITY = 1400;
  const AVATAR_SIZE = Entity.AVATAR_SIZE;
  const AVATAR_DRAW_SCALE = Entity.AVATAR_DRAW_SCALE;
  const AVATAR_COLLISION_WIDTH = Entity.AVATAR_COLLISION_WIDTH;
  const DEFAULT_AVATAR_HEIGHT_SCALE = Entity.DEFAULT_HEIGHT_SCALE;
  const DELETE_CONFIRM_MS = 3000;
  // 远端按服务器时间轴延迟渲染：约两个快照间隔，抖动时插值区间仍然可用。
  const INTERP_DELAY_MS = 140;
  const SERVER_TICK_MS = 1000 / 30;

  const FOCUS_ZOOM = 2.4;
  const FOCUS_DURATION = 0.45;
  const FOCUS_SCREEN_X = 0.38;
  const FOCUS_SCREEN_Y = 0.58;

  const networkSession = window.AvatarNetwork.createSession();
  const networkStep = 1 / window.AvatarNetwork.INPUT_RATE_HZ;
  const isOfflineSession = networkSession.mode === 'offline';
  let networkAccumulator = 0;
  let inputSequence = 0;

  // 本地状态用屏幕像素：x 为水平位置，y 为相对地面高度（地面 0，腾空为负）。
  const local = { x: 0, y: 0, vx: 0, vy: 0, onGround: true, kneel: 0 };
  let clockOffsetMs = null;
  // 仅进房后第一次见到自己的快照时对齐；切后台不再硬拉位置。
  let needsSpawnSync = true;
  let syncedRoomId = null;

  const remotePlayers = new Map();
  const avatar = Entity.createAvatarEntity({
    id: localUserId,
    nickname: playerNickname,
  });

  function isLocalId(id) {
    return String(id) === localUserId;
  }

  networkSession.connect({
    playerId: localUserId,
    nickname: playerNickname,
  });
  window.AvatarMultiplayerUi.bindMultiplayerUi(networkSession);
  window.addEventListener('beforeunload', () => networkSession.disconnect());
  window.addEventListener('online', () => {
    if (!networkSession.connected && !isOfflineSession) {
      networkSession.connect({
        playerId: localUserId,
        nickname: playerNickname,
      });
    }
  });

  let viewW = 0;
  let viewH = 0;
  let dpr = 1;
  let groundY = 0;

  function edgeMargin() {
    return (AVATAR_COLLISION_WIDTH * AVATAR_DRAW_SCALE) / 2;
  }

  function stageYFromPhysics(physicsY, entity) {
    return groundY + physicsY - Entity.footGroundLiftPx(entity);
  }

  function clampX(x) {
    const margin = edgeMargin();
    return Math.max(margin, Math.min(viewW - margin, x));
  }

  // 仅用于出生对齐与远端插值：服务端 nx → 当前屏宽像素。
  function nxToX(nx) {
    const margin = edgeMargin();
    const usable = Math.max(1, viewW - margin * 2);
    return margin + Math.max(0, Math.min(1, nx)) * usable;
  }

  function resizeStage() {
    const prevW = viewW;
    const prevMargin = edgeMargin();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = `${viewW}px`;
    canvas.style.height = `${viewH}px`;
    groundY = viewH - AVATAR_SIZE;
    // 改宽时按比例保住相对位置，避免窗口缩放造成瞬移。
    if (prevW > 0) {
      const prevUsable = Math.max(1, prevW - prevMargin * 2);
      const t = (local.x - prevMargin) / prevUsable;
      local.x = clampX(nxToX(Math.max(0, Math.min(1, t))));
      avatar.x = local.x;
      avatar.y = stageYFromPhysics(local.y, avatar);
    }
  }

  resizeStage();
  local.x = clampX(viewW / 2);
  avatar.x = local.x;
  avatar.y = stageYFromPhysics(0, avatar);
  window.addEventListener('resize', resizeStage);

  const camera = { blend: 0, target: 0, focusX: FOCUS_SCREEN_X };
  const PANEL_FOCUS_X = { skinPanel: FOCUS_SCREEN_X, skinEditor: 0.22 };
  window.addEventListener('stagepanelchange', (event) => {
    if (!(event.detail.id in PANEL_FOCUS_X)) return;
    camera.target = event.detail.open ? 1 : 0;
    if (event.detail.open) camera.focusX = PANEL_FOCUS_X[event.detail.id];
  });

  function easeInOutQuad(t) {
    return t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2;
  }

  function updateCamera(dt) {
    const step = dt / FOCUS_DURATION;
    camera.blend = approach(camera.blend, camera.target, step);
  }

  function computeCameraTransform() {
    const t = easeInOutQuad(camera.blend);
    const zoom = 1 + (FOCUS_ZOOM - 1) * t;
    const anchorX = viewW / 2 + (viewW * camera.focusX - viewW / 2) * t;
    const anchorY = viewH / 2 + (viewH * FOCUS_SCREEN_Y - viewH / 2) * t;
    const focusX = viewW / 2 + (avatar.x - viewW / 2) * t;
    const focusY = viewH / 2 + (avatar.y - viewH / 2) * t;
    return { zoom, offsetX: anchorX - focusX * zoom, offsetY: anchorY - focusY * zoom };
  }

  const keys = new Set();
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    keys.add(event.code);
    if (
      isActionPressed('left') ||
      isActionPressed('right') ||
      isActionPressed('jump') ||
      isActionPressed('kneel')
    ) {
      event.preventDefault();
    }
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));

  function isActionPressed(action) {
    return window.InputBindings.isPressed(action, keys);
  }

  const skinEditorElement = document.getElementById('skinEditor');

  function readInputFrame() {
    if (!skinEditorElement.classList.contains('hidden')) {
      return { direction: 0, jump: false, kneel: false };
    }
    const touch = window.TouchControls.read();
    const keyboardDirection =
      Number(isActionPressed('right')) - Number(isActionPressed('left'));
    return {
      direction: touch.direction || keyboardDirection,
      jump: touch.jump || isActionPressed('jump'),
      kneel: touch.kneel || isActionPressed('kneel'),
    };
  }

  function approach(value, target, maxStep) {
    if (value < target) return Math.min(value + maxStep, target);
    return Math.max(value - maxStep, target);
  }

  // 本地像素物理：速度单位 px/s，与观感一致，不再经归一化坐标来回换算。
  function updateLocal(dt, input) {
    if (input.direction !== 0) avatar.facing = input.direction;
    avatar.moveDirection = input.kneel ? 0 : input.direction;

    const kneel = Boolean(input.kneel);
    const direction = kneel ? 0 : input.direction;
    const kneelTarget = kneel && local.onGround ? 1 : 0;
    local.kneel += (kneelTarget - local.kneel) * Math.min(1, dt * 10);

    const targetVelocity = kneel ? 0 : direction * MOVE_SPEED;
    const acceleration = kneel ? 2600 : direction === 0 ? 1100 : 1500;
    local.vx = approach(local.vx, targetVelocity, acceleration * dt);
    local.x = clampX(local.x + local.vx * dt);

    if (input.jump && local.onGround && !kneel && local.kneel < 0.2) {
      local.vy = -JUMP_SPEED;
      local.onGround = false;
    }
    const wasOnGround = local.onGround;
    local.vy += GRAVITY * dt;
    local.y += local.vy * dt;
    let landingSpeed = 0;
    if (local.y >= 0) {
      local.y = 0;
      landingSpeed = local.vy;
      local.vy = 0;
      local.onGround = true;
    }
    if (!wasOnGround && local.onGround) {
      avatar.squashVelocity = Math.min(Math.max(landingSpeed - 180, 0) / 100, 4.6);
    }

    avatar.vx = local.vx;
    avatar.vy = local.vy;
    avatar.onGround = local.onGround;
    avatar.kneel = local.kneel;
    Entity.updateEntityMotion(avatar, dt);
    avatar.x = local.x;
    avatar.y = stageYFromPhysics(local.y, avatar);
  }

  // 进房出生：把服务端 nx 映到当前屏宽，只执行一次。
  function applySpawnFromServer(serverPlayer) {
    local.x = clampX(nxToX(serverPlayer.nx ?? 0.5));
    local.y = Math.min(0, serverPlayer.y ?? 0);
    local.vx = serverPlayer.vx ?? 0;
    local.vy = serverPlayer.vy ?? 0;
    local.onGround = Boolean(serverPlayer.onGround ?? true);
    local.kneel = serverPlayer.kneel ?? 0;
    avatar.x = local.x;
    avatar.y = stageYFromPhysics(local.y, avatar);
    avatar.facing = serverPlayer.facing || avatar.facing;
  }

  function ensureRemote(playerId, snapshot) {
    let remote = remotePlayers.get(playerId);
    if (!remote) {
      remote = Entity.createAvatarEntity({
        id: playerId,
        nickname: snapshot.nickname || '玩家',
        x: nxToX(snapshot.nx ?? 0.5),
      });
      remote.y = stageYFromPhysics(snapshot.y ?? 0, remote);
      remotePlayers.set(playerId, remote);
    }
    return remote;
  }

  function applyRemoteSample(remote, sample) {
    remote.nickname = sample.nickname || remote.nickname;
    remote.x = nxToX(sample.nx);
    remote.y = stageYFromPhysics(sample.y ?? 0, remote);
    remote.vx = sample.vx;
    remote.vy = sample.vy;
    remote.facing = sample.facing || remote.facing;
    remote.onGround = Boolean(sample.onGround);
    remote.moveDirection = Math.sign(sample.vx) || 0;
    remote.kneel = sample.kneel ?? remote.kneel;
  }

  function handleWorldSnapshot(payload) {
    const now = performance.now();
    const players = Array.isArray(payload.players) ? payload.players : [];
    const seen = new Set();

    const serverMs = (payload.serverTick || 0) * SERVER_TICK_MS;
    const offset = now - serverMs;
    if (clockOffsetMs === null || Math.abs(offset - clockOffsetMs) > 1000) {
      clockOffsetMs = offset;
    } else {
      clockOffsetMs += (offset - clockOffsetMs) * 0.1;
    }

    for (const player of players) {
      if (!player?.id) continue;
      if (isLocalId(player.id)) {
        if (needsSpawnSync && player.connected) {
          applySpawnFromServer(player);
          needsSpawnSync = false;
          syncedRoomId = payload.roomId || syncedRoomId;
        }
        continue;
      }
      // 断线 grace：connected=false 仍计入 seen，避免误删。
      seen.add(String(player.id));
      if (!player.connected) continue;
      const remote = ensureRemote(String(player.id), player);
      Entity.pushSnapshot(remote, player, serverMs);
      if (player.appearance) Entity.loadAppearance(remote, player.appearance);
      remote.nickname = player.nickname || remote.nickname;
    }

    for (const id of [...remotePlayers.keys()]) {
      if (!seen.has(id)) remotePlayers.delete(id);
    }
  }

  networkSession.addEventListener('worldsnapshot', (event) => {
    handleWorldSnapshot(event.detail || {});
  });

  networkSession.addEventListener('playerleave', (event) => {
    const playerId = event.detail?.playerId;
    if (playerId && event.detail?.temporary !== true) {
      remotePlayers.delete(String(playerId));
    }
  });

  networkSession.addEventListener('appearance', (event) => {
    const detail = event.detail || {};
    if (!detail.playerId || isLocalId(detail.playerId)) return;
    const remote = remotePlayers.get(String(detail.playerId));
    if (remote) Entity.loadAppearance(remote, detail.appearance);
  });

  networkSession.addEventListener('roomchange', (event) => {
    remotePlayers.clear();
    clockOffsetMs = null;
    const roomId = event.detail?.roomId;
    // 换房才重新对齐出生点；同房重复 room_joined 不硬拉位置。
    if (roomId !== syncedRoomId) {
      needsSpawnSync = true;
      syncedRoomId = roomId ?? null;
    }
  });

  // 切后台只清输入，不把本地坐标拉回服务端（否则切回必瞬移）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (!isOfflineSession) {
        sendNetworkInput({ direction: 0, jump: false, kneel: false });
      }
    } else {
      networkAccumulator = 0;
    }
  });

  function sendNetworkInput(input) {
    networkSession.sendInput({
      sequence: inputSequence,
      direction: input.direction,
      jump: input.jump,
      kneel: input.kneel,
    });
    inputSequence += 1;
  }

  function updateRemotes(dt, now) {
    if (clockOffsetMs === null) return;
    const renderMs = now - clockOffsetMs - INTERP_DELAY_MS;
    for (const remote of remotePlayers.values()) {
      const sample = Entity.sampleRemote(remote, renderMs);
      if (sample) applyRemoteSample(remote, sample);
      Entity.updateEntityMotion(remote, dt);
    }
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const view = computeCameraTransform();
    ctx.setTransform(
      view.zoom * dpr, 0, 0, view.zoom * dpr,
      view.offsetX * dpr, view.offsetY * dpr
    );

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-viewW, groundY + AVATAR_SIZE / 2);
    ctx.lineTo(viewW * 2, groundY + AVATAR_SIZE / 2);
    ctx.stroke();

    for (const remote of remotePlayers.values()) {
      Entity.drawAvatar(ctx, remote, view, dpr);
      ctx.setTransform(
        view.zoom * dpr, 0, 0, view.zoom * dpr,
        view.offsetX * dpr, view.offsetY * dpr
      );
    }
    Entity.drawAvatar(ctx, avatar, view, dpr);
  }

  const MAX_INPUTS_PER_FRAME = 5;

  let lastTime = performance.now();
  function frame(now) {
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const input = readInputFrame();
    updateLocal(dt, input);
    if (!isOfflineSession) {
      networkAccumulator += dt;
      let sent = 0;
      while (networkAccumulator >= networkStep && sent < MAX_INPUTS_PER_FRAME) {
        sendNetworkInput(input);
        networkAccumulator -= networkStep;
        sent += 1;
      }
      if (sent === MAX_INPUTS_PER_FRAME) networkAccumulator = 0;
    }
    updateRemotes(dt, now);
    updateCamera(dt);
    draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- 皮套管理 ----

  const uploadForm = document.getElementById('skinUploadForm');
  const fileInput = document.getElementById('skinFileInput');
  const nameInput = document.getElementById('skinNameInput');
  const statusLabel = document.getElementById('skinUploadStatus');
  const skinList = document.getElementById('skinList');
  let activeSkinId = null;
  let wornSkinId = null;
  let pendingDeleteId = null;
  let pendingDeleteTimer = null;
  let cachedSkins = [];

  function setStatus(text, isError = false) {
    statusLabel.textContent = text;
    statusLabel.classList.toggle('is-error', isError);
  }

  function textureUrl(skin) {
    const v = skin.content_hash || skin.created_at || '';
    return `/avatar-lobby/skins/${skin.id}/texture?v=${encodeURIComponent(v)}`;
  }

  function appearanceFromSkin(skin) {
    if (!skin) {
      return {
        skinId: null,
        kind: 'plain',
        heightScale: DEFAULT_AVATAR_HEIGHT_SCALE,
        contentHash: '',
      };
    }
    return {
      skinId: skin.id,
      kind: skin.kind || 'plain',
      heightScale: skin.height_scale ?? DEFAULT_AVATAR_HEIGHT_SCALE,
      contentHash: skin.content_hash || skin.created_at || '',
    };
  }

  function syncAppearance(skinId) {
    const skin = cachedSkins.find((item) => item.id === skinId);
    networkSession.setAppearance(appearanceFromSkin(skin || null));
  }

  function persistWorn(skinId) {
    wornSkinId = skinId;
    fetch(`/avatar-lobby/skins/worn?skin_id=${encodeURIComponent(skinId)}`, {
      method: 'PUT',
    }).catch(() => {});
  }

  function clearPendingDelete() {
    pendingDeleteId = null;
    if (pendingDeleteTimer !== null) {
      clearTimeout(pendingDeleteTimer);
      pendingDeleteTimer = null;
    }
  }

  function applySkin(skinId) {
    const skin = cachedSkins.find((item) => item.id === skinId);
    if (!skin) return;
    Entity.loadAppearance(avatar, appearanceFromSkin(skin)).then(() => {
      activeSkinId = skinId;
      if (skinId !== wornSkinId) persistWorn(skinId);
      syncAppearance(skinId);
      renderSkinButtons();
    });
  }

  async function deleteSkin(skinId) {
    const response = await fetch(`/avatar-lobby/skins/${skinId}`, { method: 'DELETE' });
    if (!response.ok) {
      setStatus('删除失败', true);
      return;
    }
    if (activeSkinId === skinId) {
      activeSkinId = null;
      Entity.loadAppearance(avatar, null);
      syncAppearance(null);
    }
    clearPendingDelete();
    setStatus('已删除皮套');
    await refreshSkins();
  }

  function renderSkinButtons() {
    skinList.replaceChildren(...cachedSkins.map((skin) => {
      const item = document.createElement('li');
      item.classList.add('skin-item');
      const button = document.createElement('button');
      button.type = 'button';
      button.classList.toggle('is-active', skin.id === activeSkinId);
      const thumb = document.createElement('img');
      thumb.src = textureUrl(skin);
      thumb.alt = skin.name;
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      button.append(thumb, document.createTextNode(skin.name));
      button.addEventListener('click', () => applySkin(skin.id));
      item.append(button);
      if (skin.uploader_id !== 'system') {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'skin-delete';
        const confirming = pendingDeleteId === skin.id;
        remove.classList.toggle('is-confirming', confirming);
        remove.title = confirming ? '再次点击确认删除' : '删除皮套';
        remove.textContent = confirming ? '确认？' : '✕';
        remove.addEventListener('click', (event) => {
          event.stopPropagation();
          if (pendingDeleteId === skin.id) {
            deleteSkin(skin.id);
            return;
          }
          clearPendingDelete();
          pendingDeleteId = skin.id;
          pendingDeleteTimer = setTimeout(() => {
            clearPendingDelete();
            renderSkinButtons();
          }, DELETE_CONFIRM_MS);
          renderSkinButtons();
        });
        remove.addEventListener('blur', () => {
          if (pendingDeleteId === skin.id) {
            clearPendingDelete();
            renderSkinButtons();
          }
        });
        item.append(remove);
      }
      return item;
    }));
  }

  async function refreshSkins() {
    const response = await fetch('/avatar-lobby/skins');
    if (!response.ok) {
      setStatus('无法加载皮套列表', true);
      return;
    }
    const payload = await response.json();
    cachedSkins = Array.isArray(payload.skins) ? payload.skins : [];
    wornSkinId = payload.worn || null;
    renderSkinButtons();
    if (activeSkinId === null && wornSkinId
        && cachedSkins.some((skin) => skin.id === wornSkinId)) {
      applySkin(wornSkinId);
    }
  }

  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    setStatus('上传中…');
    const params = new URLSearchParams({ name: nameInput.value || '', kind: 'plain' });
    const response = await fetch(`/avatar-lobby/skins?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setStatus(payload.detail || `上传失败（${response.status}）`, true);
      return;
    }
    const payload = await response.json();
    setStatus(`已上传：${payload.skin.name}`);
    uploadForm.reset();
    await refreshSkins();
    applySkin(payload.skin.id);
  });

  refreshSkins();

  window.StageAvatar = {
    previewUvAtlas(source) {
      avatar.uvAtlas = source;
      avatar.texture = null;
    },
    previewHeightScale(value) {
      avatar.heightScale = value;
    },
    endPreview() {
      if (activeSkinId !== null) {
        applySkin(activeSkinId);
      } else {
        Entity.loadAppearance(avatar, null);
      }
    },
  };

  window.SkinLibrary = {
    refresh: refreshSkins,
    apply: applySkin,
  };

  // 只读调试口：联机平滑度排查用。
  window.AvatarDebug = {
    local: () => ({
      x: local.x,
      y: local.y,
      vx: local.vx,
      needsSpawnSync,
      syncedRoomId,
    }),
    remotes: () =>
      [...remotePlayers.values()].map((r) => ({ id: r.id, x: r.x, y: r.y })),
  };
})();
