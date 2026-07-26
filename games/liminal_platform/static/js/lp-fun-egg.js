/**
 * 趣味彩蛋抽奖：累计活跃游玩每满 5 分钟掷一次 fun∈[0,10000)，命中映射则触发。
 *
 * 计时：用主循环传入的 dt（performance.now 派生）累加，非墙钟。
 * 暂停：document.hidden / visibilityState!=='visible' 时不累加——与列车/SFX suspend 一致；
 * 本页即 liminal，无额外「不在月台」门闩。
 */
(() => {
  const ROLL_INTERVAL_MS = 5 * 60 * 1000;
  const ROLL_INTERVAL_SEC = ROLL_INTERVAL_MS / 1000;
  const FUN_MAX = 10000;
  const EGG_FUN_8BIT = 630;
  const NOISE_SFX =
    '/static/games/liminal-platform/audio/fun-8bit-noise.wav?v=3';

  /** @type {number|null} 最近一次掷出的 fun；未掷过为 null */
  let fun = null;
  /** 自上次掷骰以来累计的活跃毫秒 */
  let accumulatedMs = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  /** 播放 8-bit 噪音（fun===630）。 */
  function playEightBitNoise() {
    window.LpSfx?.play?.(NOISE_SFX, { ambient: true, volume: 0.85 });
  }

  /**
   * fun 值 → 彩蛋处理。后续彩蛋往此表加条目即可。
   * @type {Record<number, () => void>}
   */
  const EGG_BY_FUN = {
    [EGG_FUN_8BIT]: playEightBitNoise,
  };

  /** 通知调试 UI 等订阅方刷新显示。 */
  function notify() {
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        console.warn('[lp-fun-egg] listener', err);
      }
    }
  }

  /** 当前 fun（未掷过为 null）。 */
  function getFun() {
    return fun;
  }

  /**
   * 调试用：直接写入 fun（不自动触发彩蛋）；取模落入 [0,10000)。
   * @param {number} value
   * @returns {number|null}
   */
  function setFun(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fun;
    fun = ((n % FUN_MAX) + FUN_MAX) % FUN_MAX;
    notify();
    return fun;
  }

  /** 自上次掷骰累计的活跃毫秒。 */
  function getAccumulatedMs() {
    return accumulatedMs;
  }

  /**
   * 调试用：改写累计毫秒（可加速下一掷）。
   * @param {number} ms
   * @returns {number}
   */
  function setAccumulatedMs(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return accumulatedMs;
    accumulatedMs = n;
    notify();
    return accumulatedMs;
  }

  /**
   * 掷一次 fun∈[0,10000)，写入并尝试触发对应彩蛋。
   * @returns {number}
   */
  function roll() {
    fun = Math.floor(Math.random() * FUN_MAX);
    triggerEgg(fun);
    notify();
    return fun;
  }

  /**
   * 按 fun 值触发彩蛋（调试可强制；自然掷骰也会调用）。
   * @param {number} [value=fun]
   * @returns {boolean} 是否有对应彩蛋被调用
   */
  function triggerEgg(value = fun) {
    const key = Math.floor(Number(value));
    if (!Number.isFinite(key)) return false;
    const egg = EGG_BY_FUN[key];
    if (!egg) return false;
    egg();
    return true;
  }

  /**
   * 主循环钩子：活跃时累加 dt，满 5 分钟掷骰（可连掷）。
   * @param {number} dt 秒
   */
  function tick(dt) {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    accumulatedMs += dt * 1000;
    while (accumulatedMs >= ROLL_INTERVAL_MS) {
      accumulatedMs -= ROLL_INTERVAL_MS;
      roll();
    }
  }

  /**
   * 订阅 fun / 累计时间变化（调试面板刷新）。
   * @param {() => void} fn
   * @returns {() => void} 取消订阅
   */
  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * 当前状态快照（调试 UI）。
   * @returns {{ fun: number|null, accumSec: number, intervalSec: number, nextInSec: number }}
   */
  function getState() {
    const accumSec = accumulatedMs / 1000;
    return {
      fun,
      accumSec,
      intervalSec: ROLL_INTERVAL_SEC,
      nextInSec: Math.max(0, ROLL_INTERVAL_SEC - accumSec),
    };
  }

  /** 预加载彩蛋音效（可在音频解锁后调用）。 */
  function preload() {
    window.LpSfx?.preload?.([NOISE_SFX]);
  }

  window.LpFunEgg = {
    ROLL_INTERVAL_MS,
    ROLL_INTERVAL_SEC,
    FUN_MAX,
    EGG_FUN_8BIT,
    NOISE_SFX,
    EGG_BY_FUN,
    getFun,
    setFun,
    getAccumulatedMs,
    setAccumulatedMs,
    getState,
    roll,
    triggerEgg,
    tick,
    preload,
    subscribe,
  };
})();
