/**
 * 轻量一次性音效：共享 AudioContext，缓冲缓存，支持连发叠播。
 * 传入世界坐标 x/y 时按与听者距离衰减；同车厢（carriage.id）则满音量不衰减。
 * ambient / 无坐标则不衰减（UI、环境层）。火车行驶/rumble 走 LpTrainAudio，不经本模块。
 */
(() => {
  /** 参考距离内满音量（世界像素；约 0.6 节 MODULE_W≈1980）。 */
  const REF_DIST = 1200;
  /** 超过此距离静音（约 4.5 节；跨多节仍可闻）。 */
  const MAX_DIST = 9000;
  /** <1 压平重映射 1/d，抬高中远距增益（同车厢仍走 distanceMul 短路）。 */
  const FALLOFF_EXP = 0.65;

  let ctx = null;
  let unlocked = false;
  /** @type {Map<string, AudioBuffer>} */
  const buffers = new Map();
  /** @type {Map<string, Promise<AudioBuffer|null>>} */
  const loading = new Map();

  /** 首次交互解锁（可与列车音共用用户手势）。 */
  async function unlock() {
    if (unlocked && ctx) {
      if (ctx.state === 'suspended') await ctx.resume();
      return;
    }
    ctx = new AudioContext();
    unlocked = true;
  }

  /** 加载并缓存 AudioBuffer。 */
  async function load(url) {
    if (!url) return null;
    if (buffers.has(url)) return buffers.get(url);
    if (loading.has(url)) return loading.get(url);
    const job = (async () => {
      try {
        if (!ctx) await unlock();
        const response = await fetch(url);
        if (!response.ok) throw new Error(`sfx fetch ${response.status}`);
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        buffers.set(url, buffer);
        return buffer;
      } catch (err) {
        console.warn('[lp-sfx]', url, err);
        return null;
      } finally {
        loading.delete(url);
      }
    })();
    loading.set(url, job);
    return job;
  }

  /**
   * 听者世界坐标：本地玩家；缺省 (0,0) 仅在尚未进关时。
   * @returns {{ x: number, y: number }}
   */
  function getListenerPos() {
    const avatar = window.LpGame?.getLocalAvatar?.();
    if (avatar && Number.isFinite(avatar.x) && Number.isFinite(avatar.y)) {
      return { x: avatar.x, y: avatar.y };
    }
    return { x: 0, y: 0 };
  }

  /**
   * 距离衰减增益：REF 内为 1；MAX 外为 0；其间为重映射 1/d 再 ^FALLOFF_EXP（近响远弱、中距更可闻）。
   * @param {number} dist
   * @returns {number} 0..1
   */
  function falloffGain(dist) {
    if (!(dist > 0)) return 1;
    if (dist <= REF_DIST) return 1;
    if (dist >= MAX_DIST) return 0;
    const inv = REF_DIST / dist;
    const invAtMax = REF_DIST / MAX_DIST;
    const t = Math.max(0, Math.min(1, (inv - invAtMax) / (1 - invAtMax)));
    return Math.pow(t, FALLOFF_EXP);
  }

  /**
   * 听者与声源是否在同一节车厢走道带内（节间/车外为 false）。
   * @param {number} sourceX
   * @param {number} listenerX
   * @returns {boolean}
   */
  function sameCarriage(sourceX, listenerX) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.carriageAt) return false;
    const src = Spec.carriageAt(sourceX);
    const listen = Spec.carriageAt(listenerX);
    return !!(src && listen && src.id === listen.id);
  }

  /**
   * 由声源世界坐标相对听者算音量倍率；无有效坐标则 1（不衰减）。
   * 同车厢满音量；跨车厢/车外用 REF/MAX 距离衰减。
   * @param {number|null|undefined} x
   * @param {number|null|undefined} y
   * @returns {number} 0..1
   */
  function distanceMul(x, y) {
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return 1;
    }
    const listener = getListenerPos();
    if (sameCarriage(x, listener.x)) return 1;
    const dist = Math.hypot(x - listener.x, y - listener.y);
    return falloffGain(dist);
  }

  /**
   * 播放一次性音效。
   * @param {string} url
   * @param {{
   *   volume?: number,
   *   playbackRate?: number,
   *   rateJitter?: number,
   *   x?: number,
   *   y?: number,
   *   ambient?: boolean,
   * }} [opts]
   * ambient 或未给 x/y：不按距离衰减。给了 x+y：同车厢满音量，否则乘以 distanceMul。
   */
  async function play(url, opts = {}) {
    if (!url) return;
    try {
      if (!unlocked || !ctx) await unlock();
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = await load(url);
      if (!buffer || !ctx) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      let rate = opts.playbackRate ?? 1;
      const jitter = opts.rateJitter ?? 0;
      if (jitter > 0) rate *= 1 + (Math.random() * 2 - 1) * jitter;
      source.playbackRate.value = Math.max(0.5, Math.min(2, rate));
      const baseVol = Math.max(0, Math.min(1, opts.volume ?? 0.7));
      const spatial =
        !opts.ambient && opts.x != null && opts.y != null
          ? distanceMul(opts.x, opts.y)
          : 1;
      if (spatial <= 0.001) return;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, baseVol * spatial));
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
    } catch (err) {
      console.warn('[lp-sfx] play', err);
    }
  }

  /** 预加载若干 URL（开火前可预热）。 */
  function preload(urls) {
    for (const url of urls || []) load(url);
  }

  function suspend() {
    if (ctx?.state === 'running') ctx.suspend();
  }

  async function resume() {
    if (ctx?.state === 'suspended') await ctx.resume();
  }

  window.LpSfx = {
    unlock,
    load,
    play,
    preload,
    suspend,
    resume,
    /** @internal 测试/调试用 */
    distanceMul,
    falloffGain,
    sameCarriage,
    REF_DIST,
    MAX_DIST,
    FALLOFF_EXP,
  };
})();
