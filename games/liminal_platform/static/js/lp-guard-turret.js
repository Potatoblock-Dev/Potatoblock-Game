/**
 * 卫兵防御车厢：双炮塔操控、弹药箱存取、回收箱。
 * 炮管贴图 guard-barrel.png（整图，不从车厢裁）；枢轴=白球心；
 * 瞄准角 atan2；过中垂线纵向镜像保贴图朝上；
 * 各塔射界=外侧近水平 → 经天顶 → 对侧高仰（图2 交叉覆盖），禁止浅角打进甲板/货箱/友穹；
 * 多人：座位决定控哪塔；仅 1 名操作员时可双联；联机经 pose.turretId 同步占用与瞄准。
 * 开火后坐、无抛壳。
 */
(() => {
  const Core = window.LpInventoryCore;
  const Catalog = window.LpItemCatalog;
  /** 与 carriage-spec.WORLD_SCALE 对齐；Spec 未就绪时仍按此缩放，避免炮管相对车厢错位变大。 */
  const WORLD_SCALE_FALLBACK = 0.88;

  const AMMO_ID = 'turret_ammo';
  const CASING_ID = 'shell_casing';
  /** 机炮连射间隔（秒）；入座后长按连发（full-auto）。略降射速。 */
  const FIRE_COOLDOWN = 0.14;
  /** 炮弹射程由 LpCombat PROJECTILE_STYLE.shell.maxRange 决定（勿在此缩短）。 */
  const FLASH_LIFE = 0.13;
  /** 火光相对枪口再向前伸出（世界像素）。 */
  const FLASH_FORWARD = 10;
  /** 开火后坐最大后移（世界像素）。 */
  const RECOIL_MAX_PX = 14;
  /** 后坐回位速度（归一化 0–1 / 秒）。 */
  const RECOIL_RECOVER = 7.5;
  /** 炮塔最大转速（弧度/秒，约 150°/s）。 */
  const TURN_RATE = (150 * Math.PI) / 180;
  /**
   * 开火角容差：炮管当前角与准星钳制目标角差须 ≤ 此值才允许开火。
   * 约 4°——跟上瞄准后可连发，回转滞后时不开火。
   */
  const AIM_FIRE_TOLERANCE = (4 * Math.PI) / 180;
  /** 独立炮管贴图（炮口朝 +X；整图绘制，禁止从 guard-car 裁切）。 */
  const BARREL_URL = '/static/games/liminal-platform/img/cars/guard-barrel.png?v=12';
  const SHOT_SFX = '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1';
  /** 开完一发后的装弹机装填（CC0）。 */
  const FEED_SFX = '/static/games/liminal-platform/audio/weapons/guard-turret-feed.wav?v=1';
  /** 装填音相对枪声的延迟（秒），贴近「打完再进弹」。 */
  const FEED_SFX_DELAY = 0.05;
  /**
   * 闲置朝向：各塔朝车厢外侧（左塔← / 右塔→），避免闲置炮管指向货箱或友塔。
   */
  const IDLE_ANGLE = { left: Math.PI, right: 0 };
  /**
   * 外侧下俯：仅允许略低于水平（图2 红线贴水平外向）；过大则打进甲板。
   */
  const MAX_DEPRESS = (8 * Math.PI) / 180;
  /**
   * 越过天顶后仍允许的内侧仰角余量（相对 −90°）。
   * 图2：左塔上右、右塔上左交叉于车厢中线上方；约 35° 形成大重叠楔且避开浅角友穹。
   */
  const PAST_ZENITH = (35 * Math.PI) / 180;
  /**
   * 各塔射界端点（画布 atan2：0=右，−π/2=上，π=左，+π/2=下）。
   * ARC_IN：越过天顶后的内侧高仰端；ARC_OUT：外侧近水平（含轻微下俯）。
   * left：≈ −55° → 经天顶/−π → ≈172°；right：≈ −125° → 经天顶 → ≈8°。
   * 禁止再锁「纯外侧半球」(cos≤0 / cos≥0)，否则挡掉图2 的对空交叉。
   */
  const ARC_IN = {
    left: -Math.PI / 2 + PAST_ZENITH,
    right: -Math.PI / 2 - PAST_ZENITH,
  };
  const ARC_OUT = {
    left: Math.PI - MAX_DEPRESS,
    right: MAX_DEPRESS,
  };
  /**
   * 贴图未就绪时的设计尺寸（与 guard-barrel.png 303×43 对齐）。
   * 仅占位；正式绘制用 naturalWidth/Height。
   */
  const ART_BARREL_FALLBACK_W = 303;
  const ART_BARREL_FALLBACK_H = 43;

  /** 贴图像素枢轴：白球质心（由 cars/guard-car.png 白团质心采样）。 */
  const ART_PIVOTS = [
    { id: 'left', x: 615, y: 609 },
    { id: 'right', x: 1628, y: 608 },
  ];

  const state = {
    manned: null,
    /**
     * 远端入座：turretId → playerId。
     * 与本地 manned 一起决定单人双控 / 多人分塔。
     */
    remoteClaims: { left: null, right: null },
    /** 远端准星（世界坐标）；仅驱动非本机控制的炮管。 */
    remoteAims: { left: null, right: null },
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
    if (window.LpInventoryNet?.isActive?.()) return;
    ensureInventories();
    localStorage.setItem(
      'lp-guard-crates-v1',
      JSON.stringify({
        ammo: state.ammoInv.toJSON(),
        recycle: state.recycleInv.toJSON(),
      })
    );
  }

  /** 用服务端快照覆盖弹药箱/回收箱。 */
  function applyCratesFromSnapshot(crates) {
    ensureInventories();
    if (crates?.ammo) {
      state.ammoInv = Core.Inventory.fromJSON(crates.ammo);
    }
    if (crates?.recycle) {
      state.recycleInv = Core.Inventory.fromJSON(crates.recycle);
    }
    window.LpGuardCrateUi?.refresh?.();
  }

  /** 预加载独立炮管贴图（整图 URL；失败则 draw 走 fallback 剪影）。 */
  function loadBarrelImage() {
    if (state.barrelReady && state.barrelImg?.naturalWidth > 0) {
      return Promise.resolve(state.barrelImg);
    }
    state.barrelReady = false;
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        state.barrelImg = img;
        state.barrelReady = img.naturalWidth > 0;
        if (!state.barrelReady) {
          reject(new Error('guard barrel empty'));
          return;
        }
        resolve(img);
      };
      img.onerror = () => {
        state.barrelReady = false;
        state.barrelImg = null;
        reject(new Error(`guard barrel load failed: ${BARREL_URL}`));
      };
      img.src = BARREL_URL;
    });
  }

  /** 读取车厢规格（运行时查找，避免脚本顺序导致未缩放）。 */
  function getSpec() {
    return window.LiminalCarriageSpec || null;
  }

  /** 贴图像素 → 世界：优先 Spec.scaleArt，否则 WORLD_SCALE_FALLBACK。 */
  function scaleArt(value) {
    const Spec = getSpec();
    if (typeof Spec?.scaleArt === 'function') return Spec.scaleArt(value);
    const s =
      typeof Spec?.WORLD_SCALE === 'number' && Spec.WORLD_SCALE > 0
        ? Spec.WORLD_SCALE
        : WORLD_SCALE_FALLBACK;
    return value * s;
  }

  /** 卫兵防御车厢世界原点。 */
  function guardCar() {
    return getSpec()?.CARRIAGES?.find((car) => car.id === 'guard') || null;
  }

  /** 贴图像素 → 世界坐标（含车厢偏移）。 */
  function artToWorld(artX, artY) {
    const car = guardCar();
    return {
      x: (car?.worldX ?? 0) + scaleArt(artX),
      y: scaleArt(artY),
    };
  }

  /** 炮管贴图设计尺寸（贴图像素；未就绪用 fallback）。 */
  function barrelArtSize() {
    const img = state.barrelImg;
    if (img && state.barrelReady && img.naturalWidth > 0) {
      return { w: img.naturalWidth, h: img.naturalHeight };
    }
    return { w: ART_BARREL_FALLBACK_W, h: ART_BARREL_FALLBACK_H };
  }

  /** 炮管世界尺寸（贴图像素 × WORLD_SCALE）。 */
  function barrelSizeWorld() {
    const { w, h } = barrelArtSize();
    return { w: scaleArt(w), h: scaleArt(h) };
  }

  /**
   * 无贴图时的双管剪影占位（尺寸贴近 guard-barrel.png）。
   * 仅在 barrel 贴图未就绪时使用。
   */
  function drawBarrelFallback(ctx, bw, bh) {
    const r = Math.max(2, bh * 0.22);
    ctx.fillStyle = '#5c5c62';
    ctx.beginPath();
    ctx.roundRect(0, -bh * 0.48, bw, bh * 0.48, r);
    ctx.fill();
    ctx.fillStyle = '#8a8a90';
    ctx.beginPath();
    ctx.roundRect(bw * 0.06, bh * 0.02, bw * 0.78, bh * 0.42, r * 0.85);
    ctx.fill();
  }

  /** 枪口距枢轴距离：贴图全长（炮尾在球心、炮口在远端）。 */
  function barrelLengthWorld() {
    return barrelSizeWorld().w;
  }

  /** 归一化到 (−π, π]。 */
  function normalizeAngle(raw) {
    return Math.atan2(Math.sin(raw), Math.cos(raw));
  }

  /**
   * 角是否落在该塔允许楔内（外侧近水平经天顶到内侧高仰；不含甲板/浅角友穹扇区）。
   */
  function angleInTurretArc(raw, pivotId) {
    const a = normalizeAngle(raw);
    const id = pivotId === 'right' ? 'right' : 'left';
    const inward = ARC_IN[id];
    const outward = ARC_OUT[id];
    if (id === 'left') {
      /* 允许 [−π, ARC_IN] ∪ [ARC_OUT, π]；禁止开区间 (ARC_IN, ARC_OUT) 内的右下浅扇。 */
      return !(inward < a && a < outward);
    }
    /* 右塔：连续上弧 [ARC_IN, ARC_OUT]。 */
    return a >= inward - 1e-9 && a <= outward + 1e-9;
  }

  /** 最短有符号角差（−π…π）。 */
  function angleDelta(from, to) {
    return Math.atan2(Math.sin(to - from), Math.cos(to - from));
  }

  /** 两角最短弧长（非负）。 */
  function angleDist(from, to) {
    return Math.abs(angleDelta(from, to));
  }

  /**
   * 将瞄准角限制在该塔图2 射界楔内；越界软停到最近端点（ARC_IN / ARC_OUT）。
   */
  function clampTurretAngle(raw, pivotId) {
    const id = pivotId === 'right' ? 'right' : 'left';
    const a = normalizeAngle(raw);
    if (angleInTurretArc(a, id)) return a;
    const inward = ARC_IN[id];
    const outward = ARC_OUT[id];
    return angleDist(a, inward) <= angleDist(a, outward) ? inward : outward;
  }

  /**
   * 转向角差：留在本塔楔内，优先走经天顶的上弧，避开穿甲板的下弧。
   */
  function turnDelta(from, to, pivotId) {
    let d = angleDelta(from, to);
    const midSin = Math.sin(from + d * 0.5);
    if (midSin > Math.sin(MAX_DEPRESS) * 0.35) {
      d = d > 0 ? d - Math.PI * 2 : d + Math.PI * 2;
    }
    const midA = normalizeAngle(from + d * 0.5);
    if (!angleInTurretArc(midA, pivotId)) {
      d = d > 0 ? d - Math.PI * 2 : d + Math.PI * 2;
    }
    return d;
  }

  /** 按转速把当前角推向目标角（已按塔射界钳制）。 */
  function slewAngle(current, target, dt, pivotId) {
    const tgt = clampTurretAngle(target, pivotId);
    const d = turnDelta(current, tgt, pivotId);
    const maxStep = TURN_RATE * Math.max(0, dt);
    if (Math.abs(d) <= maxStep) return tgt;

    /* 沿楔内上弧步进；端点软停由 clampTurretAngle 保证。 */
    return clampTurretAngle(current + Math.sign(d) * maxStep, pivotId);
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

  /** 当前操控的炮塔座位 id（左站/右站，非「实际控制的塔列表」）。 */
  function getMannedId() {
    return state.manned;
  }

  /** 规范化炮位 id。 */
  function normalizeTurretId(turretId) {
    return turretId === 'right' ? 'right' : 'left';
  }

  /** 当前房间入座人数（本机 + 远端占用）。 */
  function operatorCount() {
    let n = state.manned ? 1 : 0;
    if (state.remoteClaims.left) n += 1;
    if (state.remoteClaims.right) n += 1;
    return n;
  }

  /**
   * 本机实际控制的炮塔 id 列表。
   * 仅 1 名操作员 → 双塔；2+ → 仅座位对应的一塔。
   */
  function getControlledTurretIds() {
    if (!state.manned) return [];
    if (operatorCount() <= 1) return ['left', 'right'];
    return [state.manned];
  }

  /** 是否单人双控模式。 */
  function isSoloDual() {
    return Boolean(state.manned) && operatorCount() <= 1;
  }

  /** 某侧是否已被远端占用。 */
  function isSeatClaimedByRemote(turretId) {
    const id = normalizeTurretId(turretId);
    return Boolean(state.remoteClaims[id]);
  }

  /**
   * 从联机快照同步远端炮位与瞄准。
   * 副作用：若本机所在侧被他人占用（服权威拒绝），强制离席。
   */
  function syncRemoteOperators(operators) {
    const nextClaims = { left: null, right: null };
    const nextAims = { left: null, right: null };
    const list = Array.isArray(operators) ? operators : [];
    for (const entry of list) {
      const id = entry?.turretId === 'right' ? 'right' : entry?.turretId === 'left' ? 'left' : null;
      if (!id) continue;
      const playerId = String(entry.playerId || '');
      if (!playerId) continue;
      nextClaims[id] = playerId;
      if (entry.aimX != null && entry.aimY != null) {
        nextAims[id] = { x: Number(entry.aimX), y: Number(entry.aimY) };
      }
    }
    state.remoteClaims = nextClaims;
    state.remoteAims = nextAims;
    if (state.manned && nextClaims[state.manned]) {
      exitTurret();
      window.LiminalInteract?.showToast?.('该炮位已被占用');
    }
  }

  /** 把远端准星应用到本机未控制的炮管目标角。 */
  function applyRemoteAims() {
    const controlled = new Set(getControlledTurretIds());
    for (const id of ['left', 'right']) {
      if (controlled.has(id)) continue;
      const aim = state.remoteAims[id];
      if (!aim) continue;
      const pivot = ART_PIVOTS.find((p) => p.id === id);
      if (!pivot) continue;
      const world = artToWorld(pivot.x, pivot.y);
      state.targetAngles[id] = clampTurretAngle(
        Math.atan2(aim.y - world.y, aim.x - world.x),
        id
      );
    }
  }

  /** 无人炮管回到闲置角（无人占用时）。 */
  function idleTurretIfFree(turretId) {
    const id = normalizeTurretId(turretId);
    if (state.manned === id) return;
    if (state.remoteClaims[id]) return;
    state.angles[id] = IDLE_ANGLE[id];
    state.targetAngles[id] = IDLE_ANGLE[id];
  }

  /** 进入炮塔座位（位置决定 left/right）。 */
  function enterTurret(turretId) {
    const id = normalizeTurretId(turretId);
    if (isSeatClaimedByRemote(id)) {
      window.LiminalInteract?.showToast?.(
        id === 'left' ? '左侧炮塔已被占用' : '右侧炮塔已被占用'
      );
      return false;
    }
    state.manned = id;
    document.body.classList.add('lp-turret-mode');
    window.LpSfx?.preload?.([SHOT_SFX, FEED_SFX]);
    const soloHint = operatorCount() <= 1 ? '（双联）' : '';
    window.LiminalInteract?.showToast?.(
      (id === 'left' ? '进入左侧炮塔' : '进入右侧炮塔') + soloHint
    );
    window.dispatchEvent(
      new CustomEvent('lp:turret-enter', { detail: { turretId: state.manned } })
    );
    return true;
  }

  /** 离席：仅重置无人占用的炮管到闲置朝向。 */
  function exitTurret() {
    if (!state.manned) return;
    const leftSeat = state.manned;
    state.manned = null;
    document.body.classList.remove('lp-turret-mode');
    idleTurretIfFree(leftSeat);
    if (operatorCount() === 0) {
      idleTurretIfFree('left');
      idleTurretIfFree('right');
    }
    window.LiminalInteract?.showToast?.('离开炮塔');
    window.dispatchEvent(new CustomEvent('lp:turret-exit'));
  }

  /** 炮塔交互入口（F）。已在塔内则离席。 */
  function interactTurret(turretId) {
    if (state.manned) {
      exitTurret();
      return true;
    }
    return enterTurret(turretId);
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
    const take = Math.max(0, Math.floor(qty));
    if (take <= 0) return 0;
    if (window.LpInventoryNet?.isActive?.()) {
      window.LpInventoryNet.sendOp({
        action: 'crate',
        crate: mode === 'recycle' ? 'recycle' : 'ammo',
        dir: 'deposit',
        qty: take,
      });
      return take;
    }
    const inv = invForMode(mode);
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
    const want = Math.max(0, Math.floor(qty));
    if (want <= 0) return 0;
    if (window.LpInventoryNet?.isActive?.()) {
      window.LpInventoryNet.sendOp({
        action: 'crate',
        crate: mode === 'recycle' ? 'recycle' : 'ammo',
        dir: 'withdraw',
        qty: want,
      });
      return want;
    }
    const inv = invForMode(mode);
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

  /** 生成炮塔飞行炮弹实体（射程用 shell 弹种 maxRange）。 */
  function spawnTurretTracer(muzzle) {
    window.LpCombat?.spawnProjectile?.({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: muzzle.dirX,
      dirY: muzzle.dirY,
      weaponId: 'guard_turret',
      style: 'shell',
      facing: muzzle.dirX >= 0 ? 1 : -1,
      flash: false,
    });
  }

  /** 枢轴到准星的原始瞄准角（未钳制；画布 atan2）。 */
  function rawAimAngle(aimX, aimY, pivotId) {
    const pivot = ART_PIVOTS.find((p) => p.id === pivotId);
    const world = artToWorld(pivot.x, pivot.y);
    return Math.atan2(aimY - world.y, aimX - world.x);
  }

  /**
   * 准星是否落在该塔射界楔内（复用 angleInTurretArc；界外即使炮管贴边也不开火）。
   */
  function isAimInFireArc(aimX, aimY, pivotId) {
    return angleInTurretArc(rawAimAngle(aimX, aimY, pivotId), pivotId);
  }

  /**
   * 该塔炮管是否已转到足以朝向准星（相对钳制后的目标角，容差 AIM_FIRE_TOLERANCE）。
   */
  function isBarrelAimedAt(aimX, aimY, pivotId) {
    const needed = clampTurretAngle(rawAimAngle(aimX, aimY, pivotId), pivotId);
    return angleDist(state.angles[pivotId], needed) <= AIM_FIRE_TOLERANCE;
  }

  /**
   * 入座机炮在准星处是否可开火：座位塔射界内，且炮管已跟上瞄准。
   * 不检查弹药/冷却（由 tryFire 负责）。
   */
  function canFire(aimX, aimY) {
    if (!state.manned) return false;
    const id = state.manned;
    return isAimInFireArc(aimX, aimY, id) && isBarrelAimedAt(aimX, aimY, id);
  }

  /** 按准星更新本机控制的炮塔目标朝向。 */
  function aimControlled(aimX, aimY) {
    for (const id of getControlledTurretIds()) {
      const pivot = ART_PIVOTS.find((p) => p.id === id);
      if (!pivot) continue;
      const world = artToWorld(pivot.x, pivot.y);
      state.targetAngles[id] = clampTurretAngle(
        Math.atan2(aimY - world.y, aimX - world.x),
        id
      );
    }
  }

  /**
   * 兼容旧调用名：入座后瞄准本机控制的塔（单人双塔 / 多人单塔）。
   */
  function aimBoth(aimX, aimY) {
    aimControlled(aimX, aimY);
  }

  /**
   * 炮塔开火：耗弹 1，对本机控制的塔联射（后坐 + 炮弹 + 火光）。
   * 准星出射界或炮管未转到位时只更新瞄准、不开火不耗弹。
   */
  function tryFire(aimX, aimY) {
    if (!state.manned || state.fireCooldown > 0) return null;
    aimControlled(aimX, aimY);
    if (!canFire(aimX, aimY)) return null;
    if (window.LpItemCatalog?.TEST_AUTO_REFILL_CONSUMABLES) {
      ensureInventories();
      if (ammoCount() <= 0) {
        const max = window.LpItemCatalog?.getItem?.(AMMO_ID)?.maxStack || 100;
        state.ammoInv.addItem(AMMO_ID, max);
        saveCrates();
      }
    }
    if (ammoCount() <= 0) {
      window.LiminalInteract?.showToast?.('弹药箱没有弹药');
      state.fireCooldown = 0.35;
      return null;
    }
    const online = window.LpInventoryNet?.isActive?.();
    if (!online && !window.LpItemCatalog?.TEST_AUTO_REFILL_CONSUMABLES) {
      const spent = consumeCrateAmmo(1);
      if (spent <= 0) return null;
      saveCrates();
    }
    state.fireCooldown = FIRE_COOLDOWN;

    const controlled = getControlledTurretIds();
    const muzzles = [];
    for (const id of controlled) {
      kickRecoil(id);
      const muzzle = muzzlePoint(id);
      if (!muzzle) continue;
      muzzles.push(muzzle);
      spawnTurretTracer(muzzle);
      spawnMuzzleFlash(muzzle);
    }
    if (muzzles.length === 0) return null;

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

    const primary = muzzlePoint(state.manned) || muzzles[0];
    const shots = muzzles.map((muzzle) => ({
      x: muzzle.x,
      y: muzzle.y,
      dirX: muzzle.dirX,
      dirY: muzzle.dirY,
    }));
    window.dispatchEvent(
      new CustomEvent('lp:weapon-fired', {
        detail: {
          weaponId: 'guard_turret',
          originX: primary?.x,
          originY: primary?.y,
          dirX: primary?.dirX,
          dirY: primary?.dirY,
          turret: true,
          source: 'turret',
          turretId: state.manned,
          shots,
        },
      })
    );
    return primary || null;
  }

  /**
   * 远端炮塔开火反馈：后坐与火光（弹道已由 session 生成）。
   */
  function noteRemoteFire(detail) {
    const shots = Array.isArray(detail?.shots) && detail.shots.length > 0
      ? detail.shots
      : [
          {
            x: detail?.x ?? detail?.originX,
            y: detail?.y ?? detail?.originY,
            dirX: detail?.dirX,
            dirY: detail?.dirY,
          },
        ];
    const turretId =
      detail?.turretId === 'right'
        ? 'right'
        : detail?.turretId === 'left'
          ? 'left'
          : null;
    if (turretId) kickRecoil(turretId);
    for (const shot of shots) {
      if (shot?.x == null || shot?.y == null) continue;
      const dirX = Number(shot.dirX) || 0;
      const dirY = Number(shot.dirY) || 0;
      const angle = Math.atan2(dirY, dirX);
      spawnMuzzleFlash({
        x: Number(shot.x),
        y: Number(shot.y),
        dirX,
        dirY,
        angle,
      });
      if (!turretId) {
        /* 无座位字段时按枪口近邻推断后坐塔。 */
        let best = null;
        let bestDist = Infinity;
        for (const pivot of ART_PIVOTS) {
          const world = artToWorld(pivot.x, pivot.y);
          const dx = world.x - Number(shot.x);
          const dy = world.y - Number(shot.y);
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            best = pivot.id;
          }
        }
        if (best) kickRecoil(best);
      }
    }
  }

  /** 推进转向、冷却、后坐回位与火光；并吸收远端瞄准。 */
  function tick(dt) {
    applyRemoteAims();
    for (const pivot of ART_PIVOTS) {
      const id = pivot.id;
      state.angles[id] = slewAngle(
        state.angles[id],
        state.targetAngles[id],
        dt,
        id
      );
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

  /**
   * 绘制双塔炮管（经典 2D 枢轴模型）。
   * 旧：平移到球缘 + 源矩形裁掉「球内段」→ 易与独立贴图错位，看起来悬空灰条。
   * 新：translate(白球心) → rotate(atan2 角) → 朝左半球时 scale(1,-1) 保贴图顶朝上
   *     → 后坐沿本地 −X → drawImage 整张 guard-barrel.png（炮尾在枢轴、炮口朝 +X）。
   */
  function drawBarrels(ctx) {
    const { w: bw, h: bh } = barrelSizeWorld();
    const img = state.barrelImg;
    const useImg = Boolean(img && state.barrelReady && img.naturalWidth > 0);
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (const pivot of ART_PIVOTS) {
      const world = artToWorld(pivot.x, pivot.y);
      const angle = state.angles[pivot.id];
      const kick = recoilPx(pivot.id);
      /* 贴图直立绘制；转到左半球后 rotate 会让「顶」朝下，故纵向镜像还原。 */
      const flipY = Math.cos(angle) < 0;
      ctx.save();
      ctx.translate(world.x, world.y);
      ctx.rotate(angle);
      if (flipY) ctx.scale(1, -1);
      ctx.translate(-kick, 0);
      if (useImg) {
        ctx.drawImage(img, 0, -bh / 2, bw, bh);
      } else {
        drawBarrelFallback(ctx, bw, bh);
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
    getControlledTurretIds,
    isSoloDual,
    operatorCount,
    enterTurret,
    exitTurret,
    interactTurret,
    interactAmmoBox,
    interactRecycleBox,
    depositItem,
    withdrawItem,
    aimBoth,
    aimControlled,
    tryFire,
    canFire,
    isAimInFireArc,
    clampTurretAngle,
    AIM_FIRE_TOLERANCE,
    syncRemoteOperators,
    noteRemoteFire,
    /** 卫兵机炮始终全自动（长按连发）。 */
    isFullAuto: () => true,
    tick,
    draw,
    getAimLeadScale,
    ammoCount,
    casingCount,
    applyCratesFromSnapshot,
    getAngles: () => ({ ...state.angles }),
    getTargetAngles: () => ({ ...state.targetAngles }),
    getPivotsWorld: () =>
      ART_PIVOTS.map((p) => ({ id: p.id, ...artToWorld(p.x, p.y) })),
    TURN_RATE,
    AMMO_ID,
    CASING_ID,
  };
})();
