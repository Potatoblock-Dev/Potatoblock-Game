/**
 * 月台停靠平静 BGM：抵达月台后随机一首，仅在「月台场景 + 未战斗」时循环。
 * 与 LpPlatformAmbience（工厂环境床）独立；启停一律经 fadeIn/fadeOut（~1.2s）。
 *
 * 原曲映射见 static/audio/dock-music.README.txt。
 */
(() => {
  const TRACKS = [
    {
      id: 'anchor',
      src: '/static/games/liminal-platform/audio/dock-anchor.mp3?v=1',
      label: '动摇的锚点',
    },
    {
      id: 'passby',
      src: '/static/games/liminal-platform/audio/dock-passby.mp3?v=1',
      label: '经过',
    },
  ];
  /** 平静层；低于工厂环境床峰值，避免压过交互 SFX。 */
  const MAX_VOLUME = 0.22;
  /** 默认渐入/渐出时长（秒）；启停 API 的一等公民参数。 */
  const DEFAULT_FADE_SEC = 1.2;
  const FADE_SEC_MIN = 0.8;
  const FADE_SEC_MAX = 1.5;
  /** 开火后短时视为战斗，避免「刚开枪音乐立刻抢回来」。 */
  const FIRE_COMBAT_MS = 1800;
  /** 解码后尾→头 equal-power 交叉，盖住 MP3 循环接点。 */
  const LOOP_CROSSFADE_SEC = 0.2;

  let ctx = null;
  let masterGain = null;
  /** @type {Map<string, AudioBuffer>} */
  const buffers = new Map();
  let source = null;
  /** 当前 BufferSource 对应的曲目 id。 */
  let sourceTrackId = null;
  let unlocked = false;
  let musicOn = false;
  /** 本趟停靠已抽中的曲目；离站清空。 */
  let visitTrack = null;
  let wasDocked = false;
  let targetVolume = 0;
  let currentVolume = 0;
  /** 当前渐变速率（音量单位/秒）= 1 / fadeSec。 */
  let fadeRate = 1 / DEFAULT_FADE_SEC;
  let lastWeaponFireAt = 0;

  /**
   * 将缓冲缩短并做尾→头 equal-power 交叉淡化，供 BufferSource.loop 无缝衔接。
   * @param {AudioBuffer} buffer
   * @param {number} fadeSec
   * @returns {AudioBuffer}
   */
  function makeSeamlessLoopBuffer(buffer, fadeSec) {
    const rate = buffer.sampleRate;
    const fade = Math.max(
      1,
      Math.min(Math.floor(fadeSec * rate), Math.floor(buffer.length / 4))
    );
    const outLen = buffer.length - fade;
    if (outLen < fade * 2) return buffer;
    const out = ctx.createBuffer(buffer.numberOfChannels, outLen, rate);
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const src = buffer.getChannelData(ch);
      const dst = out.getChannelData(ch);
      dst.set(src.subarray(0, outLen));
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        const a = Math.sin(t * Math.PI * 0.5);
        const b = Math.cos(t * Math.PI * 0.5);
        dst[i] = src[i] * a + src[buffer.length - fade + i] * b;
      }
    }
    return out;
  }

  /**
   * 钳制渐变时长到推荐区间；非法则回默认。
   * @param {number} [sec]
   * @returns {number}
   */
  function clampFadeSec(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_FADE_SEC;
    return Math.max(FADE_SEC_MIN, Math.min(FADE_SEC_MAX, n));
  }

  /**
   * 设置后续 tick 向目标音量渐变的速率（一等公民 fade API）。
   * @param {number} [fadeSec] 秒；默认 DEFAULT_FADE_SEC
   */
  function setFadeDuration(fadeSec) {
    fadeRate = 1 / clampFadeSec(fadeSec);
  }

  /**
   * 请求渐入到满平静音量（不硬切）；真正出声仍看 shouldPlay / tick。
   * @param {number} [fadeSec]
   */
  function fadeIn(fadeSec) {
    setFadeDuration(fadeSec);
    targetVolume = 1;
  }

  /**
   * 请求渐出到静音（不硬切）；静音后 tick 会停源。
   * @param {number} [fadeSec]
   */
  function fadeOut(fadeSec) {
    setFadeDuration(fadeSec);
    targetVolume = 0;
  }

  /** 本地是否在月台场景（车外）。 */
  function isLocalPlayerOnPlatform() {
    return window.LpPlatform?.getScene?.() === 'platform';
  }

  /** 列车是否已停靠。 */
  function isTrainDocked() {
    return Boolean(window.LpPlatform?.isAtPlatform?.());
  }

  /**
   * 月台上是否处于战斗：有存活敌对，或近期开火。
   * @returns {boolean}
   */
  function isPlatformCombatActive() {
    const hostiles = window.LpMobs?.listHostiles?.();
    if (Array.isArray(hostiles) && hostiles.length > 0) return true;
    if (performance.now() - lastWeaponFireAt < FIRE_COMBAT_MS) return true;
    return false;
  }

  /**
   * 是否应播放平静 BGM（停靠 + 在月台 + 非战斗 + 通道开）。
   * @returns {boolean}
   */
  function shouldPlay() {
    return (
      musicOn &&
      isTrainDocked() &&
      isLocalPlayerOnPlatform() &&
      !isPlatformCombatActive() &&
      Boolean(visitTrack)
    );
  }

  /** 本趟停靠随机抽一首（每站一次，不每帧重抽）。 */
  function pickVisitTrack() {
    const i = Math.floor(Math.random() * TRACKS.length) % TRACKS.length;
    visitTrack = TRACKS[i];
  }

  /**
   * 跟停靠升降沿：进站抽曲，离站清曲并渐出。
   */
  function syncDockVisit() {
    const docked = isTrainDocked();
    if (docked && !wasDocked) {
      pickVisitTrack();
    } else if (docked && !visitTrack) {
      pickVisitTrack();
    } else if (!docked && wasDocked) {
      visitTrack = null;
      fadeOut();
    }
    wasDocked = docked;
  }

  /**
   * 按 shouldPlay 驱动目标音量（经 fadeIn/fadeOut 速率渐变）。
   */
  function refreshTarget() {
    if (shouldPlay()) {
      if (targetVolume < 1) fadeIn();
      return;
    }
    if (targetVolume > 0 || currentVolume > 0.001) fadeOut();
  }

  /**
   * 解码单曲为无缝循环缓冲。
   * @param {{ id: string, src: string }} track
   */
  async function decodeTrack(track) {
    const response = await fetch(track.src);
    if (!response.ok) throw new Error(`dock music fetch failed: ${track.id}`);
    const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
    buffers.set(track.id, makeSeamlessLoopBuffer(decoded, LOOP_CROSSFADE_SEC));
  }

  /** 首次交互后解锁 AudioContext 并预解码两首。 */
  async function unlock() {
    if (unlocked) {
      if (ctx?.state === 'suspended') await ctx.resume();
      return;
    }
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);
    await Promise.all(TRACKS.map((t) => decodeTrack(t)));
    unlocked = true;
    setFadeDuration(DEFAULT_FADE_SEC);
    syncDockVisit();
    refreshTarget();
  }

  /** 停止并断开当前循环源。 */
  function killSource() {
    if (!source) return;
    try {
      source.stop(0);
    } catch (_) {
      /* already stopped */
    }
    try {
      source.disconnect();
    } catch (_) {
      /* already disconnected */
    }
    source = null;
    sourceTrackId = null;
  }

  /**
   * 确保当前 visitTrack 的唯一循环源在播；换曲则先停再建。
   */
  function ensureSource() {
    if (!unlocked || !visitTrack) return;
    const buf = buffers.get(visitTrack.id);
    if (!buf) return;
    if (source && sourceTrackId === visitTrack.id) return;
    killSource();
    source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    source.connect(masterGain);
    source.start(0);
    sourceTrackId = visitTrack.id;
  }

  /** 淡到静音后停源，避免空转。 */
  function stopSourceIfSilent() {
    if (currentVolume > 0.001 || targetVolume > 0) return;
    killSource();
  }

  /**
   * 场景级开关；true 后仍须 shouldPlay 才渐入。
   * @param {boolean} on
   */
  function setMusic(on) {
    musicOn = Boolean(on);
    refreshTarget();
  }

  /**
   * 每帧：同步停靠抽曲、刷新目标、按 fadeRate 渐变音量。
   * @param {number} dt
   */
  function tick(dt) {
    if (!unlocked) return;
    syncDockVisit();
    refreshTarget();
    if (targetVolume > 0.001 || currentVolume > 0.001) {
      ensureSource();
    }
    const step = fadeRate * Math.max(0, Number(dt) || 0);
    if (currentVolume < targetVolume) {
      currentVolume = Math.min(targetVolume, currentVolume + step);
    } else {
      currentVolume = Math.max(targetVolume, currentVolume - step);
    }
    const now = ctx.currentTime;
    masterGain.gain.setTargetAtTime(currentVolume * MAX_VOLUME, now, 0.05);
    stopSourceIfSilent();
  }

  /** 切后台暂停。 */
  function suspend() {
    if (ctx?.state === 'running') ctx.suspend();
  }

  /** 回前台恢复。 */
  async function resume() {
    if (ctx?.state === 'suspended') await ctx.resume();
  }

  /** 记录开火时刻，供战斗闩门。 */
  function onWeaponFired() {
    lastWeaponFireAt = performance.now();
    refreshTarget();
  }

  window.addEventListener('lp:weapon-fired', onWeaponFired);
  window.addEventListener('liminal:platform-depart', () => {
    visitTrack = null;
    wasDocked = false;
    fadeOut();
  });
  window.addEventListener('liminal:platform-scene', () => {
    refreshTarget();
  });

  window.LpPlatformDockMusic = {
    unlock,
    setMusic,
    tick,
    suspend,
    resume,
    shouldPlay,
    isPlatformCombatActive,
    fadeIn,
    fadeOut,
    setFadeDuration,
    DEFAULT_FADE_SEC,
    TRACKS,
    /** 调试：当前停靠曲目 id / null。 */
    getVisitTrackId: () => visitTrack?.id ?? null,
  };
})();
