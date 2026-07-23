/**
 * 轻量 2D 程序化动作解算（Avatar 大厅与阈限月台共用）。
 *
 * 用解析式 two-bone IK 把脚部目标转为髋/膝角，再由 AvatarEntity 弹簧平滑。
 * 坐标：+y 向下，骨骼初始朝下；上臂/大腿角 0=朝下，正角顺时针（身后）。
 * gait: 'walk' | 'run'
 */
(() => {
  const UPPER_LEG_LENGTH = 16;
  const LOWER_LEG_LENGTH = 17;
  const STAND_FOOT_Y = UPPER_LEG_LENGTH + LOWER_LEG_LENGTH;

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function lerp(from, to, weight) {
    return from + (to - from) * weight;
  }

  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /**
   * 解析式双骨骼 IK（Law of Cosines）：第一段相对竖直角 + 关节弯折。
   * elbowSign>0：肘/膝朝「正弯」侧（腿默认、肘上）；<0：镜像（侧视持枪肘下/外展）。
   * 参考常见 2D two-bone IK：保留符号避免折进躯干。
   */
  function solveTwoBone(
    targetX,
    targetY,
    upperLen = UPPER_LEG_LENGTH,
    lowerLen = LOWER_LEG_LENGTH,
    elbowSign = 1
  ) {
    const minimumReach = Math.abs(upperLen - lowerLen) + 0.01;
    const maximumReach = upperLen + lowerLen - 0.01;
    const distance = clamp(Math.hypot(targetX, targetY), minimumReach, maximumReach);
    const kneeCosine = clamp(
      (
        distance * distance
        - upperLen * upperLen
        - lowerLen * lowerLen
      ) / (2 * upperLen * lowerLen),
      -1,
      1
    );
    const bendAbs = Math.acos(kneeCosine);
    const direction = Math.atan2(-targetX, targetY);
    const offset = Math.atan2(
      lowerLen * Math.sin(bendAbs),
      upperLen + lowerLen * Math.cos(bendAbs)
    );
    const sign = elbowSign >= 0 ? 1 : -1;
    return { upper: direction - sign * offset, bend: sign * bendAbs };
  }

  /** 行走：中等步幅，摆动腿抬起、支撑腿贴地。 */
  function solveWalkingLeg(phase, speedRatio) {
    const strideX = Math.sin(phase) * 9.5 * speedRatio;
    const swing = Math.max(0, -Math.cos(phase));
    const plant = Math.max(0, Math.cos(phase));
    const lift = swing * 6.2 * speedRatio;
    const plantDrop = plant * 0.35 * speedRatio;
    return solveTwoBone(strideX, STAND_FOOT_Y - 0.35 - lift + plantDrop);
  }

  /** 奔跑：大步幅、高抬膝、略蹲。 */
  function solveRunningLeg(phase, speedRatio) {
    const strideX = Math.sin(phase) * 15.2 * speedRatio;
    const swing = Math.max(0, -Math.cos(phase));
    const lift = swing * 12.5 * speedRatio;
    const crouch = 2.1 * speedRatio;
    return solveTwoBone(strideX, STAND_FOOT_Y - 0.55 - lift - crouch);
  }

  function computeLegPose(state) {
    const running = state.gait === 'run';
    const solve = running ? solveRunningLeg : solveWalkingLeg;
    const frontWalk = solve(state.walkPhase, state.speedRatio);
    const backWalk = solve(state.walkPhase + Math.PI, state.speedRatio);

    const rising = clamp(-state.verticalVelocity / 480, 0, 1);
    const falling = clamp(state.verticalVelocity / 520, 0, 1);
    const airborne = state.onGround ? 0 : 1;
    /* 起跳收膝、下落略伸准备着地 */
    const tuck = 0.55 + rising * 0.35 - falling * 0.12;
    const frontAir = solveTwoBone(running ? -5 : -3.5, STAND_FOOT_Y * (0.52 + tuck * 0.12));
    const backAir = solveTwoBone(running ? 6.5 : 4.5, STAND_FOOT_Y * (0.48 + tuck * 0.1));

    const frontBase = {
      upper: lerp(frontWalk.upper, frontAir.upper, airborne),
      bend: lerp(frontWalk.bend, frontAir.bend + rising * 0.35, airborne),
    };
    const backBase = {
      upper: lerp(backWalk.upper, backAir.upper, airborne),
      bend: lerp(backWalk.bend, backAir.bend + rising * 0.28, airborne),
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
    const move = smoothstep(0.02, 0.2, state.speedRatio);
    const idle = 1 - move;
    const airborne = state.onGround ? 0 : 1;
    const rising = clamp(-state.verticalVelocity / 520, 0, 1);
    const falling = clamp(state.verticalVelocity / 520, 0, 1);

    /* 手臂相位略超前于腿，对侧更自然 */
    const armPhase = state.walkPhase + 0.18;
    const amp = running ? 0.5 : 0.33;
    const swing = Math.sin(armPhase) * state.speedRatio * amp;

    const idleSway = Math.sin(state.idlePhase * 0.85) * 0.045 * idle;
    const idleElbow = Math.sin(state.idlePhase * 0.6) * 0.03 * idle;

    const frontAirTarget = -0.55 * rising + 0.18 * falling;
    const backAirTarget = 0.4 * rising - 0.12 * falling;

    const elbowBase = running ? 0.72 : 0.16;
    const elbowAmp = running ? 0.24 : 0.1;
    const elbowPulse = Math.sin(armPhase) * state.speedRatio * elbowAmp;
    const runReach = running ? -0.1 * state.speedRatio : 0;

    const frontShoulder =
      lerp(swing + runReach + idleSway, frontAirTarget, airborne) + state.kneel * 0.12;
    const backShoulder =
      lerp(-swing + runReach - idleSway * 0.7, backAirTarget, airborne) - state.kneel * 0.08;

    return {
      frontShoulder,
      backShoulder,
      frontElbow: elbowBase + elbowPulse + idleElbow + airborne * (0.1 + rising * 0.2),
      backElbow: -(elbowBase + elbowPulse * 0.9) - idleElbow - airborne * (0.1 + rising * 0.18),
    };
  }

  function computeBodyPose(state) {
    const running = state.gait === 'run';
    const move = smoothstep(0.02, 0.25, state.speedRatio);
    const bobAmp = running ? 2.8 : 1.55;
    const stepRise = -Math.abs(Math.sin(state.walkPhase)) * state.speedRatio * bobAmp;
    const breathing = Math.sin(state.idlePhase) * (1 - move) * 0.38;
    const leanScale = running ? 0.17 : 0.085;
    const dirLean = running ? 0.055 : 0.022;
    /* 步频微倾：落脚瞬间略前倾 */
    const strideLean = Math.sin(state.walkPhase * 2) * state.speedRatio * (running ? 0.025 : 0.012);
    return {
      bob: (stepRise + breathing) * (1 - state.kneel),
      lean:
        state.localVelocity * leanScale
        + state.moveDirection * dirLean
        + strideLean
        + state.kneel * 0.06,
    };
  }

  /**
   * 默认火器持握（角色局部：面向 +X，+Y 向下）。
   * gripLimb=back / forendLimb=front：肩宽内几何上后臂够得着握把、前臂够得着护木，
   * 避免旧方案「前臂握把+后臂护木」把两手挤到同一点或肘角过度折叠。
   */
  const FIREARM_HOLD_DEFAULTS = {
    chestX: 4,
    chestY: -12,
    gripAlong: 3,
    forendAlong: 22,
    forendBelow: 3,
    gripLimb: 'back',
    forendLimb: 'front',
    gripElbowSign: 1,
    forendElbowSign: 1,
    shoulderX: 11,
    shoulderY: -16,
    upperLen: 15,
    lowerLen: 16,
  };

  /** 合并火器持握规格（物品 holdPose 可覆盖默认）。 */
  function resolveFirearmHoldSpec(spec) {
    return { ...FIREARM_HOLD_DEFAULTS, ...(spec || {}) };
  }

  /**
   * 由瞄准方向算出握把/护木两个局部附着点（可复用；不绑死某一把枪）。
   * @returns {{ grip:{x,y}, forend:{x,y}, dir:{x,y}, angle:number, spec:object }}
   */
  function computeFirearmAttachLocals(localAimX, localAimY, spec) {
    const h = resolveFirearmHoldSpec(spec);
    const aimLen = Math.hypot(localAimX, localAimY) || 1;
    const dir = { x: localAimX / aimLen, y: localAimY / aimLen };
    const grip = {
      x: h.chestX + dir.x * h.gripAlong,
      y: h.chestY + dir.y * h.gripAlong,
    };
    const forend = {
      x: h.chestX + dir.x * h.forendAlong,
      y: h.chestY + dir.y * h.forendAlong + h.forendBelow,
    };
    return { grip, forend, dir, angle: Math.atan2(dir.y, dir.x), spec: h };
  }

  /** 单臂两骨 IK 到局部目标点。 */
  function computeArmIkToLocal(shoulderX, shoulderY, targetX, targetY, upperLen, lowerLen, elbowSign) {
    const solved = solveTwoBone(
      targetX - shoulderX,
      targetY - shoulderY,
      upperLen,
      lowerLen,
      elbowSign
    );
    return {
      shoulder: clamp(solved.upper, -2.55, 1.05),
      elbow: clamp(solved.bend, -2.15, 2.15),
    };
  }

  /**
   * 持枪双臂：按附着点 IK（大厅/月台/任意火器共用）。
   * localAim：面向右时 +X 向前、+Y 向下；spec 见 FIREARM_HOLD_DEFAULTS。
   */
  function computeAimArmPose(localAimX, localAimY, spec) {
    const attach = computeFirearmAttachLocals(localAimX, localAimY, spec);
    const h = attach.spec;
    const sx = h.shoulderX;
    const sy = h.shoulderY;
    const gripShoulderX = h.gripLimb === 'front' ? sx : -sx;
    const forendShoulderX = h.forendLimb === 'front' ? sx : -sx;
    const gripIk = computeArmIkToLocal(
      gripShoulderX, sy, attach.grip.x, attach.grip.y,
      h.upperLen, h.lowerLen, h.gripElbowSign
    );
    const forendIk = computeArmIkToLocal(
      forendShoulderX, sy, attach.forend.x, attach.forend.y,
      h.upperLen, h.lowerLen, h.forendElbowSign
    );
    const frontIk = h.gripLimb === 'front' ? gripIk : forendIk;
    const backIk = h.gripLimb === 'back' ? gripIk : forendIk;
    return {
      frontShoulder: frontIk.shoulder,
      frontElbow: frontIk.elbow,
      backShoulder: backIk.shoulder,
      backElbow: backIk.elbow,
      attach,
    };
  }

  /**
   * 双段臂指向局部目标（相对肩，+Y 向下）；用于换弹扶匣等。
   * @param {number} [upperLen]
   * @param {number} [lowerLen]
   */
  function computeArmReachPose(localTargetX, localTargetY, upperLen = 15, lowerLen = 16) {
    const solved = solveTwoBone(localTargetX, localTargetY, upperLen, lowerLen);
    return {
      shoulder: clamp(solved.upper, -2.4, 0.8),
      elbow: clamp(solved.bend, 0.15, 2.2),
    };
  }

  window.ProceduralMotion = {
    FIREARM_HOLD_DEFAULTS,
    computePose(state) {
      return {
        ...computeLegPose(state),
        ...computeArmPose(state),
        ...computeBodyPose(state),
      };
    },
    resolveFirearmHoldSpec,
    computeFirearmAttachLocals,
    computeArmIkToLocal,
    computeAimArmPose,
    computeArmReachPose,
    solveTwoBone,
    clamp,
    lerp,
  };
})();
