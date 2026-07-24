/**
 * 月台工厂环境音：接近月台时随距离渐强，停靠后满音；列车上也可听见。
 * 走独立 AudioContext（同 LpTrainAudio），不经 LpSfx 叠播。
 *
 * 音量：
 * - distanceAhead > PLATFORM_AHEAD → 0
 * - 接近中：1 - dist/AHEAD（线性）
 * - atPlatform 或月台场景 → 1
 */
(() => {
  const SRC =
    '/static/games/liminal-platform/audio/platform-factory-ambience.mp3?v=1';
  /** 软环境层；低于行驶样本峰值，避免压过火车/汽笛。 */
  const MAX_VOLUME = 0.28;
  const FADE_RATE = 1.6;
  /** 解码后尾→头 equal-power 交叉，盖住 MP3 接点。 */
  const LOOP_CROSSFADE_SEC = 0.18;

  let ctx = null;
  let masterGain = null;
  let loopBuffer = null;
  let source = null;
  let unlocked = false;
  let ambientOn = false;
  let targetVolume = 0;
  let currentVolume = 0;

  /**
   * 玩家「在月台场景」stub。null = 自动读 LpPlatform.getScene。
   * @type {boolean|null}
   */
  let playerOnPlatformStub = null;

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
   * 本地是否在月台场景（车外站台）。
   * stub 优先；否则读 LpPlatform。
   * @returns {boolean}
   */
  function isLocalPlayerOnPlatform() {
    if (playerOnPlatformStub != null) return Boolean(playerOnPlatformStub);
    return window.LpPlatform?.getScene?.() === 'platform';
  }

  /**
   * 调试写入「玩家是否在月台场景」。传 null 清除强制。
   * @param {boolean|null} onPlatform
   */
  function setPlayerOnPlatformStub(onPlatform) {
    if (onPlatform == null) {
      playerOnPlatformStub = null;
      return;
    }
    playerOnPlatformStub = Boolean(onPlatform);
  }

  /** 列车是否已停靠。 */
  function isTrainDockedAtPlatform() {
    const s = window.LpAutoSensors;
    if (!s?.getPlatformSensor) return false;
    return Boolean(s.getPlatformSensor().atPlatform);
  }

  /**
   * 按距月台距离得到 0…1 环境增益（列车上也可听）。
   * @returns {number}
   */
  function approachGain() {
    if (isLocalPlayerOnPlatform()) return 1;
    const s = window.LpAutoSensors?.getPlatformSensor?.();
    if (!s) return 0;
    if (s.atPlatform) return 1;
    const d = s.distanceAhead;
    if (d == null || !Number.isFinite(Number(d))) return 0;
    const ahead =
      Number(window.LpAutoSensors?.PLATFORM_AHEAD_DIST) > 0
        ? Number(window.LpAutoSensors.PLATFORM_AHEAD_DIST)
        : 800;
    const dist = Math.max(0, Number(d));
    if (dist >= ahead) return 0;
    return Math.max(0, Math.min(1, 1 - dist / ahead));
  }

  /** 是否应出声（接近或停靠/在月台时增益 > 0）。 */
  function shouldPlay() {
    return approachGain() > 0.001;
  }

  /** 按接近增益刷新目标音量。 */
  function refreshTarget() {
    targetVolume = ambientOn ? approachGain() : 0;
  }

  /** 首次交互后解锁 AudioContext、解码并做无缝循环缓冲。 */
  async function unlock() {
    if (unlocked) {
      if (ctx?.state === 'suspended') await ctx.resume();
      return;
    }
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);
    const response = await fetch(SRC);
    if (!response.ok) throw new Error('platform ambience fetch failed');
    const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
    loopBuffer = makeSeamlessLoopBuffer(decoded, LOOP_CROSSFADE_SEC);
    unlocked = true;
    refreshTarget();
  }

  /** 确保唯一循环源在播（不叠多实例）。 */
  function ensureSource() {
    if (!unlocked || !loopBuffer || source) return;
    source = ctx.createBufferSource();
    source.buffer = loopBuffer;
    source.loop = true;
    source.connect(masterGain);
    source.start(0);
  }

  /** 停止并断开循环源。 */
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
  }

  /** 淡到静音后停源，避免空转。 */
  function stopSourceIfSilent() {
    if (currentVolume > 0.001 || targetVolume > 0) return;
    killSource();
  }

  /**
   * 场景级开关（进关后 true）；真正出声看接近增益。
   * @param {boolean} on
   */
  function setAmbient(on) {
    ambientOn = Boolean(on);
    refreshTarget();
  }

  /** 每帧按距离淡入淡出；需要时启停唯一循环源。 */
  function tick(dt) {
    if (!unlocked) return;
    refreshTarget();
    if (targetVolume > 0.001 || currentVolume > 0.001) {
      ensureSource();
    }
    const step = FADE_RATE * Math.max(0, Number(dt) || 0);
    if (currentVolume < targetVolume) {
      currentVolume = Math.min(targetVolume, currentVolume + step);
    } else {
      currentVolume = Math.max(targetVolume, currentVolume - step);
    }
    const now = ctx.currentTime;
    masterGain.gain.setTargetAtTime(currentVolume * MAX_VOLUME, now, 0.08);
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

  window.LpPlatformAmbience = {
    unlock,
    setAmbient,
    tick,
    suspend,
    resume,
    shouldPlay,
    approachGain,
    isTrainDockedAtPlatform,
    isLocalPlayerOnPlatform,
    setPlayerOnPlatformStub,
    SRC,
  };
})();
