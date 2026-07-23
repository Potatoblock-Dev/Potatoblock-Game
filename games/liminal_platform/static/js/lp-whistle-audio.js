/**
 * 汽笛三段式音效：引入 → 循环 → 引出。
 * Web Audio 调度 intro 结束时刻无缝开 loop；松手停 loop 播 outro；关面板硬停。
 */
(() => {
  const INTRO_SRC = '/static/games/liminal-platform/audio/train-whistle-intro.m4a?v=1';
  const LOOP_SRC = '/static/games/liminal-platform/audio/train-whistle-loop.m4a?v=1';
  const OUTRO_SRC = '/static/games/liminal-platform/audio/train-whistle-outro.m4a?v=1';
  const VOLUME = 0.72;

  /** @type {'idle'|'intro'|'loop'|'outro'} */
  let phase = 'idle';
  let ctx = null;
  let gain = null;
  let unlocked = false;
  /** @type {AudioBuffer|null} */
  let introBuf = null;
  /** @type {AudioBuffer|null} */
  let loopBuf = null;
  /** @type {AudioBuffer|null} */
  let outroBuf = null;
  /** @type {AudioBufferSourceNode|null} */
  let introSrc = null;
  /** @type {AudioBufferSourceNode|null} */
  let loopSrc = null;
  /** @type {AudioBufferSourceNode|null} */
  let outroSrc = null;
  /** @type {number|null} */
  let loopStartAt = null;
  let holdWanted = false;
  /** @type {Promise<void>|null} */
  let loadPromise = null;
  let startInFlight = false;

  /** 停止并断开单个 BufferSource（忽略已停错误）。 */
  function killSource(src) {
    if (!src) return;
    try {
      src.onended = null;
      src.stop(0);
    } catch (_) {
      /* already stopped */
    }
    try {
      src.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  }

  /** 停掉所有正在播 / 已调度的汽笛源。 */
  function killAllSources() {
    killSource(introSrc);
    killSource(loopSrc);
    killSource(outroSrc);
    introSrc = null;
    loopSrc = null;
    outroSrc = null;
    loopStartAt = null;
  }

  /** 首次手势解锁 AudioContext 并预解码三段缓冲。 */
  async function unlock() {
    if (!ctx) {
      ctx = new AudioContext();
      gain = ctx.createGain();
      gain.gain.value = VOLUME;
      gain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') await ctx.resume();
    if (!loadPromise) {
      loadPromise = (async () => {
        const [i, l, o] = await Promise.all([
          fetch(INTRO_SRC).then((r) => {
            if (!r.ok) throw new Error('whistle intro fetch');
            return r.arrayBuffer();
          }),
          fetch(LOOP_SRC).then((r) => {
            if (!r.ok) throw new Error('whistle loop fetch');
            return r.arrayBuffer();
          }),
          fetch(OUTRO_SRC).then((r) => {
            if (!r.ok) throw new Error('whistle outro fetch');
            return r.arrayBuffer();
          }),
        ]);
        introBuf = await ctx.decodeAudioData(i.slice(0));
        loopBuf = await ctx.decodeAudioData(l.slice(0));
        outroBuf = await ctx.decodeAudioData(o.slice(0));
        unlocked = true;
      })().catch((err) => {
        console.warn('[lp-whistle] load', err);
        loadPromise = null;
      });
    }
    await loadPromise;
  }

  /** 创建已接好增益的 BufferSource。 */
  function makeSource(buffer, loop) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = Boolean(loop);
    src.connect(gain);
    return src;
  }

  /**
   * 下拉过阈值：播 intro，并在其结束时刻调度无缝 loop（仍按住时）。
   * 重复调用在已发声时忽略。
   */
  async function start() {
    holdWanted = true;
    if (phase === 'intro' || phase === 'loop' || startInFlight) return;
    startInFlight = true;
    try {
      await unlock();
      if (!holdWanted || !unlocked || !introBuf || !loopBuf) return;
      if (phase === 'intro' || phase === 'loop') return;
      if (phase === 'outro') {
        killSource(outroSrc);
        outroSrc = null;
      }
      killAllSources();
      const t0 = ctx.currentTime;
      introSrc = makeSource(introBuf, false);
      loopSrc = makeSource(loopBuf, true);
      loopStartAt = t0 + introBuf.duration;
      introSrc.start(t0);
      loopSrc.start(loopStartAt);
      phase = 'intro';
      introSrc.onended = () => {
        if (!holdWanted) return;
        if (phase === 'intro') phase = 'loop';
      };
    } catch (err) {
      console.warn('[lp-whistle] unlock', err);
    } finally {
      startInFlight = false;
    }
  }

  /** 松手：取消 loop，立即播 outro；未发声则保持静音。 */
  function release() {
    holdWanted = false;
    if (phase === 'idle' || phase === 'outro') return;
    if (!ctx || !outroBuf) {
      killAllSources();
      phase = 'idle';
      return;
    }
    const now = ctx.currentTime;
    killSource(introSrc);
    killSource(loopSrc);
    introSrc = null;
    loopSrc = null;
    loopStartAt = null;
    killSource(outroSrc);
    outroSrc = makeSource(outroBuf, false);
    outroSrc.onended = () => {
      if (outroSrc) {
        try {
          outroSrc.disconnect();
        } catch (_) {
          /* noop */
        }
      }
      outroSrc = null;
      if (phase === 'outro') phase = 'idle';
    };
    outroSrc.start(now);
    phase = 'outro';
  }

  /** 关驾驶台等：立刻静音，不播 outro。 */
  function stop() {
    holdWanted = false;
    killAllSources();
    phase = 'idle';
  }

  /** 当前是否处于引入/循环发声（UI「鸣」态）。 */
  function isSounding() {
    return phase === 'intro' || phase === 'loop';
  }

  /** 切后台暂停。 */
  function suspend() {
    if (ctx?.state === 'running') ctx.suspend();
  }

  /** 回前台恢复。 */
  async function resume() {
    if (ctx?.state === 'suspended') await ctx.resume();
  }

  window.LpWhistleAudio = {
    unlock,
    start,
    release,
    stop,
    isSounding,
    suspend,
    resume,
  };
})();
