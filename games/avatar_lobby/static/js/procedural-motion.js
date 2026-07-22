/**
 * 轻量 2D 程序化动作解算。
 *
 * 用解析式 two-bone IK 把脚部目标转换为髋/膝角度，再由角色控制器的
 * 弹簧负责平滑。坐标约定：+y 向下，骨骼初始方向朝下。
 * gait: 'walk' | 'run' 选用不同步态模组。
 */
(() => {
  // 与 UVLayout.PARTS 腿段 drawSize 同步（约 8 头身）。
  const UPPER_LEG_LENGTH = 16;
  const LOWER_LEG_LENGTH = 17;
  const STAND_FOOT_Y = UPPER_LEG_LENGTH + LOWER_LEG_LENGTH; // 33

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function lerp(from, to, weight) {
    return from + (to - from) * weight;
  }

  // 解析式双骨骼 IK：返回第一段相对竖直方向的角度与膝关节弯曲角。
  function solveTwoBone(targetX, targetY) {
    const minimumReach = Math.abs(UPPER_LEG_LENGTH - LOWER_LEG_LENGTH) + 0.01;
    const maximumReach = UPPER_LEG_LENGTH + LOWER_LEG_LENGTH - 0.01;
    const distance = clamp(Math.hypot(targetX, targetY), minimumReach, maximumReach);
    const kneeCosine = clamp(
      (
        distance * distance
        - UPPER_LEG_LENGTH * UPPER_LEG_LENGTH
        - LOWER_LEG_LENGTH * LOWER_LEG_LENGTH
      ) / (2 * UPPER_LEG_LENGTH * LOWER_LEG_LENGTH),
      -1,
      1
    );
    const bend = Math.acos(kneeCosine);
    const direction = Math.atan2(-targetX, targetY);
    const offset = Math.atan2(
      LOWER_LEG_LENGTH * Math.sin(bend),
      UPPER_LEG_LENGTH + LOWER_LEG_LENGTH * Math.cos(bend)
    );
    return { upper: direction - offset, bend };
  }

  /** 行走步态：中等步幅，支撑腿贴近地面。 */
  function solveWalkingLeg(phase, speedRatio) {
    const strideX = Math.sin(phase) * 10 * speedRatio;
    const lift = Math.max(0, -Math.cos(phase)) * 6.5 * speedRatio;
    return solveTwoBone(strideX, STAND_FOOT_Y - 0.4 - lift);
  }

  /** 奔跑步态：更大步幅与抬腿，身体更前倾。 */
  function solveRunningLeg(phase, speedRatio) {
    const strideX = Math.sin(phase) * 14.5 * speedRatio;
    const lift = Math.max(0, -Math.cos(phase)) * 11 * speedRatio;
    const crouch = 1.8 * speedRatio;
    return solveTwoBone(strideX, STAND_FOOT_Y - 0.6 - lift - crouch);
  }

  function computeLegPose(state) {
    const running = state.gait === 'run';
    const solve = running ? solveRunningLeg : solveWalkingLeg;
    const frontWalk = solve(state.walkPhase, state.speedRatio);
    const backWalk = solve(state.walkPhase + Math.PI, state.speedRatio);
    const frontAir = solveTwoBone(running ? -6 : -4, STAND_FOOT_Y * (running ? 0.62 : 0.7));
    const backAir = solveTwoBone(running ? 7 : 5, STAND_FOOT_Y * (running ? 0.58 : 0.66));
    const airborne = state.onGround ? 0 : 1;
    const frontBase = {
      upper: lerp(frontWalk.upper, frontAir.upper, airborne),
      bend: lerp(frontWalk.bend, frontAir.bend, airborne),
    };
    const backBase = {
      upper: lerp(backWalk.upper, backAir.upper, airborne),
      bend: lerp(backWalk.bend, backAir.bend, airborne),
    };
    return {
      frontHip: lerp(frontBase.upper, -0.2, state.kneel),
      frontKnee: lerp(frontBase.bend, 1.43, state.kneel),
      backHip: lerp(backBase.upper, 0.8, state.kneel),
      backKnee: lerp(backBase.bend, 0.2, state.kneel),
    };
  }

  function computeArmPose(state) {
    const running = state.gait === 'run';
    const amp = running ? 0.72 : 0.42;
    const swing = Math.sin(state.walkPhase) * state.speedRatio * amp;
    const rising = clamp(-state.verticalVelocity / 520, 0, 1);
    const falling = clamp(state.verticalVelocity / 520, 0, 1);
    const airborne = state.onGround ? 0 : 1;
    const frontAirTarget = -0.42 * rising + 0.12 * falling;
    const backAirTarget = 0.34 * rising - 0.08 * falling;
    const elbowPump = running ? 0.32 : 0.18;
    return {
      frontShoulder: lerp(-swing, frontAirTarget, airborne) + state.kneel * 0.12,
      backShoulder: lerp(swing, backAirTarget, airborne) - state.kneel * 0.08,
      frontElbow: 0.1 + state.speedRatio * elbowPump + airborne * 0.14 + (running ? 0.12 : 0),
      backElbow: -0.1 - state.speedRatio * elbowPump - airborne * 0.14 - (running ? 0.12 : 0),
    };
  }

  function computeBodyPose(state) {
    const running = state.gait === 'run';
    const bobAmp = running ? 2.6 : 1.7;
    const stepRise = -Math.abs(Math.sin(state.walkPhase)) * state.speedRatio * bobAmp;
    const breathing = Math.sin(state.idlePhase) * (1 - state.speedRatio) * 0.32;
    const leanScale = running ? 0.16 : 0.09;
    const dirLean = running ? 0.05 : 0.025;
    return {
      bob: (stepRise + breathing) * (1 - state.kneel),
      lean: state.localVelocity * leanScale
        + state.moveDirection * dirLean
        + state.kneel * 0.06,
    };
  }

  window.ProceduralMotion = {
    computePose(state) {
      return {
        ...computeLegPose(state),
        ...computeArmPose(state),
        ...computeBodyPose(state),
      };
    },
  };
})();
