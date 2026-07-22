/**
 * 火车行驶音：仅在列车实际开动（有速度）时播放，停车淡出。
 */
(() => {
  const SRC = '/static/games/liminal-platform/audio/train-move-loop.m4a?v=2';
  const MAX_VOLUME = 0.38;
  const MOVE_THRESHOLD = 0.04;
  const FADE_RATE = 2.8;

  let ctx = null;
  let gain = null;
  let buffer = null;
  let source = null;
  let unlocked = false;
  let ambientOn = false;
  let driveIntensity = 0;
  let targetVolume = 0;
  let currentVolume = 0;

  /** 根据环境开关与行驶强度刷新目标音量（静止为 0）。 */
  function refreshTarget() {
    if (!ambientOn || driveIntensity < MOVE_THRESHOLD) {
      targetVolume = 0;
      return;
    }
    const t = (driveIntensity - MOVE_THRESHOLD) / (1 - MOVE_THRESHOLD);
    targetVolume = MAX_VOLUME * Math.max(0, Math.min(1, t));
  }

  /** 首次交互后解锁 AudioContext（浏览器策略）。 */
  async function unlock() {
    if (unlocked) return;
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const response = await fetch(SRC);
    if (!response.ok) throw new Error('train audio fetch failed');
    buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    unlocked = true;
    refreshTarget();
  }

  /** 确保循环源在播放。 */
  function ensureSource() {
    if (!unlocked || !buffer || source) return;
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start(0);
  }

  /** 音量已淡到静音时停掉源，避免空转循环。 */
  function stopSourceIfSilent() {
    if (!source || currentVolume > 0.001 || targetVolume > 0) return;
    try {
      source.stop(0);
    } catch (_) {
      /* already stopped */
    }
    source.disconnect();
    source = null;
  }

  /** 开关列车环境音通道（场景激活后开启；真正出声仍看速度）。 */
  function setAmbient(on) {
    ambientOn = Boolean(on);
    refreshTarget();
  }

  /** 设置行驶强度 0~1（由 LpTrainDrive 按实际速度驱动）。 */
  function setDriveIntensity(intensity) {
    driveIntensity = Math.max(0, Math.min(1, Number(intensity) || 0));
    refreshTarget();
  }

  /** @deprecated 旧走路绑定；保留空实现。 */
  function setMoving(_moving) {}

  /** 每帧更新音量淡入淡出。 */
  function tick(dt) {
    if (!unlocked) return;
    if (targetVolume > 0.001 || currentVolume > 0.001) ensureSource();
    if (currentVolume < targetVolume) {
      currentVolume = Math.min(targetVolume, currentVolume + FADE_RATE * dt);
    } else {
      currentVolume = Math.max(targetVolume, currentVolume - FADE_RATE * dt);
    }
    gain.gain.setTargetAtTime(currentVolume, ctx.currentTime, 0.08);
    stopSourceIfSilent();
  }

  /** 切后台时暂停音频上下文。 */
  function suspend() {
    if (ctx?.state === 'running') ctx.suspend();
  }

  /** 回前台时恢复。 */
  async function resume() {
    if (ctx?.state === 'suspended') await ctx.resume();
  }

  window.LpTrainAudio = {
    unlock,
    setAmbient,
    setDriveIntensity,
    setMoving,
    tick,
    suspend,
    resume,
  };
})();
