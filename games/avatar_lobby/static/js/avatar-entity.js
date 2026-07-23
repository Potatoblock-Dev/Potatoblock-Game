/**
 * 多人 Avatar 实体：运动状态、关节弹簧、外观缓存与绘制。
 */
(() => {
  const AVATAR_SIZE = 72;
  const AVATAR_DRAW_SCALE = 1.35;
  // 水平碰撞宽（未乘 draw scale）：贴近躯干+垂臂，不含整身头发画布。
  const AVATAR_COLLISION_WIDTH = 40;

  /**
   * UV 四肢读取区外扩时，小腿远端会画出推荐脚底以下。
   * 返回角色局部坐标中、脚底以下的额外长度（未乘 draw/height scale）。
   */
  function uvFootOverhangLocal(atlas) {
    if (!atlas) return 0;
    const parts = window.UVLayout.resolveParts(atlas);
    if (parts === window.UVLayout.LEGACY_PARTS) return 0;
    const lower = parts.frontLegLower;
    if (!lower?.rect || !lower?.coreRect || !lower?.drawSize) return 0;
    const [, ry, , rh] = lower.rect;
    const [, cy, , ch] = lower.coreRect;
    const length = lower.drawSize[1];
    const bottomPad = (ry + rh) - (cy + ch);
    return Math.max(0, bottomPad * (length / ch));
  }

  /** 站立时为让可视脚底贴地，需要把实体上移的屏幕像素。 */
  function footGroundLiftPx(entity) {
    const local = uvFootOverhangLocal(entity.uvAtlas);
    if (local <= 0) return 0;
    return local * AVATAR_DRAW_SCALE * entity.heightScale * (1 - entity.squash);
  }
  const DEFAULT_HEIGHT_SCALE = 1.0;
  const MOVE_SPEED = 260;
  const RUN_SPEED = 420;
  const textureCache = new Map();

  function createJoints() {
    return {
      backShoulder: { angle: 0, velocity: 0 },
      frontShoulder: { angle: 0, velocity: 0 },
      backElbow: { angle: 0, velocity: 0 },
      frontElbow: { angle: 0, velocity: 0 },
      backHip: { angle: 0, velocity: 0 },
      frontHip: { angle: 0, velocity: 0 },
      backKnee: { angle: 0, velocity: 0 },
      frontKnee: { angle: 0, velocity: 0 },
    };
  }

  function createAvatarEntity(options = {}) {
    return {
      id: options.id || null,
      nickname: options.nickname || '玩家',
      x: options.x || 0,
      y: options.y || 0,
      vx: 0,
      vy: 0,
      facing: 1,
      moveDirection: 0,
      gait: 'walk',
      walkPhase: 0,
      idlePhase: 0,
      onGround: true,
      lean: 0,
      leanVelocity: 0,
      squash: 0,
      squashVelocity: 0,
      kneel: 0,
      bodyBob: 0,
      bodyBobVelocity: 0,
      headLook: 0,
      headLookVelocity: 0,
      heightScale: DEFAULT_HEIGHT_SCALE,
      texture: null,
      uvAtlas: null,
      appearanceKey: '',
      joints: createJoints(),
      snapshots: [],
    };
  }

  function stepAngularSpring(joint, target, dt, stiffness = 85, damping = 13) {
    joint.velocity += ((target - joint.angle) * stiffness - joint.velocity * damping) * dt;
    joint.angle += joint.velocity * dt;
  }

  function stepBodySpring(entity, property, velocityProperty, target, dt, stiffness, damping) {
    entity[velocityProperty] += (
      (target - entity[property]) * stiffness - entity[velocityProperty] * damping
    ) * dt;
    entity[property] += entity[velocityProperty] * dt;
  }

  function updateEntityMotion(entity, dt) {
    const gait = entity.gait === 'run' ? 'run' : 'walk';
    const refSpeed = gait === 'run' ? RUN_SPEED : MOVE_SPEED;
    const speedRatio = Math.min(Math.abs(entity.vx) / refSpeed, 1);
    if (speedRatio > 0.03 && entity.onGround) {
      const cadence = gait === 'run' ? 7.2 + speedRatio * 9.5 : 5 + speedRatio * 7;
      entity.walkPhase += dt * cadence;
    }
    entity.idlePhase += dt * 1.7;
    const pose = window.ProceduralMotion.computePose({
      walkPhase: entity.walkPhase,
      idlePhase: entity.idlePhase,
      speedRatio,
      gait,
      onGround: entity.onGround,
      verticalVelocity: entity.vy,
      kneel: entity.kneel,
      localVelocity: entity.vx / refSpeed * entity.facing,
      moveDirection: entity.moveDirection * entity.facing,
    });
    const joints = entity.joints;
    stepAngularSpring(joints.frontHip, pose.frontHip, dt, 100, 16);
    stepAngularSpring(joints.backHip, pose.backHip, dt, 100, 16);
    stepAngularSpring(joints.frontKnee, pose.frontKnee, dt, 105, 17);
    stepAngularSpring(joints.backKnee, pose.backKnee, dt, 105, 17);
    stepAngularSpring(joints.frontShoulder, pose.frontShoulder, dt, 72, 12);
    stepAngularSpring(joints.backShoulder, pose.backShoulder, dt, 72, 12);
    stepAngularSpring(joints.frontElbow, pose.frontElbow, dt, 75, 13);
    stepAngularSpring(joints.backElbow, pose.backElbow, dt, 75, 13);
    stepBodySpring(entity, 'bodyBob', 'bodyBobVelocity', pose.bob, dt, 70, 14);
    stepBodySpring(entity, 'lean', 'leanVelocity', pose.lean, dt, 55, 11);
    stepBodySpring(entity, 'squash', 'squashVelocity', 0, dt, 110, 14);
  }

  function textureUrl(appearance) {
    if (!appearance?.skinId) return null;
    const v = appearance.contentHash || '';
    return `/avatar-lobby/skins/${appearance.skinId}/texture?v=${encodeURIComponent(v)}`;
  }

  function loadAppearance(entity, appearance) {
    if (!appearance) {
      entity.heightScale = DEFAULT_HEIGHT_SCALE;
      entity.texture = null;
      entity.uvAtlas = null;
      entity.appearanceKey = '';
      return Promise.resolve();
    }
    const key = `${appearance.skinId || ''}:${appearance.contentHash || ''}`;
    entity.heightScale = appearance.heightScale ?? DEFAULT_HEIGHT_SCALE;
    if (key === entity.appearanceKey && (entity.texture || entity.uvAtlas)) {
      return Promise.resolve();
    }
    entity.appearanceKey = key;
    const url = textureUrl(appearance);
    if (!url) {
      entity.texture = null;
      entity.uvAtlas = null;
      return Promise.resolve();
    }
    const cached = textureCache.get(key);
    if (cached) {
      if (appearance.kind === 'uv') {
        entity.uvAtlas = cached;
        entity.texture = null;
      } else {
        entity.texture = cached;
        entity.uvAtlas = null;
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        textureCache.set(key, image);
        if (entity.appearanceKey !== key) {
          resolve();
          return;
        }
        if (appearance.kind === 'uv') {
          entity.uvAtlas = image;
          entity.texture = null;
        } else {
          entity.texture = image;
          entity.uvAtlas = null;
        }
        resolve();
      };
      image.onerror = () => {
        if (entity.appearanceKey === key) {
          entity.texture = null;
          entity.uvAtlas = null;
        }
        resolve();
      };
      image.src = url;
    });
  }

  function drawJoint(ctx, x, y) {
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 把 UV 部位画到角色坐标：dest 是推荐区落点；
   * 若有 coreRect，则整份 rect 按同比例外扩（留白里的臂甲/长发可见）。
   * 头部整身画布没有「外扩」语义，直接 rect → dest。
   */
  function drawPartRect(ctx, style, x, y, w, h) {
    if (!style.atlas) {
      ctx.fillStyle = style.fill;
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      return;
    }
    const part = style.part;
    const [sx, sy, sw, sh] = part.rect;
    if (part.kind === 'head' || !part.coreRect) {
      ctx.drawImage(style.atlas, sx, sy, sw, sh, x, y, w, h);
      return;
    }
    const [cx, cy, cw, ch] = part.coreRect;
    const scaleX = w / cw;
    const scaleY = h / ch;
    ctx.drawImage(
      style.atlas,
      sx, sy, sw, sh,
      x - (cx - sx) * scaleX,
      y - (cy - sy) * scaleY,
      sw * scaleX,
      sh * scaleY
    );
  }

  function drawSegmentedLimb(ctx, upperStyle, lowerStyle, x, y, width, upperLength, lowerLength, upperAngle, bendAngle) {
    const showJoints = !upperStyle.atlas;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(upperAngle);
    drawPartRect(ctx, upperStyle, -width / 2, 0, width, upperLength);
    ctx.translate(0, upperLength);
    if (showJoints) drawJoint(ctx, 0, 0);
    ctx.rotate(bendAngle);
    drawPartRect(ctx, lowerStyle, -width / 2, 0, width, lowerLength);
    ctx.restore();
    if (showJoints) drawJoint(ctx, x, y);
  }

  function drawAvatarBody(ctx, entity, atlas, options = {}) {
    const parts = window.UVLayout.resolveParts(atlas);
    const rig = window.UVLayout.RIG || { shoulderX: 14, shoulderY: -14, hipX: 7, hipY: 11 };
    const kneelOffset = entity.kneel * 11;
    const joints = entity.joints;
    const style = (partId, fill) =>
      atlas ? { atlas, part: parts[partId] } : { fill };
    const limbSize = (partId, fallbackW, fallbackLen) => {
      const size = parts[partId] && parts[partId].drawSize;
      return size ? size : [fallbackW, fallbackLen];
    };
    const [backLegUW, backLegUL] = limbSize('backLegUpper', 8, 16);
    const [, backLegLL] = limbSize('backLegLower', 8, 17);
    const [backArmUW, backArmUL] = limbSize('backArmUpper', 7, 15);
    const [, backArmLL] = limbSize('backArmLower', 7, 16);
    const [frontLegUW, frontLegUL] = limbSize('frontLegUpper', 8, 16);
    const [, frontLegLL] = limbSize('frontLegLower', 8, 17);
    const [frontArmUW, frontArmUL] = limbSize('frontArmUpper', 7, 15);
    const [, frontArmLL] = limbSize('frontArmLower', 7, 16);
    const bodyDraw = (parts.body && parts.body.drawRect) || [-11, -17, 22, 26];
    const skipFrontArm = Boolean(options.skipFrontArm);
    const frontArmOnly = Boolean(options.frontArmOnly);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#111827';
    if (atlas) ctx.imageSmoothingEnabled = false;

    if (frontArmOnly) {
      drawSegmentedLimb(ctx, style('frontArmUpper', '#f97316'), style('frontArmLower', '#f97316'),
        rig.shoulderX, rig.shoulderY + kneelOffset, frontArmUW, frontArmUL, frontArmLL, joints.frontShoulder.angle, joints.frontElbow.angle);
      return;
    }

    drawSegmentedLimb(ctx, style('backLegUpper', '#3b82f6'), style('backLegLower', '#3b82f6'),
      -rig.hipX, rig.hipY + kneelOffset, backLegUW, backLegUL, backLegLL, joints.backHip.angle, joints.backKnee.angle);
    drawSegmentedLimb(ctx, style('backArmUpper', '#ef4444'), style('backArmLower', '#ef4444'),
      -rig.shoulderX, rig.shoulderY + kneelOffset, backArmUW, backArmUL, backArmLL, joints.backShoulder.angle, joints.backElbow.angle);
    drawPartRect(
      ctx,
      style('body', '#22c55e'),
      bodyDraw[0],
      bodyDraw[1] + kneelOffset,
      bodyDraw[2],
      bodyDraw[3]
    );
    drawSegmentedLimb(ctx, style('frontLegUpper', '#8b5cf6'), style('frontLegLower', '#8b5cf6'),
      rig.hipX, rig.hipY + kneelOffset, frontLegUW, frontLegUL, frontLegLL, joints.frontHip.angle, joints.frontKnee.angle);
    if (!skipFrontArm) {
      drawSegmentedLimb(ctx, style('frontArmUpper', '#f97316'), style('frontArmLower', '#f97316'),
        rig.shoulderX, rig.shoulderY + kneelOffset, frontArmUW, frontArmUL, frontArmLL, joints.frontShoulder.angle, joints.frontElbow.angle);
    }

    const headDrawRect = atlas && parts.head.drawRect
      ? parts.head.drawRect
      : [-9, -33, 18, 15];
    const headX = headDrawRect[0];
    const headY = headDrawRect[1] + kneelOffset;
    const headW = headDrawRect[2];
    const headH = headDrawRect[3];
    const pivotRect =
      atlas && parts.head.safeRect ? parts.head.safeRect : headDrawRect;
    const neckX = pivotRect[0] + pivotRect[2] / 2;
    const neckY = pivotRect[1] + kneelOffset + pivotRect[3] * 0.92;
    ctx.save();
    ctx.translate(neckX, neckY);
    ctx.rotate(entity.headLook || 0);
    ctx.translate(-neckX, -neckY);
    drawPartRect(
      ctx,
      style('head', '#facc15'),
      headX,
      headY,
      headW,
      headH
    );
    if (!atlas) {
      ctx.fillStyle = '#111827';
      ctx.fillRect(4, -28 + kneelOffset, 3, 3);
    }
    ctx.restore();
  }

  /** 套用与 drawAvatar 相同的实体变换。 */
  function withAvatarTransform(ctx, entity, drawFn) {
    ctx.save();
    ctx.translate(entity.x, entity.y);
    ctx.scale(entity.facing, 1);
    ctx.translate(0, entity.bodyBob);
    ctx.translate(0, AVATAR_SIZE / 2);
    ctx.scale(
      AVATAR_DRAW_SCALE * (1 + entity.squash * 0.35),
      AVATAR_DRAW_SCALE * entity.heightScale * (1 - entity.squash)
    );
    ctx.translate(0, -AVATAR_SIZE / 2);
    ctx.rotate(entity.lean);
    drawFn();
    ctx.restore();
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.skipFrontArm] 持枪时先跳过前臂，稍后叠在枪上
   */
  function drawAvatar(ctx, entity, view, dpr, options = {}) {
    withAvatarTransform(ctx, entity, () => {
      if (entity.uvAtlas) {
        drawAvatarBody(ctx, entity, entity.uvAtlas, options);
      } else if (entity.texture) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          entity.texture,
          -AVATAR_SIZE / 2, -AVATAR_SIZE / 2,
          AVATAR_SIZE, AVATAR_SIZE
        );
      } else {
        drawAvatarBody(ctx, entity, null, options);
      }
    });
    if (!options.skipNickname) drawNickname(ctx, entity, view, dpr);
  }

  /** 仅绘制前臂（持枪时叠在枪械之上，保证手在最前层）。 */
  function drawFrontArm(ctx, entity) {
    withAvatarTransform(ctx, entity, () => {
      const atlas = entity.uvAtlas || null;
      if (entity.texture && !atlas) return;
      drawAvatarBody(ctx, entity, atlas, { frontArmOnly: true });
    });
  }

  /** 头部颈窝的世界坐标（与 drawAvatar 变换一致，忽略微小 lean）。 */
  function neckWorldPosition(entity) {
    const parts = entity.uvAtlas ? window.UVLayout.resolveParts(entity.uvAtlas) : null;
    const headDraw = (parts && parts.head && parts.head.drawRect) || [-9, -33, 18, 15];
    const pivot =
      (parts && parts.head && parts.head.safeRect) || headDraw;
    const kneelOffset = entity.kneel * 11;
    const neckLocalY = pivot[1] + kneelOffset + pivot[3] * 0.92;
    const scaleY = AVATAR_DRAW_SCALE * entity.heightScale * (1 - entity.squash);
    const y =
      entity.y
      + entity.bodyBob
      + AVATAR_SIZE / 2 * (1 - scaleY)
      + neckLocalY * scaleY;
    return { x: entity.x, y };
  }

  // 仰角过大或身后时不跟瞄；其余夹在可转范围内。
  const HEAD_LOOK_MAX_UP = -0.42;
  const HEAD_LOOK_MAX_DOWN = 0.55;
  const HEAD_LOOK_BEHIND_DX = 18;

  /**
   * 根据世界坐标瞄准点更新本机角色看向角度（仅视觉）。
   * 鼠标在身后或抬头超过阈值时回正；targetWorld 为 null 时回正。
   */
  function updateHeadLook(entity, targetWorld, dt) {
    let target = 0;
    if (targetWorld) {
      const neck = neckWorldPosition(entity);
      const forward = (targetWorld.x - neck.x) * entity.facing;
      const dy = targetWorld.y - neck.y;
      if (forward > HEAD_LOOK_BEHIND_DX) {
        const angle = Math.atan2(dy, forward);
        if (angle >= HEAD_LOOK_MAX_UP) {
          target = Math.max(HEAD_LOOK_MAX_UP, Math.min(HEAD_LOOK_MAX_DOWN, angle));
        }
      }
    }
    stepBodySpring(entity, 'headLook', 'headLookVelocity', target, dt, 90, 14);
  }

  function drawNickname(ctx, entity, view, dpr) {
    if (!entity.nickname) return;
    const avatarScaleY = AVATAR_DRAW_SCALE * entity.heightScale * (1 - entity.squash);
    const avatarTopY = entity.y + entity.bodyBob + AVATAR_SIZE / 2 - AVATAR_SIZE * avatarScaleY;
    const screenX = entity.x * view.zoom + view.offsetX;
    const screenY = avatarTopY * view.zoom + view.offsetY - 12;
    const label = entity.nickname.length > 16
      ? `${entity.nickname.slice(0, 15)}…`
      : entity.nickname;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const paddingX = 9;
    const labelWidth = ctx.measureText(label).width + paddingX * 2;
    const labelHeight = 24;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.beginPath();
    ctx.roundRect(
      screenX - labelWidth / 2,
      screenY - labelHeight / 2,
      labelWidth,
      labelHeight,
      8
    );
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, screenX, screenY);
  }

  // 与服务端一致的归一化可用宽度（参考宽 1600），外推时把 vx 换算回 nx。
  const REF_USABLE = 1600 - AVATAR_COLLISION_WIDTH * AVATAR_DRAW_SCALE;
  const MAX_EXTRAPOLATE_S = 0.25;

  // 快照挂在服务器时间轴（serverMs）上；只保留插值所需字段。
  // Avatar 大厅用 nx；阈限月台用世界坐标 x。
  function pushSnapshot(entity, snapshot, serverMs) {
    const snaps = entity.snapshots;
    if (snaps.length > 0 && serverMs <= snaps[snaps.length - 1].serverMs) return;
    snaps.push({
      serverMs,
      nx: snapshot.nx,
      x: snapshot.x,
      y: snapshot.y,
      vx: snapshot.vx,
      vy: snapshot.vy,
      facing: snapshot.facing,
      onGround: snapshot.onGround,
      kneel: snapshot.kneel,
      gait: snapshot.gait === 'run' ? 'run' : 'walk',
      headLook: Number(snapshot.headLook) || 0,
      nickname: snapshot.nickname,
    });
    while (snaps.length > 2 && snaps[snaps.length - 1].serverMs - snaps[0].serverMs > 1500) {
      snaps.shift();
    }
  }

  function lerpSnapshots(a, b, t) {
    const useX = a.x != null && b.x != null;
    return {
      nx: a.nx + (b.nx - a.nx) * t,
      x: useX ? a.x + (b.x - a.x) * t : b.x ?? a.x,
      y: a.y + (b.y - a.y) * t,
      vx: a.vx + (b.vx - a.vx) * t,
      vy: a.vy + (b.vy - a.vy) * t,
      facing: t < 0.5 ? a.facing : b.facing,
      onGround: t < 0.5 ? a.onGround : b.onGround,
      kneel: (a.kneel ?? 0) + ((b.kneel ?? 0) - (a.kneel ?? 0)) * t,
      gait: t < 0.5 ? a.gait : b.gait,
      headLook: (a.headLook ?? 0) + ((b.headLook ?? 0) - (a.headLook ?? 0)) * t,
      nickname: b.nickname || a.nickname,
    };
  }

  // 优先在快照区间内插值；渲染时间超出最新快照时按速度做有限外推，避免定格后跳变。
  function sampleRemote(entity, renderMs) {
    const snaps = entity.snapshots;
    if (snaps.length === 0) return null;
    const newest = snaps[snaps.length - 1];
    if (renderMs >= newest.serverMs) {
      const aheadS = Math.min((renderMs - newest.serverMs) / 1000, MAX_EXTRAPOLATE_S);
      if (aheadS <= 0.001) return newest;
      const out = { ...newest };
      if (newest.x != null) {
        out.x = newest.x + newest.vx * aheadS;
      } else if (newest.nx != null) {
        out.nx = Math.max(0, Math.min(1, newest.nx + (newest.vx * aheadS) / REF_USABLE));
      }
      out.y = newest.onGround ? newest.y : Math.min(0, newest.y + newest.vy * aheadS);
      return out;
    }
    if (renderMs <= snaps[0].serverMs) return snaps[0];
    for (let i = snaps.length - 1; i > 0; i -= 1) {
      if (snaps[i - 1].serverMs <= renderMs) {
        const a = snaps[i - 1];
        const b = snaps[i];
        const span = Math.max(1, b.serverMs - a.serverMs);
        return lerpSnapshots(a, b, (renderMs - a.serverMs) / span);
      }
    }
    return snaps[0];
  }

  /**
   * 角色局部点 → 世界坐标（与 drawAvatar 变换一致，含 lean）。
   * 局部约定：面向右时 +X 向前，+Y 向下，原点在实体锚点（身中）。
   */
  function localPointToWorld(entity, localX, localY) {
    const facing = entity.facing >= 0 ? 1 : -1;
    const sx = AVATAR_DRAW_SCALE * (1 + (entity.squash || 0) * 0.35);
    const sy = AVATAR_DRAW_SCALE * (entity.heightScale || 1) * (1 - (entity.squash || 0));
    const bob = entity.bodyBob || 0;
    const lean = entity.lean || 0;
    const c = Math.cos(lean);
    const s = Math.sin(lean);
    const lx = localX * c - localY * s;
    const ly = localX * s + localY * c;
    return {
      x: entity.x + facing * sx * lx,
      y: entity.y + bob + AVATAR_SIZE / 2 + sy * (ly - AVATAR_SIZE / 2),
    };
  }

  /**
   * 双段肢末端局部坐标（上臂角 + 肘弯；骨骼沿 +Y 绘制）。
   * 画布正角顺时针：局部 (0,L) → (-L·sinθ, L·cosθ)。
   */
  function limbTipLocal(originX, originY, upperLen, lowerLen, shoulderAngle, elbowAngle, alongLower = 1) {
    const midX = originX - Math.sin(shoulderAngle) * upperLen;
    const midY = originY + Math.cos(shoulderAngle) * upperLen;
    const tipAngle = shoulderAngle + elbowAngle;
    const t = Math.max(0, Math.min(1, alongLower));
    return {
      x: midX - Math.sin(tipAngle) * lowerLen * t,
      y: midY + Math.cos(tipAngle) * lowerLen * t,
    };
  }

  /** 前臂握枪掌心世界坐标（靠近指节，避免枪锚在掌心导致指尖穿模）。 */
  function getFrontHandWorld(entity, alongLower = 0.88) {
    const rig = window.UVLayout?.RIG || { shoulderX: 11, shoulderY: -16 };
    const parts = entity.uvAtlas ? window.UVLayout.resolveParts(entity.uvAtlas) : null;
    const upperLen = parts?.frontArmUpper?.drawSize?.[1] ?? 15;
    const lowerLen = parts?.frontArmLower?.drawSize?.[1] ?? 16;
    const kneelOffset = (entity.kneel || 0) * 11;
    const sh = entity.joints?.frontShoulder?.angle ?? 0;
    const el = entity.joints?.frontElbow?.angle ?? 0;
    const palm = limbTipLocal(
      rig.shoulderX,
      rig.shoulderY + kneelOffset,
      upperLen,
      lowerLen,
      sh,
      el,
      alongLower
    );
    return localPointToWorld(entity, palm.x, palm.y);
  }

  /** 后臂手部世界坐标（护木/扶匣）。 */
  function getBackHandWorld(entity, alongLower = 0.88) {
    const rig = window.UVLayout?.RIG || { shoulderX: 11, shoulderY: -16 };
    const parts = entity.uvAtlas ? window.UVLayout.resolveParts(entity.uvAtlas) : null;
    const upperLen = parts?.backArmUpper?.drawSize?.[1] ?? 15;
    const lowerLen = parts?.backArmLower?.drawSize?.[1] ?? 16;
    const kneelOffset = (entity.kneel || 0) * 11;
    const sh = entity.joints?.backShoulder?.angle ?? 0;
    const el = entity.joints?.backElbow?.angle ?? 0;
    const palm = limbTipLocal(
      -rig.shoulderX,
      rig.shoulderY + kneelOffset,
      upperLen,
      lowerLen,
      sh,
      el,
      alongLower
    );
    return localPointToWorld(entity, palm.x, palm.y);
  }

  /** 前肩世界坐标。 */
  function getFrontShoulderWorld(entity) {
    const rig = window.UVLayout?.RIG || { shoulderX: 11, shoulderY: -16 };
    const kneelOffset = (entity.kneel || 0) * 11;
    return localPointToWorld(entity, rig.shoulderX, rig.shoulderY + kneelOffset);
  }

  /** 后肩世界坐标。 */
  function getBackShoulderWorld(entity) {
    const rig = window.UVLayout?.RIG || { shoulderX: 11, shoulderY: -16 };
    const kneelOffset = (entity.kneel || 0) * 11;
    return localPointToWorld(entity, -rig.shoulderX, rig.shoulderY + kneelOffset);
  }

  /**
   * 将手臂设为指向世界瞄准点（持枪/指向；大厅与月台共用）。
   * 直接写关节角并清速度，覆盖程序化摆臂。
   */
  function applyAimArmPose(entity, aimWorld) {
    if (!entity?.joints || !aimWorld || !window.ProceduralMotion?.computeAimArmPose) return;
    const facing = entity.facing >= 0 ? 1 : -1;
    const shoulder = getFrontShoulderWorld(entity);
    const localAimX = (aimWorld.x - shoulder.x) * facing;
    const localAimY = aimWorld.y - shoulder.y;
    const pose = window.ProceduralMotion.computeAimArmPose(localAimX, localAimY);
    const map = [
      ['frontShoulder', pose.frontShoulder],
      ['frontElbow', pose.frontElbow],
      ['backShoulder', pose.backShoulder],
      ['backElbow', pose.backElbow],
    ];
    for (const [key, angle] of map) {
      const joint = entity.joints[key];
      if (!joint) continue;
      joint.angle = angle;
      joint.velocity = 0;
    }
  }

  window.AvatarEntity = {
    AVATAR_SIZE,
    AVATAR_DRAW_SCALE,
    AVATAR_COLLISION_WIDTH,
    DEFAULT_HEIGHT_SCALE,
    MOVE_SPEED,
    RUN_SPEED,
    createAvatarEntity,
    updateEntityMotion,
    updateHeadLook,
    loadAppearance,
    drawAvatar,
    drawFrontArm,
    footGroundLiftPx,
    localPointToWorld,
    getFrontHandWorld,
    getBackHandWorld,
    getFrontShoulderWorld,
    getBackShoulderWorld,
    applyAimArmPose,
    pushSnapshot,
    sampleRemote,
  };
})();
