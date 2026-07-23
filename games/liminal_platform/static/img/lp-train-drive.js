/**
 * 列车运行状态：节流拉杆档位 + 刹车拉杆，模拟速度。
 * 档位：-5 后退 … 0 停止 … +5 前进。
 * 约定：正节流 / 正速度 = 列车前进 = 屏幕右侧（世界 +X，见 LiminalCarriageSpec.TRAIN_FORWARD_X）。
 * 制动阀仅两档：松开 / 急刹；急刹切断动力并以高减速度刹停（非瞬停），拉杆可先快后慢回弹。
 */
(() => {
  const THROTTLE_NOTCHES = [-5, -3, -1, 0, 1, 3, 5];
  const MAX_SPEED = 5;
  const ACCEL = 2.4;
  const COAST_DECEL = 0.55;
  const BRAKE_DECEL = 6.5;
  /** 急刹减速度（单位/秒）；满速约 0.3s 内停稳，明显高于普通制动。 */
  const EMERGENCY_DECEL = 16;
  /** 达到此比例视为急刹位（拉杆底部）。 */
  const EMERGENCY_BRAKE = 0.95;
  /** 用户拖动时吸附阈值（≥ 则急刹，否则松开）。 */
  const BRAKE_SNAP_THRESHOLD = 0.5;
  /** 急刹回弹指数（越大起步越猛，末端越柔）。 */
  const BRAKE_SPRING_K = 8.5;

  const state = {
    throttle: 0,
    brake: 0,
    speed: 0,
    brakeSpringing: false,
    /** 急刹闩锁：拉杆回弹后仍保持急减速，直到停稳。 */
    emergencyActive: false,
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

  /** 用户操作后上报联机列车状态。 */
  function notifyNetwork() {
    window.LiminalSession?.notifyTrain?.(getState());
  }

  /** 设置节流档（自动吸附）。急刹过程中锁定为停止。 */
  function setThrottle(value) {
    if (isEmergencyBrake() || state.emergencyActive) {
      state.throttle = 0;
      emit();
      notifyNetwork();
      return;
    }
    state.throttle = nearestNotch(Number(value) || 0);
    emit();
    notifyNetwork();
  }

  /** 拖拽中临时设置（可不吸附）。急刹过程中锁定为停止。 */
  function setThrottleRaw(value) {
    if (isEmergencyBrake() || state.emergencyActive) {
      state.throttle = 0;
      emit();
      notifyNetwork();
      return;
    }
    state.throttle = Math.max(-5, Math.min(5, Number(value) || 0));
    emit();
    notifyNetwork();
  }

  /** 吸附当前节流到最近档。 */
  function snapThrottle() {
    if (isEmergencyBrake() || state.emergencyActive) {
      state.throttle = 0;
    } else {
      state.throttle = nearestNotch(state.throttle);
    }
    emit();
    notifyNetwork();
  }

  /**
   * 设置刹车。用户操作时仅吸附为松开(0)或急刹(1)；
   * 回弹动画可传入中间值。
   */
  function setBrake(value, options = {}) {
    if (options.fromUser) state.brakeSpringing = false;
    let next = Math.max(0, Math.min(1, Number(value) || 0));
    if (options.fromUser) {
      next = next >= BRAKE_SNAP_THRESHOLD ? 1 : 0;
    }
    state.brake = next;
    if (isEmergencyBrake(next)) {
      armEmergencyBrake();
    }
    emit();
    notifyNetwork();
  }

  /** 进入急刹：切断动力并闩锁急减速（不瞬停）。 */
  function armEmergencyBrake() {
    state.throttle = 0;
    state.emergencyActive = true;
  }

  /** 触发急刹并开始回弹（刻度按钮「急刹」）。 */
  function triggerEmergencyBrake() {
    state.brakeSpringing = false;
    state.brake = 1;
    armEmergencyBrake();
    state.brakeSpringing = true;
    emit();
    notifyNetwork();
  }

  /** 松手：若在急刹位则开始先快后慢回弹（急减速闩锁仍保持到停稳）。 */
  function onBrakeReleased() {
    if (isEmergencyBrake()) {
      armEmergencyBrake();
      state.brakeSpringing = true;
      emit();
      notifyNetwork();
    }
  }

  /** 档位文案。 */
  function throttleLabel(throttle = state.throttle) {
    const t = nearestNotch(throttle);
    if (t === 0) return '停止';
    if (t > 0) return `前进 ${t}`;
    return `后退 ${Math.abs(t)}`;
  }

  /** 刹车文案（仅松开 / 急刹）。 */
  function brakeLabel(brake = state.brake) {
    return isEmergencyBrake(brake) || state.emergencyActive ? '急刹' : '松开';
  }

  /** 每帧积分速度；急刹回弹与急减速在此推进。 */
  function tick(dt) {
    if (state.brakeSpringing) {
      state.brake *= Math.exp(-BRAKE_SPRING_K * dt);
      if (state.brake <= 0.004) {
        state.brake = 0;
        state.brakeSpringing = false;
      }
      emit();
      notifyNetwork();
    }

    if (isEmergencyBrake()) {
      armEmergencyBrake();
    }

    if (state.emergencyActive) {
      state.throttle = 0;
      state.speed = approach(state.speed, 0, EMERGENCY_DECEL * dt);
      if (Math.abs(state.speed) < 0.02) {
        state.speed = 0;
        state.emergencyActive = false;
      }
      window.LpTrainAudio?.setDriveIntensity?.(
        Math.min(1, Math.abs(state.speed) / MAX_SPEED)
      );
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
      emergencyActive: state.emergencyActive,
      throttleLabel: throttleLabel(),
      brakeLabel: brakeLabel(),
      notches: THROTTLE_NOTCHES.slice(),
    };
  }

  /** 应用服务端权威列车状态（联机快照）。不回传网络。 */
  function applyAuthority(partial = {}) {
    if (partial.throttle != null) {
      state.throttle = nearestNotch(Number(partial.throttle) || 0);
    }
    if (partial.brake != null) {
      state.brake = Math.max(0, Math.min(1, Number(partial.brake) || 0));
      if (state.brake <= 0.001) state.brakeSpringing = false;
    }
    if (partial.speed != null) {
      state.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, Number(partial.speed) || 0));
    }
    if (partial.emergencyActive != null) {
      state.emergencyActive = Boolean(partial.emergencyActive);
    } else if (isEmergencyBrake()) {
      state.emergencyActive = true;
    }
    if (state.emergencyActive || isEmergencyBrake()) {
      state.throttle = 0;
    }
    emit();
  }

  window.LpTrainDrive = {
    THROTTLE_NOTCHES,
    EMERGENCY_BRAKE,
    EMERGENCY_DECEL,
    setThrottle,
    setThrottleRaw,
    snapThrottle,
    setBrake,
    triggerEmergencyBrake,
    onBrakeReleased,
    throttleLabel,
    brakeLabel,
    isEmergencyBrake,
    tick,
    getState,
    applyAuthority,
  };
})();
