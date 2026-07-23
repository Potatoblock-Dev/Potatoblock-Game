/**
 * 轻量一次性音效：共享 AudioContext，缓冲缓存，支持连发叠播。
 */
(() => {
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
   * 播放一次性音效。
   * @param {string} url
   * @param {{ volume?: number, playbackRate?: number, rateJitter?: number }} [opts]
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
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, opts.volume ?? 0.7));
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
  };
})();
