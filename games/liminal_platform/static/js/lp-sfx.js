/**
 * 轻量音效：共享 AudioContext，缓冲缓存，支持连发叠播与单 URL 循环。
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
  /**
   * 重衰减（仅炮塔转管 intro/loop/outro）：同车厢仍满音；跨车 REF 更近、MAX 更短、指数更高。
   * 约 1 节外近静音。机炮开火/进弹勿用 heavy——走 soft falloff（REF/MAX/EXP 上方）。
   */
  const HEAVY_REF_DIST = 400;
  const HEAVY_MAX_DIST = 2000;
  const HEAVY_FALLOFF_EXP = 2.4;

  let ctx = null;
  let unlocked = false;
  /** @type {Map<string, AudioBuffer>} */
  const buffers = new Map();
  /** @type {Map<string, Promise<AudioBuffer|null>>} */
  const loading = new Map();
  /**
   * 正在播放的循环源；键为 opts.key 或 url（同键单实例）。
   * @type {Map<string, {
   *   source: AudioBufferSourceNode,
   *   gain: GainNode,
   *   volume: number,
   *   url: string,
   *   x: number|null,
   *   y: number|null,
   *   heavy: boolean,
   *   ambient: boolean,
   * }>}
   */
  const loops = new Map();
  /**
   * 互斥一次性音（opts.key）；同键新 play 会停掉旧源，避免 intro/outro 叠层。
   * @type {Map<string, { source: AudioBufferSourceNode, gain: GainNode }>}
   */
  const oneShots = new Map();
  /**
   * startLoop 取消代数：stopLoop 递增，使仍在 await load 的 startLoop 放弃建源。
   * @type {Map<string, number>}
   */
  const loopCancelGen = new Map();
  /** 正在 await 建环的 key，防止并发 startLoop 双开。 */
  const loopStarting = new Set();

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
   * 距离衰减增益：REF 内为 1；MAX 外为 0；其间为重映射 1/d 再 ^exp。
   * @param {number} dist
   * @param {number} [ref=REF_DIST]
   * @param {number} [max=MAX_DIST]
   * @param {number} [exp=FALLOFF_EXP]
   * @returns {number} 0..1
   */
  function falloffGain(dist, ref = REF_DIST, max = MAX_DIST, exp = FALLOFF_EXP) {
    if (!(dist > 0)) return 1;
    if (dist <= ref) return 1;
    if (dist >= max) return 0;
    const inv = ref / dist;
    const invAtMax = ref / max;
    const t = Math.max(0, Math.min(1, (inv - invAtMax) / (1 - invAtMax)));
    return Math.pow(t, exp);
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
   * 重衰减音量倍率：同车厢满音；跨车用 HEAVY_REF/MAX/^EXP（远弱于 distanceMul）。
   * @param {number|null|undefined} x
   * @param {number|null|undefined} y
   * @returns {number} 0..1
   */
  function heavyDistanceMul(x, y) {
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) {
      return 1;
    }
    const listener = getListenerPos();
    if (sameCarriage(x, listener.x)) return 1;
    const dist = Math.hypot(x - listener.x, y - listener.y);
    return falloffGain(dist, HEAVY_REF_DIST, HEAVY_MAX_DIST, HEAVY_FALLOFF_EXP);
  }

  /**
   * 按 opts 算空间倍率：ambient/无坐标 → 1；heavy → heavyDistanceMul；否则 distanceMul。
   * @param {{ ambient?: boolean, heavy?: boolean, x?: number, y?: number }} opts
   * @returns {number} 0..1
   */
  function spatialMulFromOpts(opts) {
    if (opts.ambient || opts.x == null || opts.y == null) return 1;
    return opts.heavy ? heavyDistanceMul(opts.x, opts.y) : distanceMul(opts.x, opts.y);
  }

  /**
   * 硬停并拆除一个互斥 one-shot 条目（已从 map 移除后调用）。
   * @param {{ source: AudioBufferSourceNode, gain: GainNode }} entry
   */
  function disposeOneShotEntry(entry) {
    try {
      entry.source.stop(0);
    } catch (_) {
      /* already stopped */
    }
    try {
      entry.source.disconnect();
    } catch (_) {
      /* already disconnected */
    }
    try {
      entry.gain.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  }

  /**
   * 停止互斥一次性音；未在播则无操作。
   * @param {string} key
   */
  function stopOneShot(key) {
    if (!key) return;
    const entry = oneShots.get(key);
    if (!entry) return;
    oneShots.delete(key);
    disposeOneShotEntry(entry);
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
   *   heavy?: boolean,
   *   key?: string,
   * }} [opts]
   * ambient 或未给 x/y：不按距离衰减。
   * 给了 x+y：同车厢满音量；跨车用 distanceMul，或 heavy 时用 heavyDistanceMul。
   * 若给 key：同键互斥（新播停旧），用于转管 intro/outro 等不可叠层 one-shot。
   */
  async function play(url, opts = {}) {
    if (!url) return;
    const exclusiveKey = opts.key || null;
    try {
      if (!unlocked || !ctx) await unlock();
      if (ctx.state === 'suspended') await ctx.resume();
      const buffer = await load(url);
      if (!buffer || !ctx) return;
      const baseVol = Math.max(0, Math.min(1, opts.volume ?? 0.7));
      const spatial = spatialMulFromOpts(opts);
      if (spatial <= 0.001) return;
      /* 静音早退后才停旧源，避免远距 play 误杀正在播的互斥 one-shot */
      if (exclusiveKey) stopOneShot(exclusiveKey);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      let rate = opts.playbackRate ?? 1;
      const jitter = opts.rateJitter ?? 0;
      if (jitter > 0) rate *= 1 + (Math.random() * 2 - 1) * jitter;
      source.playbackRate.value = Math.max(0.5, Math.min(2, rate));
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, baseVol * spatial));
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      if (exclusiveKey) {
        oneShots.set(exclusiveKey, { source, gain });
        source.onended = () => {
          if (oneShots.get(exclusiveKey)?.source === source) {
            oneShots.delete(exclusiveKey);
          }
        };
      }
    } catch (err) {
      console.warn('[lp-sfx] play', err);
    }
  }

  /** 预加载若干 URL（开火前可预热）。 */
  function preload(urls) {
    for (const url of urls || []) load(url);
  }

  /**
   * 硬停并拆除一个循环条目（已从 map 移除后调用）。
   * @param {{ source: AudioBufferSourceNode, gain: GainNode }} entry
   */
  function disposeLoopEntry(entry) {
    try {
      entry.source.stop(0);
    } catch (_) {
      /* already stopped */
    }
    try {
      entry.source.disconnect();
    } catch (_) {
      /* already disconnected */
    }
    try {
      entry.gain.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  }

  /**
   * 开始无缝循环（同 key 已在播则忽略，除非 opts.replace）。需素材自身可 loop。
   * @param {string} url
   * @param {{
   *   key?: string,
   *   volume?: number,
   *   fadeIn?: number,
   *   ambient?: boolean,
   *   heavy?: boolean,
   *   replace?: boolean,
   *   x?: number,
   *   y?: number,
   * }} [opts]
   * key 默认 url；给了 x+y 且非 ambient 则按距离/heavy 衰减。
   * replace：硬停旧环再开（转管 steal）；stopLoop 会作废仍在 await 的旧 start。
   */
  async function startLoop(url, opts = {}) {
    if (!url) return;
    const key = opts.key || url;
    if (opts.replace) {
      stopLoop(key, { fadeOut: 0 });
    } else if (loops.has(key) || loopStarting.has(key)) {
      return;
    }
    const gen = loopCancelGen.get(key) || 0;
    loopStarting.add(key);
    try {
      if (!unlocked || !ctx) await unlock();
      if (ctx.state === 'suspended') await ctx.resume();
      if ((loopCancelGen.get(key) || 0) !== gen || loops.has(key)) return;
      const buffer = await load(url);
      if (
        !buffer ||
        !ctx ||
        (loopCancelGen.get(key) || 0) !== gen ||
        loops.has(key)
      ) {
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      const baseVol = Math.max(0, Math.min(1, opts.volume ?? 0.4));
      /* 允许 0 增益开环：听者稍后进同车厢时由 updateLoop 拉高。 */
      const spatial = spatialMulFromOpts(opts);
      const volume = Math.max(0, Math.min(1, baseVol * spatial));
      const fadeIn = Math.max(0, opts.fadeIn ?? 0.08);
      const now = ctx.currentTime;
      gain.gain.value = 0;
      if (fadeIn > 0 && volume > 0) {
        gain.gain.linearRampToValueAtTime(volume, now + fadeIn);
      } else {
        gain.gain.value = volume;
      }
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      loops.set(key, {
        source,
        gain,
        volume: baseVol,
        url,
        x: opts.x ?? null,
        y: opts.y ?? null,
        heavy: Boolean(opts.heavy),
        ambient: Boolean(opts.ambient) || (opts.x == null && opts.y == null),
      });
    } catch (err) {
      console.warn('[lp-sfx] startLoop', err);
    } finally {
      if ((loopCancelGen.get(key) || 0) === gen) {
        loopStarting.delete(key);
      }
    }
  }

  /**
   * 更新循环空间增益（听者移动 / 声源位移时每帧可调）。
   * @param {string} key
   * @param {{ x?: number, y?: number, volume?: number, heavy?: boolean, ambient?: boolean }} [opts]
   */
  function updateLoop(key, opts = {}) {
    if (!key || !ctx) return;
    const entry = loops.get(key);
    if (!entry) return;
    if (opts.volume != null) {
      entry.volume = Math.max(0, Math.min(1, opts.volume));
    }
    if (opts.x != null) entry.x = opts.x;
    if (opts.y != null) entry.y = opts.y;
    if (opts.heavy != null) entry.heavy = Boolean(opts.heavy);
    if (opts.ambient != null) entry.ambient = Boolean(opts.ambient);
    const spatial = spatialMulFromOpts({
      ambient: entry.ambient,
      heavy: entry.heavy,
      x: entry.x ?? undefined,
      y: entry.y ?? undefined,
    });
    const target = Math.max(0, Math.min(1, entry.volume * spatial));
    try {
      const now = ctx.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(target, now);
    } catch (err) {
      console.warn('[lp-sfx] updateLoop', err);
    }
  }

  /**
   * 淡出并停止循环；未在播则无操作。key 为 startLoop 的 opts.key 或 url。
   * @param {string} key
   * @param {{ fadeOut?: number }} [opts]
   * fadeOut 秒。
   */
  function stopLoop(key, opts = {}) {
    if (!key) return;
    loopCancelGen.set(key, (loopCancelGen.get(key) || 0) + 1);
    loopStarting.delete(key);
    if (!ctx) return;
    const entry = loops.get(key);
    if (!entry) return;
    loops.delete(key);
    const fadeOut = Math.max(0, opts.fadeOut ?? 0.12);
    const now = ctx.currentTime;
    try {
      entry.gain.gain.cancelScheduledValues(now);
      const cur = entry.gain.gain.value;
      entry.gain.gain.setValueAtTime(cur, now);
      if (fadeOut > 0) {
        entry.gain.gain.linearRampToValueAtTime(0, now + fadeOut);
        const stopAt = now + fadeOut + 0.02;
        entry.source.stop(stopAt);
        window.setTimeout(() => disposeLoopEntry(entry), (fadeOut + 0.05) * 1000);
      } else {
        disposeLoopEntry(entry);
      }
    } catch (err) {
      console.warn('[lp-sfx] stopLoop', err);
      disposeLoopEntry(entry);
    }
  }

  /** 某 key（或 url）循环是否正在播。 */
  function isLooping(key) {
    return Boolean(key && loops.has(key));
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
    startLoop,
    updateLoop,
    stopLoop,
    stopOneShot,
    isLooping,
    preload,
    suspend,
    resume,
    /** @internal 测试/调试用 */
    distanceMul,
    heavyDistanceMul,
    falloffGain,
    sameCarriage,
    REF_DIST,
    MAX_DIST,
    FALLOFF_EXP,
    HEAVY_REF_DIST,
    HEAVY_MAX_DIST,
    HEAVY_FALLOFF_EXP,
  };
})();
