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
  /** 步行目标水平速度（px/s）。 */
  const MOVE_SPEED = 340;
  /** 奔跑目标水平速度（px/s）。 */
  const RUN_SPEED = 545;

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

  /**
   * 按速度推进步态相位与关节弹簧；cadence 随 MOVE/RUN_SPEED 同比放大，避免脚滑。
   */
  function updateEntityMotion(entity, dt) {
    const gait = entity.gait === 'run' ? 'run' : 'walk';
    const refSpeed = gait === 'run' ? RUN_SPEED : MOVE_SPEED;
    const speedRatio = Math.min(Math.abs(entity.vx) / refSpeed, 1);
    if (speedRatio > 0.03 && entity.onGround) {
      // 相对旧 260/420 约 ×1.3，保持满速步幅与提速前接近。
      const cadence = gait === 'run' ? 9.4 + speedRatio * 12.4 : 6.5 + speedRatio * 9.1;
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
    return window.AvatarSkinCache?.textureUrl?.(appearance)
      ?? (appearance?.skinId
        ? `/avatar-lobby/skins/${appearance.skinId}/texture?v=${encodeURIComponent(appearance.contentHash || '')}`
        : null);
  }

  function applyLoadedTexture(entity, appearance, key, image) {
    if (entity.appearanceKey !== key) return;
    if (appearance.kind === 'uv') {
      entity.uvAtlas = image;
      entity.texture = null;
    } else {
      entity.texture = image;
      entity.uvAtlas = null;
    }
  }

  function clearLoadedTexture(entity, key) {
    if (entity.appearanceKey !== key) return;
    entity.texture = null;
    entity.uvAtlas = null;
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

    const SkinCache = window.AvatarSkinCache;
    if (SkinCache?.loadImage) {
      return SkinCache.loadImage(url).then((image) => {
        applyLoadedTexture(entity, appearance, key, image);
      }).catch(() => {
        clearLoadedTexture(entity, key);
      });
    }

    return new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        applyLoadedTexture(entity, appearance, key, image);
        resolve();
      };
      image.onerror = () => {
        clearLoadedTexture(entity, key);
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

  /** 绘制肢体/身/头；持枪 skipBackArm 时前臂提前到身下，后臂由外部叠在枪上。 */
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
    /* 左右臂共用段宽，避免皮套不对称或数值漂移造成粗细不一 */
    const armUW = Math.max(frontArmUW, backArmUW);
    const armUL = Math.max(frontArmUL, backArmUL);
    const armLL = Math.max(frontArmLL, backArmLL);
    const bodyDraw = (parts.body && parts.body.drawRect) || [-11, -17, 22, 26];
    const skipFrontArm = Boolean(options.skipFrontArm);
    const skipBackArm = Boolean(options.skipBackArm);
    const frontArmOnly = Boolean(options.frontArmOnly);
    const backArmOnly = Boolean(options.backArmOnly);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#111827';
    if (atlas) ctx.imageSmoothingEnabled = false;

    if (backArmOnly) {
      drawSegmentedLimb(ctx, style('backArmUpper', '#ef4444'), style('backArmLower', '#ef4444'),
        -rig.shoulderX, rig.shoulderY + kneelOffset, armUW, armUL, armLL, joints.backShoulder.angle, joints.backElbow.angle);
      return;
    }
    if (frontArmOnly) {
      drawSegmentedLimb(ctx, style('frontArmUpper', '#f97316'), style('frontArmLower', '#f97316'),
        rig.shoulderX, rig.shoulderY + kneelOffset, armUW, armUL, armLL, joints.frontShoulder.angle, joints.frontElbow.angle);
      return;
    }

    drawSegmentedLimb(ctx, style('backLegUpper', '#3b82f6'), style('backLegLower', '#3b82f6'),
      -rig.hipX, rig.hipY + kneelOffset, backLegUW, backLegUL, backLegLL, joints.backHip.angle, joints.backKnee.angle);
    if (!skipBackArm) {
      drawSegmentedLimb(ctx, style('backArmUpper', '#ef4444'), style('backArmLower', '#ef4444'),
        -rig.shoulderX, rig.shoulderY + kneelOffset, armUW, armUL, armLL, joints.backShoulder.angle, joints.backElbow.angle);
    } else if (!skipFrontArm) {
      /* 持枪：后臂延后到枪上；前臂（橙/护木）提前到身躯下 */
      drawSegmentedLimb(ctx, style('frontArmUpper', '#f97316'), style('frontArmLower', '#f97316'),
        rig.shoulderX, rig.shoulderY + kneelOffset, armUW, armUL, armLL, joints.frontShoulder.angle, joints.frontElbow.angle);
    }
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
    if (!skipFrontArm && !skipBackArm) {
      drawSegmentedLimb(ctx, style('frontArmUpper', '#f97316'), style('frontArmLower', '#f97316'),
        rig.shoulderX, rig.shoulderY + kneelOffset, armUW, armUL, armLL, joints.frontShoulder.angle, joints.frontElbow.angle);
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
   * 绘制整身；持枪时传 skipBackArm，前臂自动画在身下，后臂由 drawBackArm 叠在枪上。
   * @param {object} [options]
   * @param {boolean} [options.skipFrontArm] 跳过前臂（与 skipBackArm 同用时可全外部叠臂）
   * @param {boolean} [options.skipBackArm] 持枪：跳过后臂并提前画前臂（橙在身/头/枪下）
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

  /** 仅绘制后臂（红/握把；持枪时叠在枪、身、头之上）。 */
  function drawBackArm(ctx, entity) {
    withAvatarTransform(ctx, entity, () => {
      const atlas = entity.uvAtlas || null;
      if (entity.texture && !atlas) return;
      drawAvatarBody(ctx, entity, atlas, { backArmOnly: true });
    });
  }

  /** 仅绘制前臂（橙/护木；持枪时通常已由 skipBackArm 提前画在身下，少单独调用）。 */
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

  /**
   * 在屏幕空间画昵称；必须 save/restore，避免 setTransform 清掉相机矩阵，
   * 导致随后的持枪手/枪在错误坐标系里画到画布边角。
   */
  function drawNickname(ctx, entity, view, dpr) {
    if (!entity.nickname) return;
    const avatarScaleY = AVATAR_DRAW_SCALE * entity.heightScale * (1 - entity.squash);
    const avatarTopY = entity.y + entity.bodyBob + AVATAR_SIZE / 2 - AVATAR_SIZE * avatarScaleY;
    const screenX = entity.x * view.zoom + view.offsetX;
    const screenY = avatarTopY * view.zoom + view.offsetY - 12;
    const label = entity.nickname.length > 16
      ? `${entity.nickname.slice(0, 15)}…`
      : entity.nickname;

    ctx.save();
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
    ctx.restore();
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

  /** 前臂掌心世界坐标（默认规格下为护木手；靠近指节）。 */
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

  /** 后臂手部世界坐标（默认规格下为扳机握把手）。 */
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
   * 瞄准局部坐标（相对胸口，已按 facing 折到面向 +X）。
   * 用胸原点而非前肩，避免近身瞄准时方向抖动；与持枪附着点同源。
   */
  function aimToLocal(entity, aimWorld) {
    const facing = entity.facing >= 0 ? 1 : -1;
    const chest = localPointToWorld(entity, 0, -11);
    return {
      facing,
      x: (aimWorld.x - chest.x) * facing,
      y: aimWorld.y - chest.y,
    };
  }

  /**
   * 火器握把世界坐标 + 枪管角（由可复用附着点解算，不跟漂手尖）。
   * holdSpec 来自物品 holdPose，缺省用 ProceduralMotion 默认。
   */
  function getFirearmHoldWorld(entity, aimWorld, holdSpec) {
    const Motion = window.ProceduralMotion;
    if (!entity || !aimWorld || !Motion?.computeFirearmAttachLocals) return null;
    const local = aimToLocal(entity, aimWorld);
    const attach = Motion.computeFirearmAttachLocals(local.x, local.y, holdSpec);
    const grip = localPointToWorld(entity, attach.grip.x, attach.grip.y);
    const forend = localPointToWorld(entity, attach.forend.x, attach.forend.y);
    const angle = Math.atan2(aimWorld.y - grip.y, aimWorld.x - grip.x);
    return {
      gripX: grip.x,
      gripY: grip.y,
      forendX: forend.x,
      forendY: forend.y,
      angle,
      facing: local.facing,
      attach,
    };
  }

  /**
   * 将手臂设为持枪/指向姿态（大厅与月台共用；holdSpec 可选）。
   * 直接写关节角并清速度，覆盖程序化摆臂。
   */
  function applyAimArmPose(entity, aimWorld, holdSpec) {
    if (!entity?.joints || !aimWorld || !window.ProceduralMotion?.computeAimArmPose) return;
    const local = aimToLocal(entity, aimWorld);
    const pose = window.ProceduralMotion.computeAimArmPose(local.x, local.y, holdSpec);
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
    drawBackArm,
    drawFrontArm,
    footGroundLiftPx,
    localPointToWorld,
    getFrontHandWorld,
    getBackHandWorld,
    getFrontShoulderWorld,
    getBackShoulderWorld,
    getFirearmHoldWorld,
    applyAimArmPose,
    pushSnapshot,
    sampleRemote,
  };
})();
