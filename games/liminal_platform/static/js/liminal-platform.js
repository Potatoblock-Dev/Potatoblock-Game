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
    x: (platforms[0].left + platforms[0].right) / 2,
    y: 0,
    vx: 0,
    vy: 0,
    onGround: true,
    kneel: 0,
  };

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

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)');

  /** 读取触控输入（移动端）。 */
  function readTouchInput() {
    return (
      window.LpTouchControls?.read() || {
        direction: 0,
        jump: false,
        interact: false,
        fire: false,
        look: { x: 0, y: 0, active: false, ready: false },
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

  /** 是否有全屏 UI（物品栏 / 锅炉控制台 / 加燃料）。 */
  function isUiOpen() {
    return (
      (window.LpInventory?.isOpen() ?? false) ||
      (window.LpBoilerPanel?.isOpen() ?? false) ||
      (window.LpFuelFeed?.isOpen() ?? false)
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

  /** 同步准星显示与系统光标。 */
  function syncAimCursor() {
    const aim = isAimCameraMode() && pointer.known;
    document.body.classList.toggle('lp-aim-mode', !isCoarsePointer() && !isUiOpen());
    if (!crosshairEl) return;
    crosshairEl.hidden = !aim;
    if (aim) {
      crosshairEl.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
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

  /** 移动端：由瞄准摇杆驱动虚拟准星（松手保持方向）。 */
  function syncTouchAimPointer() {
    if (!isCoarsePointer() || isUiOpen()) return;
    const look =
      window.LpTouchControls?.getLook?.() || {
        x: 0,
        y: 0,
        ready: false,
      };
    const view = provisionalCameraView();
    const aimAnchorY = avatar.y - 56;
    const playerScreen = worldToScreen(local.x, aimAnchorY, view);
    const maxLead = Math.min(viewW, viewH) * 0.42;
    if (look.ready) {
      pointer.x = playerScreen.x + look.x * maxLead;
      pointer.y = playerScreen.y + look.y * maxLead * 0.9;
    } else {
      const facing = avatar.facing >= 0 ? 1 : -1;
      pointer.x = playerScreen.x + facing * maxLead * 0.55;
      pointer.y = playerScreen.y - maxLead * 0.06;
    }
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

  /** 枪口大概位置（胸部高度）。 */
  function getMuzzleWorld() {
    const facing = avatar.facing >= 0 ? 1 : -1;
    return {
      x: local.x + facing * 22,
      y: avatar.y - 58,
    };
  }

  /** 向当前瞄准方向开火（步枪占位）。 */
  function requestFire() {
    if (isUiOpen() || !window.LpCombat) return;
    const aim = getAimWorld();
    const muzzle = getMuzzleWorld();
    window.LpCombat.tryFire({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: aim.x - muzzle.x,
      dirY: aim.y - muzzle.y,
      facing: avatar.facing,
    });
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

  /** 脚底相对当前平台顶边的世界 Y → avatar 绘制锚点。 */
  function stageYFromPhysics(physicsY, entity = avatar, atX = local.x) {
    const floorY = floorAt(atX) ?? Spec.FLOOR_Y;
    return floorY + physicsY - Entity.footGroundLiftPx(entity);
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
    const maxLeadX = (viewW * 0.36) / zoom;
    const maxLeadY = (viewH * 0.26) / zoom;
    return {
      x: Math.max(local.x - maxLeadX, Math.min(local.x + maxLeadX, targetX)),
      y: Math.max(Spec.FLOOR_Y - maxLeadY, Math.min(Spec.FLOOR_Y + maxLeadY, targetY)),
    };
  }

  /**
   * 世界坐标相机。
   * 桌面：焦点偏向鼠标准星；移动端：偏向瞄准摇杆虚拟准星。
   * UI / 加燃料打开时回到人物并保持放大。
   */
  function cameraView() {
    if (isUiOpen() || !pointer.known) {
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

  /** 每帧平滑更新镜头焦点与加燃料放大。 */
  function stepCamera(dt) {
    const feedOpen = window.LpFuelFeed?.isOpen?.() ?? false;
    const wantMul = feedOpen ? 1.72 : 1;
    feedZoomMul += (wantMul - feedZoomMul) * (1 - Math.exp(-5.8 * dt));
    zoom = baseZoom * feedZoomMul;

    let targetX = local.x;
    let targetY = Spec.FLOOR_Y;
    if (feedOpen) {
      /* 略抬高焦点，对准站立角色躯干 */
      targetY = Spec.FLOOR_Y - 70;
    } else if (isAimCameraMode() && pointer.known) {
      const provisional = {
        zoom,
        offsetX: viewW * 0.5 - camFocus.x * zoom,
        offsetY: viewH * 0.5 - camFocus.y * zoom,
      };
      const world = screenToWorld(pointer.x, pointer.y, provisional);
      targetX = local.x * (1 - LOOK_WEIGHT) + world.x * LOOK_WEIGHT;
      targetY = Spec.FLOOR_Y * (1 - LOOK_WEIGHT_Y) + world.y * LOOK_WEIGHT_Y;
      const clamped = clampLookLead(targetX, targetY);
      targetX = clamped.x;
      targetY = clamped.y;
    }

    const t = 1 - Math.exp(-CAM_SMOOTH * dt);
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

  /** 积分玩家运动；y 为相对平台顶边的物理高度（地面 0，腾空为负）。 */
  function stepPhysics(dt) {
    if (isUiOpen()) {
      local.vx = 0;
      avatar.gait = 'walk';
      syncAvatarPose();
      return;
    }

    const touch = readTouchInput();
    let direction = touch.direction;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) direction = -1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) direction = 1;

    if (direction !== 0) avatar.facing = direction;
    avatar.moveDirection = direction;

    // 瞄准时朝向跟随准星（可边走边看）
    if (isAimCameraMode() && pointer.known) {
      const world = screenToWorld(pointer.x, pointer.y, provisionalCameraView());
      if (Math.abs(world.x - local.x) > 12) {
        avatar.facing = world.x < local.x ? -1 : 1;
      }
    }

    const autoRun = window.LpInputBindings?.getAutoRun?.() ?? false;
    let wantRun = false;
    if (direction !== 0) {
      if (isCoarsePointer()) {
        wantRun = Boolean(touch.sprintToggle);
      } else {
        const holdSprint = window.LpInputBindings?.isPressed('sprint', keys) ?? false;
        wantRun = autoRun ? !holdSprint : holdSprint;
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
    window.LiminalSession?.maybeSendPose?.({
      x: local.x,
      y: local.y,
      vx: local.vx,
      vy: local.vy,
      facing: avatar.facing,
      onGround: local.onGround,
      gait: avatar.gait,
      headLook: avatar.headLook,
    });

    const wantFire =
      touch.fire ||
      window.LpTouchControls?.isFireHeld?.() ||
      desktopFireHeld ||
      window.LpInputBindings?.isPressed('fire', keys);
    if (wantFire) requestFire();

    const activeSpot = window.LiminalInteract?.findActive(local) || null;
    window.LpTouchControls?.setInteractVisible(Boolean(activeSpot), activeSpot?.actionLabel);
    const inStorage =
      !isUiOpen() &&
      window.LiminalCarriageSpec?.carriageAt?.(local.x)?.id === 'storage';
    window.LpTouchControls?.setStorageHint?.(inStorage);
  }

  /** 绘制单节车厢（世界坐标）。 */
  function drawCarriage(car) {
    const img = carImages.get(car.id);
    if (!img) return;
    ctx.drawImage(img, car.worldX, 0, Spec.MODULE_W, Spec.MODULE_H);
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

    for (const car of Spec.CARRIAGES) drawCarriage(car);
    window.LiminalSession?.drawRemotes?.(ctx, view, dpr);
    Entity.drawAvatar(ctx, avatar, view, dpr);
    window.LpCombat?.draw(ctx);

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
    window.LiminalSession?.tickRemotes?.(dt, remoteStageY);
    window.LpTrainDrive?.tick(dt);
    window.LpCombat?.tick(dt);
    stepCamera(dt);
    syncAimCursor();
    updateLocalHeadLook(dt);
    window.LpBoilerPanel?.syncFromState?.();
    window.LpTrainAudio?.tick(dt);
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
    requestAnimationFrame(frame);
  }

  /** 首次按键/触控时解锁音频，并开启列车行驶环境音。 */
  function bindAudioUnlock() {
    const unlockOnce = () => {
      window.LpTrainAudio?.unlock()
        .then(() => window.LpTrainAudio?.setAmbient(true))
        .catch(() => {});
      window.removeEventListener('pointerdown', unlockOnce);
      window.removeEventListener('keydown', unlockOnce);
    };
    window.addEventListener('pointerdown', unlockOnce, { passive: true });
    window.addEventListener('keydown', unlockOnce);
  }

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    keys.add(event.code);

    if (window.LpInputBindings?.matchesKeyEvent('inventory', event)) {
      event.preventDefault();
      if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
      if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
      window.LpInventory?.toggle(local.x);
      return;
    }

    if (isUiOpen()) {
      if (event.code === 'Escape') {
        if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
        else if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
        else window.LpInventory?.close();
      }
      return;
    }

    if (window.LpInputBindings?.matchesKeyEvent('interact', event)) {
      window.LiminalInteract?.tryInteract(local);
    }
    if (window.LpInputBindings?.matchesKeyEvent('fire', event)) {
      event.preventDefault();
      requestFire();
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
    if (isCoarsePointer() || isUiOpen()) return;
    if (event.button !== 0) return;
    desktopFireHeld = true;
    requestFire();
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
      loadWornAppearance().then(syncAvatarPose);
    } else {
      window.LpTrainAudio?.suspend();
    }
  });

  bindAudioUnlock();
  window.LiminalSession?.start?.({ userId, nickname });
  window.addEventListener('lp:interact', () => {
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
