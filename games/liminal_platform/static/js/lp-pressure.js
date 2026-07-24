/**
 * 本地压力（压力值）状态与效果。
 *
 * 上限：默认 200；同车厢有队友时有效上限 160（硬钳制，增益与每帧均 clamp）。
 * 来源：同车小怪（p&lt;20 时 +5，冷却 2.5s）、受击 +5、同车开火（p&lt;20 时 +10 后中速回落到 20）、
 * 附近友军最终死亡 +100、附近友军重新部署 +20（半径见 LpPlayerDeath.allyDeathRadius；进入濒死 / 医箱复活不加）。
 * 衰减：无有效动作一段时间后缓慢下降；开火余晖优先于闲置衰减。
 * 效果带（相对绝对值，不随上限 2×）：0 无；(0,20] → 线性至 +5%；(20,25] +5% 平台；&gt;25 线性至有效上限处 −10%。
 * 准确度 / 作业效率倍率 = 1 + effectPct；作业效率暂无玩法消费，仅 API。
 * 联机：压力为每人本地权威，经 pose 透传供队友 HUD；色差与准确度只看本机压力。
 * 详见 docs/pressure.md。
 */
(() => {
  const MAX_ALONE = 200;
  const MAX_WITH_TEAMMATE = 160;
  const BUFF_RAMP_END = 20;
  const BUFF_FLAT_END = 25;
  const BUFF_PEAK = 0.05;
  const DEBUFF_FLOOR = -0.1;
  const TRIGGER_BELOW = 20;
  const AFTERGLOW_FLOOR = 20;
  const MOB_PRESENCE_DELTA = 5;
  const MOB_HIT_DELTA = 5;
  const FIRE_DELTA = 10;
  /** 附近友军计时耗尽最终死亡一次加压。 */
  const ALLY_DEATH_DELTA = 100;
  /** 附近友军从濒死重新部署一次加压。 */
  const ALLY_REDEPLOY_DELTA = 20;
  /** 同车小怪加压冷却（秒）——边沿式间隔，避免每帧叠。 */
  const MOB_PRESENCE_COOLDOWN = 2.5;
  /** 无有效动作多久后开始闲置衰减（秒）。 */
  const IDLE_DELAY = 3.5;
  /** 闲置衰减速率（点/秒）。 */
  const IDLE_DECAY_PER_SEC = 4;
  /** 开火余晖回落到 20 的速率（点/秒，中速）。 */
  const AFTERGLOW_DECAY_PER_SEC = 22;
  const CHROMA_START = 150;

  let pressure = 0;
  let lastActionAt = performance.now();
  let fireAfterglow = false;
  let mobPresenceCd = 0;
  let chromaEl = null;

  /** 钳到 [0, max]。 */
  function clampPressure(value, max) {
    const m = Math.max(0, Number(max) || MAX_ALONE);
    return Math.max(0, Math.min(m, Number(value) || 0));
  }

  /**
   * 本地玩家世界 X 处是否有其他在线远端队友同车厢。
   * @param {number} localX
   * @returns {boolean}
   */
  function hasTeammateInSameCarriage(localX) {
    const Spec = window.LiminalCarriageSpec;
    const remotes = window.LiminalSession?.remotes?.();
    if (!Spec?.carriageAt || !remotes) return false;
    const myCar = Spec.carriageAt(localX);
    if (!myCar) return false;
    for (const remote of remotes.values()) {
      if (!remote || remote._lpDisconnected) continue;
      const rx = Number(remote.x);
      if (!Number.isFinite(rx)) continue;
      const car = Spec.carriageAt(rx);
      if (car && car.id === myCar.id) return true;
    }
    return false;
  }

  /**
   * 当前有效压力上限（同车有队友 → 160，否则 200）。
   * @param {number} [localX]
   * @returns {number}
   */
  function getEffectiveMax(localX) {
    const x =
      localX != null && Number.isFinite(localX)
        ? localX
        : window.LpGame?.getLocalX?.();
    if (x != null && hasTeammateInSameCarriage(x)) return MAX_WITH_TEAMMATE;
    return MAX_ALONE;
  }

  /**
   * 准确度 / 作业效率加成（−0.10…+0.05），相对有效上限映射。
   * @param {number} [p]
   * @param {number} [maxP]
   * @returns {number}
   */
  function effectPct(p = pressure, maxP = getEffectiveMax()) {
    const v = Number(p) || 0;
    const max = Math.max(BUFF_FLAT_END + 1e-6, Number(maxP) || MAX_ALONE);
    if (v <= 0) return 0;
    if (v <= BUFF_RAMP_END) return (v / BUFF_RAMP_END) * BUFF_PEAK;
    if (v <= BUFF_FLAT_END) return BUFF_PEAK;
    const t = (v - BUFF_FLAT_END) / (max - BUFF_FLAT_END);
    return BUFF_PEAK + Math.max(0, Math.min(1, t)) * (DEBUFF_FLOOR - BUFF_PEAK);
  }

  /** 标记有有效动作，重置闲置计时。 */
  function noteAction() {
    lastActionAt = performance.now();
  }

  /**
   * 写入压力并按当前有效上限硬钳制。
   * @param {number} next
   * @param {number} [localX]
   */
  function setPressure(next, localX) {
    pressure = clampPressure(next, getEffectiveMax(localX));
    window.LpHudVitals?.syncLocalPressure?.(pressure, getEffectiveMax(localX));
    syncChroma();
  }

  /** 受击：无条件 +5。 */
  function noteMobHit(localX) {
    noteAction();
    setPressure(pressure + MOB_HIT_DELTA, localX);
  }

  /**
   * 附近友军计时耗尽最终死亡：+100（钳制到有效上限）。
   * @param {number} [localX]
   */
  function noteAllyDeathNearby(localX) {
    noteAction();
    setPressure(pressure + ALLY_DEATH_DELTA, localX);
  }

  /**
   * 附近友军从濒死重新部署：+20。
   * @param {number} [localX]
   */
  function noteAllyRedeployNearby(localX) {
    noteAction();
    setPressure(pressure + ALLY_REDEPLOY_DELTA, localX);
  }

  /**
   * 同车厢开火：p&lt;20 时 +10，并开启回落到 20 的余晖。
   * @param {number|null|undefined} originX
   * @param {number} [listenerX]
   */
  function noteWeaponFireInCarriage(originX, listenerX) {
    const Sfx = window.LpSfx;
    const Spec = window.LiminalCarriageSpec;
    const lx =
      listenerX != null && Number.isFinite(listenerX)
        ? listenerX
        : window.LpGame?.getLocalX?.();
    if (lx == null || originX == null || !Number.isFinite(originX)) return;
    let same = false;
    if (Sfx?.sameCarriage) same = Sfx.sameCarriage(originX, lx);
    else if (Spec?.carriageAt) {
      const a = Spec.carriageAt(originX);
      const b = Spec.carriageAt(lx);
      same = !!(a && b && a.id === b.id);
    }
    if (!same) return;
    noteAction();
    if (pressure < TRIGGER_BELOW) {
      setPressure(pressure + FIRE_DELTA, lx);
    }
    if (pressure > AFTERGLOW_FLOOR) fireAfterglow = true;
  }

  /**
   * 同车舱内小怪数量（phase inside/jump/enter）。
   * @param {number} localX
   * @returns {number}
   */
  function countMobsInSameCarriage(localX) {
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageAt?.(localX);
    if (!car) return 0;
    const mobs = window.LpMobs?.getMobs?.() || [];
    let n = 0;
    for (const m of mobs) {
      if (!m || m.alive === false) continue;
      if (m.carId !== car.id) continue;
      const phase = m.phase;
      if (phase === 'inside' || phase === 'jump' || phase === 'enter') n += 1;
    }
    return n;
  }

  /** 确保色差层挂在 .lp-stage 上且不挡触控。 */
  function ensureChromaEl() {
    if (chromaEl && chromaEl.isConnected) return chromaEl;
    const stage = document.querySelector('.lp-stage');
    if (!stage) return null;
    chromaEl = document.getElementById('lpPressureChroma');
    if (!chromaEl) {
      chromaEl = document.createElement('div');
      chromaEl.id = 'lpPressureChroma';
      chromaEl.className = 'lp-pressure-chroma';
      chromaEl.setAttribute('aria-hidden', 'true');
      chromaEl.innerHTML =
        '<div class="lp-pressure-chroma-r"></div><div class="lp-pressure-chroma-b"></div>';
      stage.appendChild(chromaEl);
    }
    return chromaEl;
  }

  /**
   * 本机压力 &gt;150 时开边缘色差；强度按 (p−150)/(max−150) 归一。
   * 触屏略减弱位移，避免小屏过猛。
   */
  function syncChroma() {
    const el = ensureChromaEl();
    if (!el) return;
    const maxP = getEffectiveMax();
    const headroom = maxP - CHROMA_START;
    if (pressure <= CHROMA_START || headroom <= 0) {
      el.classList.remove('is-on');
      el.style.removeProperty('--lp-chroma');
      el.style.removeProperty('--lp-chroma-shift');
      return;
    }
    const t = Math.max(0, Math.min(1, (pressure - CHROMA_START) / headroom));
    const coarse =
      typeof matchMedia === 'function' &&
      matchMedia('(hover: none), (pointer: coarse)').matches;
    const shift = (coarse ? 1.2 : 2.4) + t * (coarse ? 2.4 : 4.5);
    el.classList.add('is-on');
    el.style.setProperty('--lp-chroma', String(0.22 + t * 0.55));
    el.style.setProperty('--lp-chroma-shift', `${shift.toFixed(2)}px`);
  }

  /**
   * 每帧：钳制上限、余晖/闲置衰减、同车小怪加压、刷新色差。
   * @param {number} dt
   * @param {{ localX?: number, active?: boolean }} [ctx]
   */
  function tick(dt, ctx = {}) {
    const localX = ctx.localX ?? window.LpGame?.getLocalX?.();
    const maxP = getEffectiveMax(localX);
    if (pressure > maxP) setPressure(pressure, localX);

    if (mobPresenceCd > 0) mobPresenceCd = Math.max(0, mobPresenceCd - dt);

    if (fireAfterglow) {
      if (pressure > AFTERGLOW_FLOOR) {
        setPressure(pressure - AFTERGLOW_DECAY_PER_SEC * dt, localX);
      }
      if (pressure <= AFTERGLOW_FLOOR) {
        pressure = Math.min(pressure, AFTERGLOW_FLOOR);
        fireAfterglow = false;
        setPressure(pressure, localX);
      }
    } else if (ctx.active !== false) {
      const idleSec = (performance.now() - lastActionAt) / 1000;
      if (idleSec >= IDLE_DELAY && pressure > 0) {
        setPressure(pressure - IDLE_DECAY_PER_SEC * dt, localX);
      }
    }

    if (
      localX != null &&
      pressure < TRIGGER_BELOW &&
      mobPresenceCd <= 0 &&
      countMobsInSameCarriage(localX) > 0
    ) {
      setPressure(pressure + MOB_PRESENCE_DELTA, localX);
      mobPresenceCd = MOB_PRESENCE_COOLDOWN;
    }

    syncChroma();
  }

  /** 监听本机开火事件（手持 / 炮塔），仅同车厢加压。 */
  function onWeaponFired(event) {
    const d = event?.detail || {};
    const ox = d.originX ?? d.x;
    noteWeaponFireInCarriage(ox, window.LpGame?.getLocalX?.());
  }

  window.addEventListener('lp:weapon-fired', onWeaponFired);

  window.LpPressure = {
    MAX_ALONE,
    MAX_WITH_TEAMMATE,
    BUFF_RAMP_END,
    BUFF_FLAT_END,
    TRIGGER_BELOW,
    AFTERGLOW_FLOOR,
    CHROMA_START,
    ALLY_DEATH_DELTA,
    ALLY_REDEPLOY_DELTA,
    MOB_PRESENCE_COOLDOWN,
    IDLE_DELAY,
    IDLE_DECAY_PER_SEC,
    AFTERGLOW_DECAY_PER_SEC,
    getPressure: () => pressure,
    getEffectiveMax,
    /** 加成小数：−0.10…+0.05。 */
    getEffectPct: () => effectPct(),
    /** 准确度倍率（1 + effectPct）；散布应乘 (1 − effectPct)。 */
    getAccuracyMul: () => 1 + effectPct(),
    /** 散布半宽缩放：准确度越高越窄。 */
    getAccuracySpreadScale: () => 1 - effectPct(),
    /** 作业效率倍率；暂无系统消费。 */
    get workEfficiencyMul() {
      return 1 + effectPct();
    },
    getWorkEfficiencyMul: () => 1 + effectPct(),
    noteAction,
    noteMobHit,
    noteAllyDeathNearby,
    noteAllyRedeployNearby,
    noteWeaponFireInCarriage,
    setPressure,
    tick,
    hasTeammateInSameCarriage,
    effectPct,
    syncChroma,
  };
})();
