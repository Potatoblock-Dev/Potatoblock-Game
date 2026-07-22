/**
 * 列车运行状态：节流拉杆档位 + 刹车拉杆，模拟速度。
 * 档位：-5 后退 … 0 停止 … +5 前进。
 * 急刹：仅拉杆到底触发，立即停车；松手后缓慢回弹。
 */
(() => {
  const THROTTLE_NOTCHES = [-5, -3, -1, 0, 1, 3, 5];
  const MAX_SPEED = 5;
  const ACCEL = 2.4;
  const COAST_DECEL = 0.55;
  const BRAKE_DECEL = 6.5;
  /** 达到此比例视为急刹位（拉杆底部）。 */
  const EMERGENCY_BRAKE = 0.95;
  /** 急刹松手后回弹速度（比例/秒）。 */
  const BRAKE_SPRING_RATE = 0.42;

  const state = {
    throttle: 0,
    brake: 0,
    speed: 0,
    brakeSpringing: false,
  };

  /** 最近档位。 */
  function nearestNotch(value) {
    let best = THROTTLE_NOTCHES[0];
    let bestDist = Math.abs(value - best);
    for (const notch of THROTTLE_NOTCHES) {
      const dist = Math.abs(value - notch);
      if (dist < bestDist) {
        best = notch;
        bestDist = dist;
      }
    }
    return best;
  }

  /** 是否处于急刹位。 */
  function isEmergencyBrake(brake = state.brake) {
    return brake >= EMERGENCY_BRAKE;
  }

  let localControl = false;
  let suppressNetwork = false;

  /** 用户正在拖拽拉杆时标记，避免快照覆盖手感。 */
  function setLocalControl(active) {
    localControl = Boolean(active);
  }

  /** 是否由本机操作拉杆。 */
  function isLocalControl() {
    return localControl;
  }

  /** 推送列车状态到联机（若已连接）。 */
  function pushNetwork() {
    if (suppressNetwork) return;
    window.LiminalNetworkSession?.sendTrain?.({
      throttle: state.throttle,
      brake: state.brake,
    });
  }

  /** 应用服务端共享列车状态（不回传）。 */
  function applyNetworkState(next = {}) {
    if (localControl) return;
    suppressNetwork = true;
    if (next.throttle != null) state.throttle = Number(next.throttle) || 0;
    if (next.brake != null) state.brake = Math.max(0, Math.min(1, Number(next.brake) || 0));
    if (next.speed != null) state.speed = Number(next.speed) || 0;
    if (isEmergencyBrake()) state.speed = 0;
    suppressNetwork = false;
    emit();
  }

  /** 设置节流档（自动吸附）。 */
  function setThrottle(value) {
    state.throttle = nearestNotch(Number(value) || 0);
    emit();
    pushNetwork();
  }

  /** 拖拽中临时设置（可不吸附）。 */
  function setThrottleRaw(value) {
    state.throttle = Math.max(-5, Math.min(5, Number(value) || 0));
    emit();
    pushNetwork();
  }

  /** 吸附当前节流到最近档。 */
  function snapThrottle() {
    state.throttle = nearestNotch(state.throttle);
    emit();
    pushNetwork();
  }

  /**
   * 设置刹车 0（松开）~ 1（拉满）。
   * 拉满时立即急停；中段为普通制动。
   */
  function setBrake(value, options = {}) {
    if (options.fromUser) state.brakeSpringing = false;
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    state.brake = next;
    if (isEmergencyBrake(next)) {
      state.speed = 0;
    }
    emit();
    pushNetwork();
  }

  /** 触发急刹并开始回弹（刻度按钮「急刹」）。 */
  function triggerEmergencyBrake() {
    state.brakeSpringing = false;
    state.brake = 1;
    state.speed = 0;
    state.brakeSpringing = true;
    emit();
    pushNetwork();
  }

  /** 松手：若在急刹位则开始缓慢回弹。 */
  function onBrakeReleased() {
    if (isEmergencyBrake()) {
      state.speed = 0;
      state.brakeSpringing = true;
      emit();
      pushNetwork();
    }
  }

  /** 档位文案。 */
  function throttleLabel(throttle = state.throttle) {
    const t = nearestNotch(throttle);
    if (t === 0) return '停止';
    if (t > 0) return `前进 ${t}`;
    return `后退 ${Math.abs(t)}`;
  }

  /** 刹车文案。 */
  function brakeLabel(brake = state.brake) {
    if (isEmergencyBrake(brake)) return '急刹';
    if (brake < 0.08) return '松开';
    if (brake < 0.45) return '轻刹';
    if (brake < 0.8) return '制动';
    return '制动';
  }

  /** 每帧积分速度；急刹回弹在此推进。联机且非本机操作时由快照驱动。 */
  function tick(dt) {
    const netOwned =
      Boolean(window.LiminalNetworkSession?.connected) && !localControl;

    if (state.brakeSpringing && !netOwned) {
      state.brake = Math.max(0, state.brake - BRAKE_SPRING_RATE * dt);
      if (state.brake <= 0.001) {
        state.brake = 0;
        state.brakeSpringing = false;
      }
      emit();
      pushNetwork();
    }

    if (netOwned) {
      const intensity = Math.min(1, Math.abs(state.speed) / MAX_SPEED);
      window.LpTrainAudio?.setDriveIntensity?.(intensity);
      return;
    }

    if (isEmergencyBrake()) {
      state.speed = 0;
      window.LpTrainAudio?.setDriveIntensity?.(0);
      return;
    }

    const desired = state.throttle * (1 - state.brake * 0.92);
    let rate = ACCEL;
    const slowing =
      Math.abs(desired) < Math.abs(state.speed) - 0.01 ||
      (Math.sign(desired) !== Math.sign(state.speed) && Math.abs(state.speed) > 0.05);
    if (state.brake > 0.05 && slowing) {
      rate = COAST_DECEL + BRAKE_DECEL * state.brake;
    } else if (Math.abs(desired) < 0.01) {
      rate = COAST_DECEL + BRAKE_DECEL * state.brake;
    }
    state.speed = approach(state.speed, desired, rate * dt);
    state.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, state.speed));

    const intensity = Math.min(1, Math.abs(state.speed) / MAX_SPEED);
    window.LpTrainAudio?.setDriveIntensity?.(intensity);
  }

  function approach(value, target, maxStep) {
    if (value < target) return Math.min(value + maxStep, target);
    return Math.max(value - maxStep, target);
  }

  /** 广播状态变化。 */
  function emit() {
    window.dispatchEvent(
      new CustomEvent('liminal:train-drive', {
        detail: getState(),
      })
    );
  }

  /** 只读快照。 */
  function getState() {
    return {
      throttle: state.throttle,
      brake: state.brake,
      speed: state.speed,
      brakeSpringing: state.brakeSpringing,
      throttleLabel: throttleLabel(),
      brakeLabel: brakeLabel(),
      notches: THROTTLE_NOTCHES.slice(),
    };
  }

  window.LpTrainDrive = {
    THROTTLE_NOTCHES,
    EMERGENCY_BRAKE,
    setThrottle,
    setThrottleRaw,
    snapThrottle,
    setBrake,
    triggerEmergencyBrake,
    onBrakeReleased,
    setLocalControl,
    isLocalControl,
    applyNetworkState,
    throttleLabel,
    brakeLabel,
    isEmergencyBrake,
    tick,
    getState,
  };
})();
