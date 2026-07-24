/**
 * 卫兵防御车厢：双炮塔操控、弹药箱存取、回收箱。
 * 炮管贴图 guard-barrel.png（整图，不从车厢裁）；枢轴=白球心；
 * 瞄准角 atan2；过中垂线纵向镜像保贴图朝上；
 * 各塔转向楔=外侧近水平 → 经天顶 → ARC_IN（图2 交叉覆盖）；开火楔为外向子集至 FIRE_IN；
 * 深内侧仅跟踪不开火；禁止浅角打进甲板/货箱/友穹；
 * 多人：座位决定控哪塔；仅 1 名操作员时可双联；联机经 pose.turretId 同步占用与瞄准。
 * 连射抬升散布 bloom（准星张开 + 弹道抖动，封顶偏低）；双联时对角线准星显示 2 号塔 bloom。
 * 开火后坐；无抛壳特效；一发弹药 → 回收箱静默 +1 shell_casing（离线即时入箱；联机由服务端权威写入）。
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
  const FLASH_LIFE = 0.16;
  /** 火光相对枪口再向前伸出（世界像素）。 */
  const FLASH_FORWARD = 12;
  /** 炮口环境照亮半径（世界像素；additive 软晕照亮甲板/炮管）。 */
  const FLASH_LIGHT_R = 120;
  /** 炮口星爆尺度（世界像素）。 */
  const FLASH_STAR_R = 30;
  /** 开火后坐最大后移（世界像素）。 */
  const RECOIL_MAX_PX = 14;
  /** 后坐回位速度（归一化 0–1 / 秒）。 */
  const RECOIL_RECOVER = 7.5;
  /**
   * 连射散布 bloom（0–1）：每发抬升、停火回落；封顶偏低，避免准星/弹道散开过大。
   * 弹道角 = SPREAD_BASE_DEG + bloom * SPREAD_BLOOM_DEG（满 bloom ≈ 4.3°）。
   */
  const FIRE_BLOOM_KICK = 0.14;
  const FIRE_BLOOM_RECOVER = 1.35;
  const FIRE_BLOOM_MAX = 0.72;
  const SPREAD_BASE_DEG = 0.75;
  const SPREAD_BLOOM_DEG = 3.5;
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
   * 越过天顶后仍允许的内侧仰角余量（相对 −90°）——转向/软停用。
   * 图2：左塔上右、右塔上左交叉于车厢中线上方。
   * 70°：两塔枢轴间距大，准星在「两穹顶之间偏上」时 atan2 易越过 50° 端点。
   */
  const PAST_ZENITH = (70 * Math.PI) / 180;
  /**
   * 开火楔相对天顶允许的内侧余量（小于 PAST_ZENITH）。
   * 54°：覆盖右塔上左 / 左塔上右约 45–50° 对空交叉（截图姿态）；更深到 ARC_IN 仍仅跟踪。
   * 不再使用「贴天顶禁区」——那会把截图里的高中空同时挡死两塔。
   */
  const FIRE_PAST_ZENITH = (54 * Math.PI) / 180;
  /**
   * 各塔射界端点（画布 atan2：0=右，−π/2=上，π=左，+π/2=下）。
   *
   *   转向楔 TURN（炮管可转到）：
   *     left:  ARC_OUT(~172°) ──经 −π / 天顶 −90°──→ ARC_IN(~−20°)
   *     right: ARC_IN(~−160°) ──经天顶 −90°──→ ARC_OUT(~8°)
   *
   *   开火楔 FIRE（可射击；为 TURN 的外向子集）：
   *     left:  ARC_OUT(~172°) ──经 −π / 天顶──→ FIRE_IN(~−36°)
   *     right: FIRE_IN(~−144°) ──经天顶──→ ARC_OUT(~8°)
   *     区间 (FIRE_IN … ARC_IN] = 仅跟踪（深内侧交叉，约 16°）。
   *
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
  const FIRE_IN = {
    left: -Math.PI / 2 + FIRE_PAST_ZENITH,
    right: -Math.PI / 2 - FIRE_PAST_ZENITH,
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

  /** 回收箱落点（贴图像素；与 liminal-interact-spec guard-recycle 对齐）。 */
  const ART_RECYCLE = { x: 1316, y: 919 };

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
    /** 各塔连射散布 bloom 0–FIRE_BLOOM_MAX（驱动准星张开与弹道抖动）。 */
    fireBloom: { left: 0, right: 0 },
    fireCooldown: 0,
    flashes: [],
    ammoInv: null,
    recycleInv: null,
  };

  /** 读取或新建弹药箱 / 回收箱库存；若本地存档含 belts 则灌入 LpArmedAmmo。 */
  function ensureInventories() {
    if (state.ammoInv && state.recycleInv) return;
    const raw = localStorage.getItem('lp-guard-crates-v1');
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        state.ammoInv = Core.Inventory.fromJSON(parsed.ammo);
        state.recycleInv = Core.Inventory.fromJSON(parsed.recycle);
        if (parsed.belts) {
          window.LpArmedAmmo?.applyBeltsFromSnapshot?.('guard', parsed.belts);
        }
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

  /** 持久化弹药箱与回收箱（弹链由 LpArmedAmmo 自管；此处附带副本便于日后联机同快照）。 */
  function saveCrates() {
    if (window.LpInventoryNet?.isActive?.()) return;
    ensureInventories();
    const belts = window.LpArmedAmmo?.beltsToJSON?.('guard') || null;
    localStorage.setItem(
      'lp-guard-crates-v1',
      JSON.stringify({
        ammo: state.ammoInv.toJSON(),
        recycle: state.recycleInv.toJSON(),
        belts,
      })
    );
  }

  /** 用服务端快照覆盖弹药箱/回收箱（若含 belts 则同步弹链）。 */
  function applyCratesFromSnapshot(crates) {
    ensureInventories();
    if (crates?.ammo) {
      state.ammoInv = Core.Inventory.fromJSON(crates.ammo);
    }
    if (crates?.recycle) {
      state.recycleInv = Core.Inventory.fromJSON(crates.recycle);
    }
    if (crates?.belts) {
      window.LpArmedAmmo?.applyBeltsFromSnapshot?.('guard', crates.belts);
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
   * 角是否落在该塔转向楔内（外侧近水平经天顶到 ARC_IN；不含甲板/浅角友穹扇区）。
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

  /**
   * 角是否落在该塔开火楔内（TURN 的外向子集：到 FIRE_IN，不到深内侧 ARC_IN）。
   */
  function angleInFireWedge(raw, pivotId) {
    const a = normalizeAngle(raw);
    const id = pivotId === 'right' ? 'right' : 'left';
    const fireIn = FIRE_IN[id];
    const outward = ARC_OUT[id];
    if (id === 'left') {
      /* 允许 [−π, FIRE_IN] ∪ [ARC_OUT, π]；禁止 (FIRE_IN, ARC_OUT)（含深内侧到甲板浅扇）。 */
      return !(fireIn < a && a < outward);
    }
    /* 右塔：连续上弧 [FIRE_IN, ARC_OUT]。 */
    return a >= fireIn - 1e-9 && a <= outward + 1e-9;
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
   * 副作用：本机座位被他占则强制离席；远端离席或全空时对空闲塔设 IDLE 目标角（slew，不瞬移）。
   */
  function syncRemoteOperators(operators) {
    const prevClaims = {
      left: state.remoteClaims.left,
      right: state.remoteClaims.right,
    };
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
    /* 远端释放的座位 → 目标角归位；无人时双塔都归（覆盖远端曾双联的空闲侧）。 */
    for (const id of ['left', 'right']) {
      if (prevClaims[id] && !nextClaims[id]) idleTurretIfFree(id);
    }
    if (!state.manned && !nextClaims.left && !nextClaims.right) {
      idleTurretIfFree('left');
      idleTurretIfFree('right');
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

  /**
   * 无人炮管归位：只设目标角为该塔 IDLE_ANGLE，不瞬间改 angles。
   * 跳过本机控制中的塔（含单人双联的另一侧）与仍被远端占用的塔；
   * 实际朝向由 tick → slewAngle 按 TURN_RATE 追赶。
   */
  function idleTurretIfFree(turretId) {
    const id = normalizeTurretId(turretId);
    if (getControlledTurretIds().includes(id)) return;
    if (state.remoteClaims[id]) return;
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

  /**
   * 离席：立刻解除操控（可走动），清空本机散布 bloom；
   * 无人塔只改 targetAngles→IDLE_ANGLE，炮管在 tick 中按 TURN_RATE 旋回；
   * 中途再入座则从当前角继续追准星。
   */
  function exitTurret() {
    if (!state.manned) return;
    const leftSeat = state.manned;
    state.manned = null;
    state.fireBloom.left = 0;
    state.fireBloom.right = 0;
    document.body.classList.remove('lp-turret-mode');
    idleTurretIfFree(leftSeat);
    if (operatorCount() === 0) {
      idleTurretIfFree('left');
      idleTurretIfFree('right');
    }
    window.LpCombat?.syncCrosshairBloom?.();
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

  /** 开火抬升该塔连射散布 bloom（封顶 FIRE_BLOOM_MAX）。 */
  function kickFireBloom(pivotId) {
    const id = normalizeTurretId(pivotId);
    state.fireBloom[id] = Math.min(
      FIRE_BLOOM_MAX,
      (state.fireBloom[id] || 0) + FIRE_BLOOM_KICK
    );
  }

  /**
   * 读取散布 bloom（0–1 标度，相对 FIRE_BLOOM_MAX 归一化供准星用）。
   * which: 'primary' = 入座塔；'secondary' = 双联另一塔；或 'left'/'right'。
   */
  function getFireBloom(which) {
    if (!state.manned) return 0;
    let id = which;
    if (which === 'primary') id = state.manned;
    else if (which === 'secondary') {
      id = state.manned === 'left' ? 'right' : 'left';
    } else {
      id = normalizeTurretId(which);
    }
    return Math.min(1, (state.fireBloom[id] || 0) / FIRE_BLOOM_MAX);
  }

  /** 按角度旋转二维方向向量。 */
  function rotateDir(dirX, dirY, radians) {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return { x: dirX * c - dirY * s, y: dirX * s + dirY * c };
  }

  /**
   * 按该塔当前 bloom 给炮口方向加随机散布（实际弹道，非仅视觉）。
   * 半宽角 = SPREAD_BASE_DEG + bloom01 * SPREAD_BLOOM_DEG（满 bloom ≈ 4.25°）。
   */
  function applyFireSpread(dirX, dirY, pivotId) {
    const bloom01 = getFireBloom(pivotId);
    const spreadRad =
      ((SPREAD_BASE_DEG + bloom01 * SPREAD_BLOOM_DEG) * Math.PI) / 180;
    const jitter = (Math.random() * 2 - 1) * spreadRad;
    const dir = rotateDir(dirX, dirY, jitter);
    return { dirX: dir.x, dirY: dir.y, angle: Math.atan2(dir.y, dir.x) };
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

  /** 生成炮口火光（略伸出枪口；含环境照亮，由 drawFlashes 绘制）。 */
  function spawnMuzzleFlash(muzzle) {
    state.flashes.push({
      x: muzzle.x + muzzle.dirX * FLASH_FORWARD,
      y: muzzle.y + muzzle.dirY * FLASH_FORWARD,
      angle: muzzle.angle,
      life: FLASH_LIFE,
      maxLife: FLASH_LIFE,
      jitter: Math.random() * Math.PI,
      scale: 0.88 + Math.random() * 0.28,
    });
  }

  /**
   * 生成炮塔飞行炮弹实体（射程用 shell 弹种 maxRange）。
   * 外观用 peek 的下一发弹种；游标由 tryFire 在成功开火后 advance 一次。
   */
  function spawnTurretTracer(muzzle, ammoType) {
    const typeId =
      ammoType ||
      window.LpArmedAmmo?.peekFireTypeId?.() ||
      window.LpArmedAmmo?.getSelectedId?.() ||
      'ap';
    window.LpCombat?.spawnProjectile?.({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: muzzle.dirX,
      dirY: muzzle.dirY,
      weaponId: 'guard_turret',
      style: 'shell',
      ammoType: typeId,
      facing: muzzle.dirX >= 0 ? 1 : -1,
      flash: false,
    });
  }


  /**
   * 弹壳落入回收箱：离线写入本地 recycleInv；联机跳过（由 handle_fire 权威写入）。
   * 无视觉抛壳；开火成功时由 tryFire 直接调用。
   */
  function depositCasing() {
    if (window.LpInventoryNet?.isActive?.()) return;
    ensureInventories();
    state.recycleInv.addItem(CASING_ID, 1);
    saveCrates();
    window.LpGuardCrateUi?.refresh?.();
  }

  /** 枢轴到准星的原始瞄准角（未钳制；画布 atan2）。 */
  function rawAimAngle(aimX, aimY, pivotId) {
    const pivot = ART_PIVOTS.find((p) => p.id === pivotId);
    const world = artToWorld(pivot.x, pivot.y);
    return Math.atan2(aimY - world.y, aimX - world.x);
  }

  /**
   * 准星原始角是否落在该塔开火楔内（不含深内侧跟踪区）。
   */
  function isAimInFireArc(aimX, aimY, pivotId) {
    return angleInFireWedge(rawAimAngle(aimX, aimY, pivotId), pivotId);
  }

  /**
   * 该塔炮管是否已转到足以朝向准星（相对钳制后的目标角，容差 AIM_FIRE_TOLERANCE）。
   */
  function isBarrelAimedAt(aimX, aimY, pivotId) {
    const needed = clampTurretAngle(rawAimAngle(aimX, aimY, pivotId), pivotId);
    return angleDist(state.angles[pivotId], needed) <= AIM_FIRE_TOLERANCE;
  }

  /**
   * 指定炮塔在准星处是否可开火（相对该塔枢轴独立）。
   * 条件：炮管已跟上钳制目标 ∧ 炮管角在开火楔内 ∧
   *   （准星在开火楔内，或准星越出转向楔且钳制落点仍在开火楔——典型为外侧 ARC_OUT 软停）。
   * 深内侧 (FIRE_IN…ARC_IN] 可跟踪、不开火。不检查弹药/冷却（由 tryFire 负责）。
   */
  function canTurretFire(aimX, aimY, pivotId) {
    const id = pivotId === 'right' ? 'right' : 'left';
    const raw = rawAimAngle(aimX, aimY, id);
    if (!isBarrelAimedAt(aimX, aimY, id)) return false;
    const barrel = state.angles[id];
    if (!angleInFireWedge(barrel, id)) return false;
    if (angleInFireWedge(raw, id)) return true;
    /* 准星越界软停：仅外侧钳制仍在开火楔内时允许沿炮管开火；ARC_IN 软停不在开火楔。 */
    return !angleInTurretArc(raw, id);
  }

  /**
   * 开火许可：传入 pivotId 时只查该塔；否则本机控制塔中任一可开火即 true。
   * 不检查弹药/冷却（由 tryFire 负责）。
   */
  function canFire(aimX, aimY, pivotId) {
    if (!state.manned) return false;
    if (pivotId != null) return canTurretFire(aimX, aimY, pivotId);
    return getControlledTurretIds().some((id) => canTurretFire(aimX, aimY, id));
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
   * 炮塔开火：耗弹 1，仅对「本机控制且该塔射界/炮管就绪」的塔联射。
   * 各塔独立判定；无一就绪时只更新瞄准、不开火不耗弹。
   * 每耗 1 发产生 1 枚弹壳（飞向回收箱；联机由服务端写入）。
   */
  function tryFire(aimX, aimY) {
    if (!state.manned || state.fireCooldown > 0) return null;
    aimControlled(aimX, aimY);
    const ready = getControlledTurretIds().filter((id) =>
      canTurretFire(aimX, aimY, id)
    );
    if (ready.length === 0) return null;
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

    /* 弹链循环：本触发 peek 一次类型；双联多枪口共用该类型，成功后再 advance 一次游标。 */
    const ammoType =
      window.LpArmedAmmo?.peekFireTypeId?.() ||
      window.LpArmedAmmo?.getSelectedId?.() ||
      'ap';

    const muzzles = [];
    let primaryFired = null;
    for (const id of ready) {
      kickRecoil(id);
      const muzzle = muzzlePoint(id);
      if (!muzzle) continue;
      /* 先按当前 bloom 抖动弹道，再抬升 bloom（与手持 recoil 顺序一致）。 */
      const spread = applyFireSpread(muzzle.dirX, muzzle.dirY, id);
      kickFireBloom(id);
      const fired = {
        x: muzzle.x,
        y: muzzle.y,
        dirX: spread.dirX,
        dirY: spread.dirY,
        angle: spread.angle,
      };
      muzzles.push(fired);
      if (id === state.manned) primaryFired = fired;
      spawnTurretTracer(fired, ammoType);
      spawnMuzzleFlash(fired);
    }
    if (muzzles.length === 0) return null;
    window.LpArmedAmmo?.advanceFireCursor?.();
    /* 一发弹药 → 回收箱 +1 shell_casing；无抛壳特效。联机由服务端权威写入。 */
    if (!online) depositCasing();
    window.LpCombat?.syncCrosshairBloom?.();

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

    const primary = primaryFired || muzzles[0];
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
          ammoType,
          shots,
        },
      })
    );
    return primary || null;
  }

  /**
   * 远端炮塔开火反馈：后坐与炮口火光（弹道已由 session 生成；库存由服务端权威；无抛壳特效）。
   * 每发按枪口近邻踢后坐（双联 shots[] 时左右塔都会晃，不单靠 seat turretId）。
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
    const kicked = new Set();
    for (const shot of shots) {
      if (shot?.x == null || shot?.y == null) continue;
      const dirX = Number(shot.dirX) || 0;
      const dirY = Number(shot.dirY) || 0;
      const angle = Math.atan2(dirY, dirX);
      const sx = Number(shot.x);
      const sy = Number(shot.y);
      spawnMuzzleFlash({
        x: sx,
        y: sy,
        dirX,
        dirY,
        angle,
      });
      let best = null;
      let bestDist = Infinity;
      for (const pivot of ART_PIVOTS) {
        const world = artToWorld(pivot.x, pivot.y);
        const dx = world.x - sx;
        const dy = world.y - sy;
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = pivot.id;
        }
      }
      if (best && !kicked.has(best)) {
        kicked.add(best);
        kickRecoil(best);
      }
    }
    if (kicked.size === 0) {
      const turretId =
        detail?.turretId === 'right'
          ? 'right'
          : detail?.turretId === 'left'
            ? 'left'
            : null;
      if (turretId) kickRecoil(turretId);
    }
  }

  /** 推进转向、冷却、后坐/散布回落与火光；并吸收远端瞄准。 */
  function tick(dt) {
    applyRemoteAims();
    let bloomChanged = false;
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
      if (state.fireBloom[id] > 0) {
        state.fireBloom[id] = Math.max(
          0,
          state.fireBloom[id] - FIRE_BLOOM_RECOVER * dt
        );
        bloomChanged = true;
      }
    }
    if (bloomChanged && state.manned) {
      window.LpCombat?.syncCrosshairBloom?.();
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

  /** 绘制炮口火光（共享 LpCombat 配方：环境照亮 + 星爆焰舌）。 */
  function drawFlashes(ctx) {
    const drawFx = window.LpCombat?.drawMuzzleFlash;
    if (!drawFx) return;
    for (const flash of state.flashes) {
      const t = Math.max(0, flash.life / flash.maxLife);
      drawFx(ctx, {
        x: flash.x,
        y: flash.y,
        angle: flash.angle,
        t,
        lightR: FLASH_LIGHT_R,
        flashR: FLASH_STAR_R,
        jitter: flash.jitter,
        scale: flash.scale ?? 1,
      });
    }
  }

  /**
   * 在车厢贴图之下绘制炮管（白球/车身挡住炮尾）。
   * 火光须走 drawFx，否则会被车厢 PNG 盖住。
   */
  function draw(ctx) {
    if (!guardCar()) return;
    const paint = () => {
      drawBarrels(ctx);
    };
    if (window.LpCarriageBob?.withGuardDraw) {
      window.LpCarriageBob.withGuardDraw(ctx, paint);
    } else {
      paint();
    }
  }

  /**
   * 在车厢贴图之上绘制炮口火光（与车厢同套颠簸；无抛壳特效）。
   * 开火原点仍用未颠簸世界坐标。
   */
  function drawFx(ctx) {
    if (!guardCar()) return;
    const paint = () => {
      drawFlashes(ctx);
    };
    if (window.LpCarriageBob?.withGuardDraw) {
      window.LpCarriageBob.withGuardDraw(ctx, paint);
    } else {
      paint();
    }
  }

  /**
   * 准星镜头领先系数（进塔后更大，尤其配合纵向仰射）。
   * 自动化开火同样走此内置提前；不再暴露「动态提前量」玩家参数。
   */
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
    getFireBloom,
    enterTurret,
    exitTurret,
    interactTurret,
    interactAmmoBox,
    interactRecycleBox,
    depositItem,
    withdrawItem,
    /** 弹药箱 / 回收箱 Inventory（供存取 UI 按 footprint 渲染）。 */
    getCrateInventory: (mode) => invForMode(mode),
    aimBoth,
    aimControlled,
    tryFire,
    canFire,
    canTurretFire,
    isAimInFireArc,
    clampTurretAngle,
    AIM_FIRE_TOLERANCE,
    syncRemoteOperators,
    noteRemoteFire,
    /** 卫兵机炮始终全自动（长按连发）。 */
    isFullAuto: () => true,
    tick,
    draw,
    drawFx,
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
