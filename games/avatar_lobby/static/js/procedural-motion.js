/**
 * 轻量 2D 程序化动作解算。
 *
 * 用解析式 two-bone IK 把脚部目标转换为髋/膝角度，再由角色控制器的
 * 弹簧负责平滑。坐标约定：+y 向下，骨骼初始方向朝下。
 */
(() => {
  const UPPER_LEG_LENGTH = 12;
  const LOWER_LEG_LENGTH = 13;

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

  // 脚在摆动半程抬起，支撑半程贴近地面；两腿相差半个周期。
  function solveWalkingLeg(phase, speedRatio) {
    const strideX = Math.sin(phase) * 7.5 * speedRatio;
    const lift = Math.max(0, -Math.cos(phase)) * 5 * speedRatio;
    return solveTwoBone(strideX, 24.7 - lift);
  }

  function computeLegPose(state) {
    const frontWalk = solveWalkingLeg(state.walkPhase, state.speedRatio);
    const backWalk = solveWalkingLeg(state.walkPhase + Math.PI, state.speedRatio);
    const frontAir = solveTwoBone(-3, 17.5);
    const backAir = solveTwoBone(4, 16.5);
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
    const swing = Math.sin(state.walkPhase) * state.speedRatio * 0.42;
    const rising = clamp(-state.verticalVelocity / 520, 0, 1);
    const falling = clamp(state.verticalVelocity / 520, 0, 1);
    const airborne = state.onGround ? 0 : 1;
    const frontAirTarget = -0.42 * rising + 0.12 * falling;
    const backAirTarget = 0.34 * rising - 0.08 * falling;
    return {
      frontShoulder: lerp(-swing, frontAirTarget, airborne) + state.kneel * 0.12,
      backShoulder: lerp(swing, backAirTarget, airborne) - state.kneel * 0.08,
      frontElbow: 0.1 + state.speedRatio * 0.18 + airborne * 0.14,
      backElbow: -0.1 - state.speedRatio * 0.18 - airborne * 0.14,
    };
  }

  function computeBodyPose(state) {
    const stepRise = -Math.abs(Math.sin(state.walkPhase)) * state.speedRatio * 1.7;
    const breathing = Math.sin(state.idlePhase) * (1 - state.speedRatio) * 0.32;
    return {
      bob: (stepRise + breathing) * (1 - state.kneel),
      lean: state.localVelocity * 0.09
        + state.moveDirection * 0.025
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
