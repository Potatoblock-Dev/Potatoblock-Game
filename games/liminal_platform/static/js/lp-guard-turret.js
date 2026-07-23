/**
 * 卫兵防御车厢：双炮塔操控、弹药箱存取、回收箱。
 * 每座单管；轴心在圆球中心；过中垂线纵向镜像；限制下俯角；开火后坐、无抛壳。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Core = window.LpInventoryCore;
  const Catalog = window.LpItemCatalog;

  const AMMO_ID = 'turret_ammo';
  const CASING_ID = 'shell_casing';
  /** 机炮连射间隔（秒）。 */
  const FIRE_COOLDOWN = 0.11;
  const TRACE_RANGE = 980;
  const FLASH_LIFE = 0.13;
  /** 火光相对枪口再向前伸出（世界像素）。 */
  const FLASH_FORWARD = 10;
  /** 开火后坐最大后移（世界像素）。 */
  const RECOIL_MAX_PX = 14;
  /** 后坐回位速度（归一化 0–1 / 秒）。 */
  const RECOIL_RECOVER = 7.5;
  /** 炮塔最大转速（弧度/秒，约 150°/s）。 */
  const TURN_RATE = (150 * Math.PI) / 180;
  const BARREL_URL = '/static/games/liminal-platform/img/guard-barrel.png?v=7';
  const SHOT_SFX = '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1';
  /** 开完一发后的装弹机装填（CC0）。 */
  const FEED_SFX = '/static/games/liminal-platform/audio/weapons/guard-turret-feed.wav?v=1';
  /** 装填音相对枪声的延迟（秒），贴近「打完再进弹」。 */
  const FEED_SFX_DELAY = 0.05;
  /** 闲置：左塔朝左、右塔朝右，炮管伸出车厢外侧便于辨认。 */
  const IDLE_ANGLE = { left: Math.PI, right: 0 };
  /** 相对水平的最大下俯角 / 仰角。 */
  const MAX_DEPRESS = (10 * Math.PI) / 180;
  const MAX_ELEVATE = (82 * Math.PI) / 180;

  /** 贴图像素枢轴：白球质心（由 guard-car.png 采样）。 */
  const ART_PIVOTS = [
    { id: 'left', x: 615, y: 609 },
    { id: 'right', x: 1628, y: 608 },
  ];

  const state = {
    manned: null,
    barrelImg: null,
    barrelReady: false,
    angles: { left: IDLE_ANGLE.left, right: IDLE_ANGLE.right },
    /** 准星目标角；实际朝向在 tick 中按 TURN_RATE 追赶。 */
    targetAngles: { left: IDLE_ANGLE.left, right: IDLE_ANGLE.right },
    /** 各塔后坐量 0–1（1 = 最大后移）。 */
    recoil: { left: 0, right: 0 },
    fireCooldown: 0,
    flashes: [],
    ammoInv: null,
    recycleInv: null,
  };

  /** 读取或新建弹药箱 / 回收箱库存。 */
  function ensureInventories() {
    if (state.ammoInv && state.recycleInv) return;
    const raw = localStorage.getItem('lp-guard-crates-v1');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        state.ammoInv = Core.Inventory.fromJSON(parsed.ammo);
        state.recycleInv = Core.Inventory.fromJSON(parsed.recycle);
        return;
      } catch (_) {
        /* fall through */
      }
    }
    state.ammoInv = new Core.Inventory('guard-ammo', 4, 2, [
      { index: 0, stack: { itemId: AMMO_ID, qty: 60 } },
    ]);
    state.recycleInv = new Core.Inventory('guard-recycle', 3, 2, []);
  }

  /** 持久化弹药箱与回收箱。 */
  function saveCrates() {
    ensureInventories();
    localStorage.setItem(
      'lp-guard-crates-v1',
      JSON.stringify({
        ammo: state.ammoInv.toJSON(),
        recycle: state.recycleInv.toJSON(),
      })
    );
  }

  /** 预加载炮管贴图。 */
  function loadBarrelImage() {
    if (state.barrelReady && state.barrelImg?.naturalWidth > 0) {
      return Promise.resolve(state.barrelImg);
    }
    state.barrelReady = false;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        state.barrelImg = img;
        state.barrelReady = img.naturalWidth > 0;
        resolve(img);
      };
      img.onerror = () => {
        state.barrelReady = false;
        reject(new Error('guard barrel load failed'));
      };
      img.src = BARREL_URL;
    });
  }

  /** 卫兵车厢世界原点。 */
  function guardCar() {
    return Spec?.CARRIAGES?.find((car) => car.id === 'guard') || null;
  }

  /** 贴图像素 → 世界坐标（含车厢偏移）。 */
  function artToWorld(artX, artY) {
    const car = guardCar();
    const scale = Spec?.scaleArt || ((v) => v);
    return {
      x: (car?.worldX ?? 0) + scale(artX),
      y: scale(artY),
    };
  }

  /** 炮管世界尺寸（贴图未就绪时用设计尺寸，保证剪影可见）。 */
  function barrelSizeWorld() {
    const img = state.barrelImg;
    const artW = (img && state.barrelReady && img.naturalWidth) ? img.naturalWidth : 320;
    const artH = (img && state.barrelReady && img.naturalHeight) ? img.naturalHeight : 56;
    const scale = Spec?.scaleArt || ((v) => v);
    return { w: scale(artW), h: scale(artH) };
  }

  /** 无贴图或贴图过暗时的双管剪影（高对比，保证可见）。 */
  function drawBarrelFallback(ctx, bw, bh) {
    const r = Math.max(3, bh * 0.22);
    /* 上管 */
    ctx.fillStyle = '#d4d4d8';
    ctx.beginPath();
    ctx.roundRect(0, -bh * 0.48, bw, bh * 0.4, r);
    ctx.fill();
    ctx.fillStyle = '#a1a1aa';
    ctx.beginPath();
    ctx.roundRect(bw * 0.04, -bh * 0.4, bw * 0.9, bh * 0.24, r * 0.6);
    ctx.fill();
    /* 下管略短 */
    ctx.fillStyle = '#c4c4cc';
    ctx.beginPath();
    ctx.roundRect(0, bh * 0.05, bw * 0.9, bh * 0.4, r);
    ctx.fill();
    ctx.fillStyle = '#909098';
    ctx.beginPath();
    ctx.roundRect(bw * 0.04, bh * 0.13, bw * 0.8, bh * 0.24, r * 0.6);
    ctx.fill();
    /* 根部炮闩 */
    ctx.fillStyle = '#71717a';
    ctx.fillRect(0, -bh * 0.5, Math.max(10, bw * 0.08), bh);
  }

  /** 炮管世界长度。 */
  function barrelLengthWorld() {
    return barrelSizeWorld().w;
  }

  /** 将瞄准角限制在仰角 / 俯角范围内（画布 y 向下为正俯角）。 */
  function clampTurretAngle(raw) {
    let a = Math.atan2(Math.sin(raw), Math.cos(raw));
    const s = Math.sin(a);
    const c = Math.cos(a);
    const maxDown = Math.sin(MAX_DEPRESS);
    const maxUp = Math.sin(MAX_ELEVATE);
    let ns = s;
    if (s > maxDown) ns = maxDown;
    if (s < -maxUp) ns = -maxUp;
    if (ns === s) return a;
    const sign = c >= 0 ? 1 : -1;
    const nc = sign * Math.sqrt(Math.max(0, 1 - ns * ns));
    return Math.atan2(ns, nc);
  }

  /** 最短有符号角差（−π…π）。 */
  function angleDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  /**
   * 转向角差：优先不穿过下俯极限（左右大角度回转走仰角一侧）。
   */
  function turnDelta(from, to) {
    let d = angleDelta(from, to);
    const midSin = Math.sin(from + d * 0.5);
    if (midSin > Math.sin(MAX_DEPRESS) * 0.35) {
      d = d > 0 ? d - Math.PI * 2 : d + Math.PI * 2;
    }
    return d;
  }

  /** 按转速把当前角推向目标角。 */
  function slewAngle(current, target, dt) {
    const tgt = clampTurretAngle(target);
    const d = turnDelta(current, tgt);
    const maxStep = TURN_RATE * Math.max(0, dt);
    if (Math.abs(d) <= maxStep) return tgt;

    const curC = Math.cos(current);
    const tgtC = Math.cos(tgt);
    const apexSin = -Math.sin(MAX_ELEVATE);
    const atApex = Math.sin(current) <= apexSin + 1e-3;

    /* 左右半球切换时，仰到极限后整步翻面，避免卡在天顶。 */
    if (curC * tgtC < 0 && atApex) {
      const side = tgtC >= 0 ? 1 : -1;
      return Math.atan2(apexSin, side * Math.sqrt(Math.max(0, 1 - apexSin * apexSin)));
    }

    return clampTurretAngle(current + Math.sign(d) * maxStep);
  }

  /** 弹药箱剩余数量。 */
  function ammoCount() {
    ensureInventories();
    return state.ammoInv.countItem(AMMO_ID);
  }

  /** 回收箱弹壳数量。 */
  function casingCount() {
    ensureInventories();
    return state.recycleInv.countItem(CASING_ID);
  }

  /** 是否正在操控炮塔。 */
  function isManned() {
    return Boolean(state.manned);
  }

  /** 当前操控的炮塔 id。 */
  function getMannedId() {
    return state.manned;
  }

  /** 进入炮塔。 */
  function enterTurret(turretId) {
    state.manned = turretId === 'right' ? 'right' : 'left';
    document.body.classList.add('lp-turret-mode');
    window.LpSfx?.preload?.([SHOT_SFX, FEED_SFX]);
    window.LiminalInteract?.showToast?.(
      state.manned === 'left' ? '进入左侧炮塔' : '进入右侧炮塔'
    );
    window.dispatchEvent(
      new CustomEvent('lp:turret-enter', { detail: { turretId: state.manned } })
    );
  }

  /** 离席：炮管回到外侧闲置朝向。 */
  function exitTurret() {
    if (!state.manned) return;
    state.manned = null;
    state.angles.left = IDLE_ANGLE.left;
    state.angles.right = IDLE_ANGLE.right;
    state.targetAngles.left = IDLE_ANGLE.left;
    state.targetAngles.right = IDLE_ANGLE.right;
    document.body.classList.remove('lp-turret-mode');
    window.LiminalInteract?.showToast?.('离开炮塔');
    window.dispatchEvent(new CustomEvent('lp:turret-exit'));
  }

  /** 炮塔交互入口（F）。已在塔内则离席。 */
  function interactTurret(turretId) {
    if (state.manned) {
      exitTurret();
      return true;
    }
    enterTurret(turretId);
    return true;
  }

  /** 物品 id：弹药箱 / 回收箱。 */
  function itemIdForMode(mode) {
    return mode === 'recycle' ? CASING_ID : AMMO_ID;
  }

  /** 对应箱子库存。 */
  function invForMode(mode) {
    ensureInventories();
    return mode === 'recycle' ? state.recycleInv : state.ammoInv;
  }

  /** 玩家 → 箱子。返回实际存入数量。 */
  function depositItem(mode, qty) {
    const itemId = itemIdForMode(mode);
    const inv = invForMode(mode);
    const take = Math.max(0, Math.floor(qty));
    if (take <= 0) return 0;
    const taken = window.LpInventory?.consumeItem?.(itemId, take) ?? 0;
    if (taken <= 0) return 0;
    const leftover = inv.addItem(itemId, taken);
    if (leftover > 0) {
      window.LpInventory?.getPlayerInventory?.()?.addItem?.(itemId, leftover);
    }
    saveCrates();
    return taken - leftover;
  }

  /** 箱子 → 玩家背包。返回实际取出数量。 */
  function withdrawItem(mode, qty) {
    const itemId = itemIdForMode(mode);
    const inv = invForMode(mode);
    const want = Math.max(0, Math.floor(qty));
    if (want <= 0) return 0;
    const removed = inv.removeItem(itemId, want);
    if (removed <= 0) return 0;
    const leftover =
      window.LpInventory?.getPlayerInventory?.()?.addItem?.(itemId, removed) ?? removed;
    if (leftover > 0) inv.addItem(itemId, leftover);
    saveCrates();
    return removed - (leftover || 0);
  }

  /** 弹药箱 F：打开存取面板。 */
  function interactAmmoBox() {
    if (state.manned) {
      exitTurret();
      return true;
    }
    if (window.LpGuardCrateUi?.isOpen?.()) {
      window.LpGuardCrateUi.close();
      return true;
    }
    window.LpGuardCrateUi?.openAmmo?.();
    return true;
  }

  /** 回收箱 F：打开存取面板。 */
  function interactRecycleBox() {
    if (state.manned) {
      exitTurret();
      return true;
    }
    if (window.LpGuardCrateUi?.isOpen?.()) {
      window.LpGuardCrateUi.close();
      return true;
    }
    window.LpGuardCrateUi?.openRecycle?.();
    return true;
  }

  /** 从弹药箱消耗一发。 */
  function consumeCrateAmmo(qty = 1) {
    ensureInventories();
    return state.ammoInv.removeItem(AMMO_ID, qty);
  }

  /** 当前后坐后移距离（世界像素）。 */
  function recoilPx(pivotId) {
    return (state.recoil[pivotId] || 0) * RECOIL_MAX_PX;
  }

  /** 开火瞬间拉满后坐。 */
  function kickRecoil(pivotId) {
    state.recoil[pivotId] = 1;
  }

  /** 某塔单管枪口世界坐标（含后坐后移）。 */
  function muzzlePoint(pivotId) {
    const pivot = ART_PIVOTS.find((p) => p.id === pivotId);
    if (!pivot) return null;
    const world = artToWorld(pivot.x, pivot.y);
    const angle = state.angles[pivotId];
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const kick = recoilPx(pivotId);
    const len = barrelLengthWorld();
    return {
      x: world.x + dirX * (len - kick),
      y: world.y + dirY * (len - kick),
      dirX,
      dirY,
      angle,
    };
  }

  /** 两座炮塔枪口。 */
  function allMuzzlePoints() {
    return ART_PIVOTS.map((p) => muzzlePoint(p.id)).filter(Boolean);
  }

  /** 生成炮口火光（略伸出枪口，便于看见）。 */
  function spawnMuzzleFlash(muzzle) {
    state.flashes.push({
      x: muzzle.x + muzzle.dirX * FLASH_FORWARD,
      y: muzzle.y + muzzle.dirY * FLASH_FORWARD,
      angle: muzzle.angle,
      life: FLASH_LIFE,
      maxLife: FLASH_LIFE,
      jitter: Math.random() * Math.PI,
    });
  }

  /** 生成炮塔飞行炮弹实体。 */
  function spawnTurretTracer(muzzle) {
    window.LpCombat?.spawnProjectile?.({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: muzzle.dirX,
      dirY: muzzle.dirY,
      range: TRACE_RANGE,
      weaponId: 'guard_turret',
      style: 'shell',
      facing: muzzle.dirX >= 0 ? 1 : -1,
      flash: false,
    });
  }

  /** 按准星更新双塔目标朝向（实际旋转在 tick 中限速追赶）。 */
  function aimBoth(aimX, aimY) {
    for (const pivot of ART_PIVOTS) {
      const world = artToWorld(pivot.x, pivot.y);
      state.targetAngles[pivot.id] = clampTurretAngle(
        Math.atan2(aimY - world.y, aimX - world.x)
      );
    }
  }

  /**
   * 炮塔开火：耗弹 1，双塔联射（各一管后坐 + 炮弹 + 火光）。
   */
  function tryFire(aimX, aimY) {
    if (!state.manned || state.fireCooldown > 0) return null;
    if (ammoCount() <= 0) {
      window.LiminalInteract?.showToast?.('弹药箱没有弹药');
      state.fireCooldown = 0.35;
      return null;
    }
    const spent = consumeCrateAmmo(1);
    if (spent <= 0) return null;
    saveCrates();
    aimBoth(aimX, aimY);
    state.fireCooldown = FIRE_COOLDOWN;

    for (const pivot of ART_PIVOTS) {
      kickRecoil(pivot.id);
    }

    const muzzles = allMuzzlePoints();
    for (const muzzle of muzzles) {
      spawnTurretTracer(muzzle);
      spawnMuzzleFlash(muzzle);
    }

    window.LpSfx?.play?.(SHOT_SFX, {
      volume: 0.45,
      rateJitter: 0.06,
      playbackRate: 0.82,
    });
    window.setTimeout(() => {
      window.LpSfx?.play?.(FEED_SFX, {
        volume: 0.55,
        rateJitter: 0.03,
        playbackRate: 1,
      });
    }, Math.round(FEED_SFX_DELAY * 1000));

    const mannedMuzzle = muzzlePoint(state.manned) || muzzles[0];
    window.dispatchEvent(
      new CustomEvent('lp:weapon-fired', {
        detail: {
          weaponId: 'guard_turret',
          originX: mannedMuzzle?.x,
          originY: mannedMuzzle?.y,
          dirX: mannedMuzzle?.dirX,
          dirY: mannedMuzzle?.dirY,
          turret: true,
        },
      })
    );
    return mannedMuzzle || null;
  }

  /** 推进转向、冷却、后坐回位与火光。 */
  function tick(dt) {
    for (const pivot of ART_PIVOTS) {
      const id = pivot.id;
      state.angles[id] = slewAngle(state.angles[id], state.targetAngles[id], dt);
      if (state.recoil[id] > 0) {
        state.recoil[id] = Math.max(0, state.recoil[id] - RECOIL_RECOVER * dt);
      }
    }
    if (state.fireCooldown > 0) {
      state.fireCooldown = Math.max(0, state.fireCooldown - dt);
    }
    for (let i = state.flashes.length - 1; i >= 0; i -= 1) {
      state.flashes[i].life -= dt;
      if (state.flashes[i].life <= 0) state.flashes.splice(i, 1);
    }
  }

  /** 绘制单管炮管（从球壳外缘伸出；后坐；过中垂线纵向镜像）。 */
  function drawBarrels(ctx) {
    const { w: bw, h: bh } = barrelSizeWorld();
    const img = state.barrelImg;
    const useImg = Boolean(img && state.barrelReady && img.naturalWidth > 0);
    /* 白球半径约 110 贴图像素，炮管从球缘外开始画，避免埋在球体里看不见 */
    const protrude = Math.min(bw * 0.38, (Spec?.scaleArt?.(105) ?? 105));
    const drawLen = Math.max(bw * 0.45, bw - protrude);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const pivot of ART_PIVOTS) {
      const world = artToWorld(pivot.x, pivot.y);
      const angle = state.angles[pivot.id];
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const kick = recoilPx(pivot.id);
      const flipY = c < 0;
      const ox = world.x + c * (protrude - kick);
      const oy = world.y + s * (protrude - kick);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(angle);
      if (flipY) ctx.scale(1, -1);
      drawBarrelFallback(ctx, drawLen, bh);
      if (useImg) {
        ctx.globalAlpha = 0.95;
        ctx.drawImage(img, 0, -bh / 2, drawLen, bh);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }
    ctx.restore();
  }

  /** 绘制炮口火光（亮核 + 橙晕 + 十字焰舌）。 */
  function drawFlashes(ctx) {
    for (const flash of state.flashes) {
      const t = Math.max(0, flash.life / flash.maxLife);
      const fade = t * t;
      const r = 18 + (1 - t) * 22;
      ctx.save();
      ctx.translate(flash.x, flash.y);
      ctx.rotate(flash.angle);
      ctx.globalCompositeOperation = 'lighter';

      const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 1.35);
      bloom.addColorStop(0, `rgba(255, 252, 230, ${0.95 * fade})`);
      bloom.addColorStop(0.25, `rgba(255, 200, 80, ${0.85 * fade})`);
      bloom.addColorStop(0.55, `rgba(251, 120, 30, ${0.55 * fade})`);
      bloom.addColorStop(1, 'rgba(180, 40, 0, 0)');
      ctx.fillStyle = bloom;
      ctx.beginPath();
      ctx.ellipse(r * 0.2, 0, r * 1.35, r * 0.85, 0, 0, Math.PI * 2);
      ctx.fill();

      /* 焰舌：前伸 + 上下叉 */
      ctx.rotate(flash.jitter * 0.08);
      ctx.fillStyle = `rgba(255, 245, 200, ${0.9 * fade})`;
      ctx.beginPath();
      ctx.moveTo(-2, 0);
      ctx.lineTo(r * 1.55, -r * 0.22);
      ctx.lineTo(r * 1.15, 0);
      ctx.lineTo(r * 1.55, r * 0.22);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `rgba(255, 180, 60, ${0.75 * fade})`;
      ctx.beginPath();
      ctx.moveTo(0, -2);
      ctx.lineTo(r * 0.55, -r * 0.95);
      ctx.lineTo(r * 0.35, 0);
      ctx.lineTo(r * 0.55, r * 0.95);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = `rgba(255, 255, 245, ${0.95 * fade})`;
      ctx.beginPath();
      ctx.ellipse(2, 0, 7 + 4 * t, 4.5 + 2 * t, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.restore();
    }
  }

  /** 在世界层绘制炮管与火光（炮弹由 LpCombat 绘制）。 */
  function draw(ctx) {
    if (!guardCar()) return;
    drawBarrels(ctx);
    drawFlashes(ctx);
  }

  /** 准星镜头领先系数（进塔后更大，尤其配合纵向仰射）。 */
  function getAimLeadScale() {
    return state.manned ? 1.85 : 1;
  }

  ensureInventories();
  loadBarrelImage().catch((err) => console.warn('[lp-guard]', err));

  window.LpGuardTurret = {
    loadBarrelImage,
    isManned,
    getMannedId,
    enterTurret,
    exitTurret,
    interactTurret,
    interactAmmoBox,
    interactRecycleBox,
    depositItem,
    withdrawItem,
    aimBoth,
    tryFire,
    tick,
    draw,
    getAimLeadScale,
    ammoCount,
    casingCount,
    getAngles: () => ({ ...state.angles }),
    getTargetAngles: () => ({ ...state.targetAngles }),
    getPivotsWorld: () =>
      ART_PIVOTS.map((p) => ({ id: p.id, ...artToWorld(p.x, p.y) })),
    TURN_RATE,
    AMMO_ID,
    CASING_ID,
  };
})();
