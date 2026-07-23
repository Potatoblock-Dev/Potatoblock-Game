/**
 * 汽笛三段式音效：引入 → 循环 → 引出。
 * intro 结束时刻开 loop；loop 用双源重叠 crossfade 消除 AAC 接缝；松手播 outro；关面板硬停。
 */
(() => {
  const INTRO_SRC = '/static/games/liminal-platform/audio/train-whistle-intro.m4a?v=1';
  const LOOP_SRC = '/static/games/liminal-platform/audio/train-whistle-loop.m4a?v=1';
  const OUTRO_SRC = '/static/games/liminal-platform/audio/train-whistle-outro.m4a?v=1';
  const VOLUME = 0.72;
  /** loop→loop 重叠 crossfade（秒）；盖住 AAC 编解码接缝。 */
  const LOOP_CROSSFADE_SEC = 0.07;
  const LOOP_LOOKAHEAD_SEC = 1.25;
  const FADE_CURVE_STEPS = 32;

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
  let outroSrc = null;
  /** @type {{ src: AudioBufferSourceNode, gain: GainNode }[]} */
  let loopParts = [];
  /** @type {number|null} */
  let loopStartAt = null;
  /** @type {number|null} */
  let loopNextAt = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let loopPumpTimer = null;
  let loopEpoch = 0;
  let loopFirstSegment = true;
  let holdWanted = false;
  /** @type {Promise<void>|null} */
  let loadPromise = null;
  let startInFlight = false;

  /** @type {Float32Array|null} */
  let fadeInCurve = null;
  /** @type {Float32Array|null} */
  let fadeOutCurve = null;

  /** 构建等功率淡入/淡出曲线（复用，避免每段分配）。 */
  function ensureFadeCurves() {
    if (fadeInCurve && fadeOutCurve) return;
    fadeInCurve = new Float32Array(FADE_CURVE_STEPS);
    fadeOutCurve = new Float32Array(FADE_CURVE_STEPS);
    for (let i = 0; i < FADE_CURVE_STEPS; i++) {
      const t = i / (FADE_CURVE_STEPS - 1);
      fadeInCurve[i] = Math.sin(t * Math.PI * 0.5);
      fadeOutCurve[i] = Math.cos(t * Math.PI * 0.5);
    }
  }

  /** 停止并断开单个 BufferSource（忽略已停错误）。 */
  function killSource(src) {
    if (!src) return;
    try {
      src.onended = null;
    } catch (_) {
      /* noop */
    }
    try {
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

  /** 取消 loop 前瞻调度并停掉所有 loop 分段源。 */
  function clearLoopChain() {
    loopEpoch += 1;
    if (loopPumpTimer != null) {
      clearTimeout(loopPumpTimer);
      loopPumpTimer = null;
    }
    loopNextAt = null;
    loopFirstSegment = true;
    for (const part of loopParts) {
      killSource(part.src);
      try {
        part.gain.disconnect();
      } catch (_) {
        /* already disconnected */
      }
    }
    loopParts = [];
  }

  /** 停掉所有正在播 / 已调度的汽笛源。 */
  function killAllSources() {
    killSource(introSrc);
    clearLoopChain();
    killSource(outroSrc);
    introSrc = null;
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
      ensureFadeCurves();
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

  /** 创建已接好增益的 BufferSource（非 loop 链用）。 */
  function makeSource(buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = false;
    src.connect(gain);
    return src;
  }

  /** 当前 loop 重叠时长与周期（秒）。 */
  function loopTiming() {
    const dur = loopBuf.duration;
    const xfade = Math.min(LOOP_CROSSFADE_SEC, dur * 0.35);
    return { dur, xfade, period: dur - xfade };
  }

  /**
   * 调度一段非循环 loop buffer；fadeIn 时与上一段等功率交叉。
   * @param {number} when AudioContext 时间
   * @param {boolean} fadeIn 是否淡入（首段接 intro 时为 false）
   */
  function spawnLoopSegment(when, fadeIn) {
    const { dur, xfade } = loopTiming();
    const src = ctx.createBufferSource();
    src.buffer = loopBuf;
    src.loop = false;
    const g = ctx.createGain();
    g.connect(gain);
    src.connect(g);

    if (fadeIn) {
      g.gain.setValueCurveAtTime(fadeInCurve, when, xfade);
    } else {
      g.gain.setValueAtTime(1, when);
    }
    const fadeOutAt = when + dur - xfade;
    g.gain.setValueCurveAtTime(fadeOutCurve, fadeOutAt, xfade);

    src.start(when);
    src.stop(when + dur + 0.02);

    const part = { src, gain: g };
    loopParts.push(part);
    src.onended = () => {
      const idx = loopParts.indexOf(part);
      if (idx >= 0) loopParts.splice(idx, 1);
      try {
        g.disconnect();
      } catch (_) {
        /* noop */
      }
    };
  }

  /** 前瞻调度 loop 分段，用重叠 crossfade 代替 BufferSource.loop。 */
  function startLoopChain(startAt) {
    clearLoopChain();
    const epoch = loopEpoch;
    const { xfade, period } = loopTiming();
    loopNextAt = startAt;
    loopFirstSegment = true;

    function pump() {
      if (epoch !== loopEpoch || !holdWanted || !loopBuf) return;
      const now = ctx.currentTime;
      const horizon = now + LOOP_LOOKAHEAD_SEC;
      while (loopNextAt != null && loopNextAt <= horizon) {
        spawnLoopSegment(loopNextAt, !loopFirstSegment);
        loopFirstSegment = false;
        loopNextAt += period;
      }
      const delayMs = Math.max(
        40,
        Math.min(350, (loopNextAt - xfade - now) * 1000 - 180),
      );
      loopPumpTimer = setTimeout(pump, delayMs);
    }

    pump();
  }

  /**
   * 下拉过阈值：播 intro，并在其结束时刻调度无缝 loop 链（仍按住时）。
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
      introSrc = makeSource(introBuf);
      loopStartAt = t0 + introBuf.duration;
      introSrc.start(t0);
      startLoopChain(loopStartAt);
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
    clearLoopChain();
    introSrc = null;
    loopStartAt = null;
    killSource(outroSrc);
    outroSrc = makeSource(outroBuf);
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
