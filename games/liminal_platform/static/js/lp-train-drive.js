/**
 * 列车运行状态：节流拉杆档位 + 刹车拉杆。
 * 档位：-5 后退 … 0 停止 … +5 前进。
 * 约定：正节流 / 正速度 = 列车前进 = 屏幕右侧（世界 +X，见 LiminalCarriageSpec.TRAIN_FORWARD_X）。
 * 制动阀仅两档：松开 / 急刹；急刹切断动力并以高减速度刹停（非瞬停），拉杆可先快后慢回弹。
 *
 * 动力学（游戏化、贴近机车观感）：
 * - 档位 = 牵引力/功率需求，不是目标速度；平衡速度由牵引力与阻力决定。
 * - 低速近似恒牵引力（起步较有劲）；高速受功率限制，加速度随速度下降。
 * - 阻力 = 滚动 + 风阻∝v²；回空档为惰行，靠阻力慢慢减速。
 */
(() => {
  const THROTTLE_NOTCHES = [-5, -3, -1, 0, 1, 3, 5];
  const NOTCH_MAX = 5;
  const MAX_SPEED = 5;

  /** 满档、低速时的起步加速度（单位/秒²）。 */
  const TRACTIVE_START = 1.75;
  /**
   * 功率转折速度：|v| 低于此值按恒牵引力；高于此值加速度 ∝ 1/|v|。
   * 与 TRACTIVE_*、阻力一起决定满档能否缓慢爬到 MAX_SPEED。
   */
  const POWER_REF_SPEED = 1.55;
  /** 滚动阻力（恒定项）。 */
  const RESIST_ROLL = 0.085;
  /** 风阻系数（乘 v²）。 */
  const RESIST_DRAG = 0.0175;
  /** 惰行接近静止时的粘滞阈值。 */
  const STOP_EPS = 0.03;
  /** 换向对抗惯性时牵引力略增（动态制动感）。 */
  const REVERSE_BOOST = 1.12;

  /** 急刹减速度（单位/秒²）；满速约 0.55s 刹停，保留「急」但不瞬停。 */
  const EMERGENCY_DECEL = 9;
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

  /** 档位 → 牵引需求 -1…1。 */
  function notchDemand(throttle) {
    return Math.max(-1, Math.min(1, (Number(throttle) || 0) / NOTCH_MAX));
  }

  /**
   * 牵引力加速度：恒牵引力区与功率区取较小值。
   * demand 已含方向；与速度反向时略加强（对抗惯性）。
   */
  function tractiveAccel(speed, demand) {
    const absDemand = Math.abs(demand);
    if (absDemand < 0.01) return 0;
    const dir = Math.sign(demand);
    const v = Math.abs(speed);
    const effort = TRACTIVE_START * absDemand;
    const powerLimited =
      (TRACTIVE_START * absDemand * POWER_REF_SPEED) / Math.max(v, POWER_REF_SPEED);
    let mag = Math.min(effort, powerLimited);
    if (Math.abs(speed) > 0.05 && dir !== Math.sign(speed)) {
      mag *= REVERSE_BOOST;
    }
    return dir * mag;
  }

  /** 运行阻力加速度（与速度反向）。 */
  function resistanceAccel(speed) {
    if (Math.abs(speed) < 1e-5) return 0;
    const v = Math.abs(speed);
    return -Math.sign(speed) * (RESIST_ROLL + RESIST_DRAG * v * v);
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
   * 设置刹车。用户松手吸附时传 fromUser；拖动中请用 setBrakeRaw。
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

  /** 拖动中连续设置刹车（0…1，不吸附）。越过急刹位即切断动力。 */
  function setBrakeRaw(value) {
    state.brakeSpringing = false;
    state.brake = Math.max(0, Math.min(1, Number(value) || 0));
    if (isEmergencyBrake(state.brake)) {
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
      // 联机：立刻上报 brake=0，急刹由 emergencyActive 权威；本地再做回弹动画。
      // 避免回弹每帧刷 train 与其他玩家抢权威。
      emit();
      if (window.LiminalSession?.isConnected?.()) {
        window.LiminalSession.notifyTrain(
          {
            throttle: 0,
            brake: 0,
          },
          { force: true }
        );
      }
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
    const step = Math.max(0, Math.min(0.05, Number(dt) || 0));
    if (state.brakeSpringing) {
      state.brake *= Math.exp(-BRAKE_SPRING_K * step);
      if (state.brake <= 0.004) {
        state.brake = 0;
        state.brakeSpringing = false;
      }
      emit();
      // 回弹仅本地视觉；权威已在 onBrakeReleased 上报 brake=0。
    }

    if (isEmergencyBrake()) {
      armEmergencyBrake();
    }

    if (state.emergencyActive) {
      state.throttle = 0;
      const sign = Math.sign(state.speed) || 0;
      if (sign !== 0) {
        state.speed -= sign * EMERGENCY_DECEL * step;
        if (Math.sign(state.speed) !== sign) state.speed = 0;
      }
      if (Math.abs(state.speed) < 0.02) {
        state.speed = 0;
        state.emergencyActive = false;
      }
      window.LpTrainAudio?.setDriveIntensity?.(
        Math.min(1, Math.abs(state.speed) / MAX_SPEED)
      );
      return;
    }

    /* 制动位几乎切断牵引；松开时 demand 随档位。 */
    const demand = notchDemand(state.throttle) * (1 - state.brake * 0.92);
    let accel = tractiveAccel(state.speed, demand) + resistanceAccel(state.speed);
    state.speed += accel * step;

    if (Math.abs(demand) < 0.01 && Math.abs(state.speed) < STOP_EPS) {
      state.speed = 0;
    }
    state.speed = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, state.speed));

    const intensity = Math.min(1, Math.abs(state.speed) / MAX_SPEED);
    window.LpTrainAudio?.setDriveIntensity?.(intensity);
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
    // 本地急刹回弹动画期间不覆盖 brake，避免动画被快照掐断。
    if (partial.brake != null && !state.brakeSpringing) {
      state.brake = Math.max(0, Math.min(1, Number(partial.brake) || 0));
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
    BRAKE_SNAP_THRESHOLD,
    MAX_SPEED,
    setThrottle,
    setThrottleRaw,
    snapThrottle,
    setBrake,
    setBrakeRaw,
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
