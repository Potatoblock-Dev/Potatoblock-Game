/**
 * 火车行驶音：样本循环（解码后二次交叉淡化）+ 低频 rumble 层；
 * 按速度淡入淡出与轻量变调。与 LpWhistleAudio 独立，互不影响。
 */
(() => {
  const SRC = '/static/games/liminal-platform/audio/train-move-loop.m4a?v=3';
  const MAX_MOVE_VOLUME = 0.34;
  const MAX_RUMBLE_VOLUME = 0.2;
  const MOVE_THRESHOLD = 0.04;
  const FADE_RATE = 2.4;
  /** 解码后对 PCM 再做 overlap-add，盖住 AAC 接点残差。 */
  const LOOP_CROSSFADE_SEC = 0.14;
  const PITCH_MIN = 0.93;
  const PITCH_MAX = 1.07;
  const RUMBLE_NOISE_SEC = 2.5;
  const RUMBLE_FILTER_HZ = 72;
  const RUMBLE_OSC_HZ = 48;

  let ctx = null;
  let masterGain = null;
  let moveGain = null;
  let rumbleGain = null;
  let moveBuffer = null;
  let rumbleNoiseBuffer = null;
  let moveSource = null;
  let rumbleNoiseSource = null;
  let rumbleOsc = null;
  let rumbleFilter = null;
  let unlocked = false;
  let ambientOn = false;
  let driveIntensity = 0;
  let targetVolume = 0;
  let currentVolume = 0;
  let targetPitch = 1;
  let currentPitch = 1;

  /**
   * 将缓冲缩短并做尾→头 equal-power 交叉淡化，供 BufferSource.loop 无缝衔接。
   * @param {AudioBuffer} buffer
   * @param {number} fadeSec
   * @returns {AudioBuffer}
   */
  function makeSeamlessLoopBuffer(buffer, fadeSec) {
    const rate = buffer.sampleRate;
    const fade = Math.max(1, Math.min(Math.floor(fadeSec * rate), Math.floor(buffer.length / 4)));
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

  /** 生成棕噪（积分白噪）循环缓冲，供 rumble 层滤波。 */
  function createBrownNoiseBuffer(seconds) {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + white * 0.02) * 0.998;
      data[i] = last * 3.5;
    }
    // 首尾微交叉，避免棕噪自身接点咔哒
    const fade = Math.min(256, Math.floor(length / 8));
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      data[i] = data[i] * t + data[length - fade + i] * (1 - t);
    }
    return buf;
  }

  /** 根据环境开关与行驶强度刷新目标音量与变调（静止为 0）。 */
  function refreshTarget() {
    if (!ambientOn || driveIntensity < MOVE_THRESHOLD) {
      targetVolume = 0;
      targetPitch = PITCH_MIN;
      return;
    }
    const t = (driveIntensity - MOVE_THRESHOLD) / (1 - MOVE_THRESHOLD);
    const u = Math.max(0, Math.min(1, t));
    targetVolume = u;
    targetPitch = PITCH_MIN + (PITCH_MAX - PITCH_MIN) * u;
  }

  /** 首次交互后解锁 AudioContext、解码行驶循环并搭好 rumble 图。 */
  async function unlock() {
    if (unlocked) return;
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = 1;
    masterGain.connect(ctx.destination);

    moveGain = ctx.createGain();
    moveGain.gain.value = 0;
    moveGain.connect(masterGain);

    rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = 'lowpass';
    rumbleFilter.frequency.value = RUMBLE_FILTER_HZ;
    rumbleFilter.Q.value = 0.7;
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(masterGain);

    const response = await fetch(SRC);
    if (!response.ok) throw new Error('train audio fetch failed');
    const decoded = await ctx.decodeAudioData(await response.arrayBuffer());
    moveBuffer = makeSeamlessLoopBuffer(decoded, LOOP_CROSSFADE_SEC);
    rumbleNoiseBuffer = createBrownNoiseBuffer(RUMBLE_NOISE_SEC);
    unlocked = true;
    refreshTarget();
  }

  /** 启动行驶样本循环源。 */
  function ensureMoveSource() {
    if (!unlocked || !moveBuffer || moveSource) return;
    moveSource = ctx.createBufferSource();
    moveSource.buffer = moveBuffer;
    moveSource.loop = true;
    moveSource.playbackRate.value = currentPitch;
    moveSource.connect(moveGain);
    moveSource.start(0);
  }

  /** 启动棕噪 + 低频振荡的 rumble 层。 */
  function ensureRumbleSources() {
    if (!unlocked || !rumbleNoiseBuffer) return;
    if (!rumbleNoiseSource) {
      rumbleNoiseSource = ctx.createBufferSource();
      rumbleNoiseSource.buffer = rumbleNoiseBuffer;
      rumbleNoiseSource.loop = true;
      rumbleNoiseSource.playbackRate.value = currentPitch;
      rumbleNoiseSource.connect(rumbleFilter);
      rumbleNoiseSource.start(0);
    }
    if (!rumbleOsc) {
      rumbleOsc = ctx.createOscillator();
      rumbleOsc.type = 'sine';
      rumbleOsc.frequency.value = RUMBLE_OSC_HZ;
      const oscGain = ctx.createGain();
      oscGain.gain.value = 0.35;
      rumbleOsc.connect(oscGain);
      oscGain.connect(rumbleFilter);
      rumbleOsc.start(0);
    }
  }

  /** 停止并断开单个 BufferSource / Oscillator。 */
  function killNode(node) {
    if (!node) return;
    try {
      node.stop(0);
    } catch (_) {
      /* already stopped */
    }
    try {
      node.disconnect();
    } catch (_) {
      /* already disconnected */
    }
  }

  /** 音量已淡到静音时停掉全部源，避免空转。 */
  function stopSourcesIfSilent() {
    if (currentVolume > 0.001 || targetVolume > 0) return;
    killNode(moveSource);
    killNode(rumbleNoiseSource);
    killNode(rumbleOsc);
    moveSource = null;
    rumbleNoiseSource = null;
    rumbleOsc = null;
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

  /** 每帧更新音量淡入淡出、变调与 rumble 比例。 */
  function tick(dt) {
    if (!unlocked) return;
    if (targetVolume > 0.001 || currentVolume > 0.001) {
      ensureMoveSource();
      ensureRumbleSources();
    }
    if (currentVolume < targetVolume) {
      currentVolume = Math.min(targetVolume, currentVolume + FADE_RATE * dt);
    } else {
      currentVolume = Math.max(targetVolume, currentVolume - FADE_RATE * dt);
    }
    if (currentPitch < targetPitch) {
      currentPitch = Math.min(targetPitch, currentPitch + FADE_RATE * 0.35 * dt);
    } else {
      currentPitch = Math.max(targetPitch, currentPitch - FADE_RATE * 0.35 * dt);
    }

    const moveVol = currentVolume * MAX_MOVE_VOLUME;
    // rumble 略晚于样本层起来，低速也有一点轰隆
    const rumbleVol = currentVolume * MAX_RUMBLE_VOLUME * (0.45 + 0.55 * currentVolume);
    const now = ctx.currentTime;
    moveGain.gain.setTargetAtTime(moveVol, now, 0.08);
    rumbleGain.gain.setTargetAtTime(rumbleVol, now, 0.1);

    if (moveSource) {
      moveSource.playbackRate.setTargetAtTime(currentPitch, now, 0.12);
    }
    if (rumbleNoiseSource) {
      rumbleNoiseSource.playbackRate.setTargetAtTime(currentPitch, now, 0.12);
    }
    if (rumbleOsc) {
      rumbleOsc.frequency.setTargetAtTime(
        RUMBLE_OSC_HZ * (0.92 + 0.16 * currentVolume),
        now,
        0.15
      );
    }
    stopSourcesIfSilent();
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
