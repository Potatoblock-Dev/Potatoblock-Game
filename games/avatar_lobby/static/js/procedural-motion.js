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

  /**
   * 走路/奔跑手臂摆动与肘弯（不含持枪 IK）。
   * 前臂（橙）肘外展离开躯干；后臂（红）肘折向躯干。
   */
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

    /* 肘弯非对称：前臂负弯外展；后臂负弯折进躯干（红臂朝胸口） */
    const elbowBase = running ? 0.72 : 0.16;
    const elbowAmp = running ? 0.24 : 0.1;
    const elbowPulse = Math.sin(armPhase) * state.speedRatio * elbowAmp;
    const runReach = running ? -0.1 * state.speedRatio : 0;
    const frontElbowMag =
      elbowBase + elbowPulse + idleElbow + airborne * (0.1 + rising * 0.2);
    const backElbowMag =
      elbowBase + elbowPulse * 0.9 + idleElbow + airborne * (0.1 + rising * 0.18);

    const frontShoulder =
      lerp(swing + runReach + idleSway, frontAirTarget, airborne) + state.kneel * 0.12;
    const backShoulder =
      lerp(-swing + runReach - idleSway * 0.7, backAirTarget, airborne) - state.kneel * 0.08;

    return {
      frontShoulder,
      backShoulder,
      frontElbow: -frontElbowMag,
      backElbow: -backElbowMag,
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
   *
   * 两个附着点（缺一不可）：
   * 1) grip —— 扳机握把：相对胸口的布局点（chest + along/below）
   * 2) forend —— 护木：相对握把、沿枪管局部的第二插槽（gunForendX/Y），落在枪身贴图上
   *
   * 姿态：back（左红）→ 握把；front（右橙）→ 护木；elbowSign<0 → 肘在枪下。
   */
  const FIREARM_HOLD_DEFAULTS = {
    chestX: 0,
    chestY: -11,
    gripAlong: 8,
    gripBelow: 5,
    /** @deprecated 旧「相对胸口」护木距；若未设 gunForend* 则用 forendAlong-gripAlong */
    forendAlong: 16,
    forendBelow: 6,
    /** 护木插槽：相对握把、沿枪管 +X / 管下 +Y（角色局部，与绘制 holdForendLocal 一致） */
    gunForendX: 26,
    gunForendY: 4,
    gripLimb: 'back',
    forendLimb: 'front',
    gripElbowSign: -1,
    forendElbowSign: -1,
    shoulderX: 11,
    shoulderY: -16,
    upperLen: 15,
    lowerLen: 16,
    shoulderMin: -2.9,
    shoulderMax: 1.85,
    elbowMin: -2.75,
    elbowMax: 2.75,
  };

  /** 合并火器持握规格（物品 holdPose 可覆盖默认）。 */
  function resolveFirearmHoldSpec(spec) {
    return { ...FIREARM_HOLD_DEFAULTS, ...(spec || {}) };
  }

  /**
   * 沿瞄准方向 + 垂直「下方」偏移，得到局部附着点。
   * below>0 时手在枪管下侧（+Y 下：perp = (-dir.y, dir.x)）。
   */
  function offsetAlongAim(rootX, rootY, dirX, dirY, along, below) {
    return {
      x: rootX + dirX * along + (-dirY) * below,
      y: rootY + dirY * along + dirX * below,
    };
  }

  /**
   * 握把 + 护木两个局部附着点。
   * 握把：胸口布局；护木：从握把沿枪管再偏 gunForend（第二插槽，必须在枪身上）。
   * @returns {{ grip:{x,y}, forend:{x,y}, dir:{x,y}, angle:number, spec:object }}
   */
  function computeFirearmAttachLocals(localAimX, localAimY, spec) {
    const h = resolveFirearmHoldSpec(spec);
    const aimLen = Math.hypot(localAimX, localAimY) || 1;
    const dir = { x: localAimX / aimLen, y: localAimY / aimLen };
    const grip = offsetAlongAim(h.chestX, h.chestY, dir.x, dir.y, h.gripAlong, h.gripBelow ?? 0);
    const hasGunForend =
      Number.isFinite(spec?.gunForendX) ||
      Number.isFinite(spec?.gunForendY) ||
      Number.isFinite(h.gunForendX);
    const forendAlongGun = hasGunForend
      ? (Number.isFinite(h.gunForendX) ? h.gunForendX : (h.forendAlong - h.gripAlong))
      : (h.forendAlong - h.gripAlong);
    const forendBelowGun = hasGunForend
      ? (Number.isFinite(h.gunForendY) ? h.gunForendY : h.forendBelow)
      : h.forendBelow;
    const forend = offsetAlongAim(grip.x, grip.y, dir.x, dir.y, forendAlongGun, forendBelowGun);
    return { grip, forend, dir, angle: Math.atan2(dir.y, dir.x), spec: h };
  }

  /** 单臂两骨 IK 到局部目标点（夹角范围可由 hold 规格放宽，避免握把解被裁掉）。 */
  function computeArmIkToLocal(
    shoulderX,
    shoulderY,
    targetX,
    targetY,
    upperLen,
    lowerLen,
    elbowSign,
    angleLimits
  ) {
    const solved = solveTwoBone(
      targetX - shoulderX,
      targetY - shoulderY,
      upperLen,
      lowerLen,
      elbowSign
    );
    const shMin = angleLimits?.shoulderMin ?? -2.55;
    const shMax = angleLimits?.shoulderMax ?? 1.05;
    const elMin = angleLimits?.elbowMin ?? -2.15;
    const elMax = angleLimits?.elbowMax ?? 2.15;
    return {
      shoulder: clamp(solved.upper, shMin, shMax),
      elbow: clamp(solved.bend, elMin, elMax),
    };
  }

  /**
   * 持枪双臂：握把/护木附着点 → two-bone IK（大厅/月台/任意火器共用）。
   * 默认右撇子：back→握把、front→护木；elbowSign<0；localAim 面向右 +X 前、+Y 下。
   */
  function computeAimArmPose(localAimX, localAimY, spec) {
    const attach = computeFirearmAttachLocals(localAimX, localAimY, spec);
    const h = attach.spec;
    const sx = h.shoulderX;
    const sy = h.shoulderY;
    const limits = {
      shoulderMin: h.shoulderMin,
      shoulderMax: h.shoulderMax,
      elbowMin: h.elbowMin,
      elbowMax: h.elbowMax,
    };
    const gripShoulderX = h.gripLimb === 'front' ? sx : -sx;
    const forendShoulderX = h.forendLimb === 'front' ? sx : -sx;
    const gripIk = computeArmIkToLocal(
      gripShoulderX, sy, attach.grip.x, attach.grip.y,
      h.upperLen, h.lowerLen, h.gripElbowSign, limits
    );
    const forendIk = computeArmIkToLocal(
      forendShoulderX, sy, attach.forend.x, attach.forend.y,
      h.upperLen, h.lowerLen, h.forendElbowSign, limits
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
