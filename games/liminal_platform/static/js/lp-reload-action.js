/**
 * 换弹动作模组：抬枪露匣 → 护木手 IK 扶顶匣 → 插入关键帧入弹 → 回瞄。
 * 扳机握把手始终与枪管同轴（复用瞄准解算），避免枪手分离。
 */
(() => {
  const Entity = window.AvatarEntity;
  const Motion = window.ProceduralMotion;

  /** @type {null | object} */
  let active = null;

  const STYLES = {
    top_mag: {
      duration: 0.92,
      commitAt: 0.52,
      /* 枪口上扬角（世界：0=右，负=上） */
      gunTilt: [-0.25, -0.95, -0.85, -0.45, -0.15],
      /* 护木手扶匣强度 0–1 */
      reach: [0, 0.35, 1, 1, 0.55, 0.15, 0],
      magLocal: { x: 14, y: -10 },
    },
    default: {
      duration: 0.85,
      commitAt: 0.48,
      gunTilt: [-0.15, -0.5, -0.35, -0.2, -0.08],
      reach: [0, 0.5, 1, 0.7, 0.2, 0],
      magLocal: { x: 8, y: 8 },
    },
  };

  /** 读取风格（缺省 default，GUR 等显式 top_mag）。 */
  function resolveStyle(item) {
    const key =
      item?.reloadStyle && STYLES[item.reloadStyle] ? item.reloadStyle : 'default';
    const base = STYLES[key] || STYLES.default;
    return {
      ...base,
      duration: item?.reloadDuration ?? base.duration,
      key,
    };
  }

  function sampleSeries(series, t) {
    const u = Motion?.clamp ? Motion.clamp(t, 0, 1) : Math.max(0, Math.min(1, t));
    if (!series?.length) return 0;
    if (series.length === 1) return series[0];
    const scaled = u * (series.length - 1);
    const i = Math.min(series.length - 2, Math.floor(scaled));
    const w = scaled - i;
    const lerp = Motion?.lerp || ((a, b, k) => a + (b - a) * k);
    return lerp(series[i], series[i + 1], w);
  }

  function isBusy() {
    return Boolean(active);
  }

  function getProgress() {
    if (!active) return 0;
    return Math.max(0, Math.min(1, active.elapsed / active.duration));
  }

  function begin(options) {
    if (active || !options?.item || typeof options.onCommit !== 'function') return false;
    const style = resolveStyle(options.item);
    active = {
      item: options.item,
      style: style.key,
      duration: style.duration,
      elapsed: 0,
      committed: false,
      onCommit: options.onCommit,
      onDone: options.onDone,
      _style: style,
    };
    return true;
  }

  function cancel() {
    active = null;
  }

  function tick(dt) {
    if (!active) return;
    active.elapsed += Math.max(0, dt);
    const t = getProgress();
    if (!active.committed && t >= (active._style.commitAt ?? 0.5)) {
      active.committed = true;
      const ok = active.onCommit();
      if (!ok) {
        window.LiminalInteract?.showToast?.('装填失败');
        const done = active.onDone;
        active = null;
        done?.();
        return;
      }
    }
    if (t >= 1) {
      const done = active.onDone;
      active = null;
      done?.();
    }
  }

  /** 换弹时抬枪瞄准点（须远超手臂长度，避免手越过目标导致枪口反向下垂）。 */
  function getAimOverride(avatar) {
    if (!active || !avatar) return null;
    const facing = avatar.facing >= 0 ? 1 : -1;
    const tilt = sampleSeries(active._style.gunTilt, getProgress());
    const dist = 200;
    return {
      x: avatar.x + facing * Math.cos(tilt) * dist,
      y: avatar.y - 8 + Math.sin(tilt) * dist,
    };
  }

  /** 顶匣世界坐标（相对当前持枪姿）。 */
  function getMagWellWorld(avatar, aim) {
    const item = active?.item;
    const pose = window.LpWeaponHold?.getHoldPose?.(avatar, aim, item);
    if (!pose) return null;
    const loc = active._style.magLocal || { x: 14, y: -10 };
    return window.LpWeaponHold.localToWorld(pose, loc.x, loc.y);
  }

  /**
   * 持枪附着点跟瞄；护木手按进度 IK 到顶匣（换弹时临时覆盖 forendLimb）。
   */
  function applyArmPose(avatar) {
    if (!active || !avatar?.joints) return false;
    const aim = getAimOverride(avatar);
    if (!aim) return false;
    const holdPose =
      window.LpWeaponHold?.resolveHoldPose?.(active.item) ?? active.item?.holdPose;
    Entity?.applyAimArmPose?.(avatar, aim, holdPose);

    const reachW = sampleSeries(active._style.reach, getProgress());
    if (reachW < 0.05 || !Motion?.computeArmReachPose) return true;

    const well = getMagWellWorld(avatar, aim);
    const forendIsBack = (holdPose?.forendLimb || 'front') === 'back';
    const forendShoulderWorld = forendIsBack
      ? Entity?.getBackShoulderWorld?.(avatar)
      : Entity?.getFrontShoulderWorld?.(avatar);
    if (!well || !forendShoulderWorld) return true;

    const facing = avatar.facing >= 0 ? 1 : -1;
    const localX = (well.x - forendShoulderWorld.x) * facing;
    const localY = well.y - forendShoulderWorld.y;
    const reach = Motion.computeArmReachPose(localX, localY);
    const shJoint = forendIsBack
      ? avatar.joints.backShoulder
      : avatar.joints.frontShoulder;
    const elJoint = forendIsBack
      ? avatar.joints.backElbow
      : avatar.joints.frontElbow;
    if (shJoint) {
      shJoint.angle = Motion.lerp(shJoint.angle, reach.shoulder, reachW);
      shJoint.velocity = 0;
    }
    if (elJoint) {
      elJoint.angle = Motion.lerp(elJoint.angle, reach.elbow, reachW);
      elJoint.velocity = 0;
    }
    return true;
  }

  /** 绘制顶匣道具（沿护木手 → 匣井）。 */
  function draw(ctx, avatar, aim) {
    if (!active || active.style !== 'top_mag') return;
    const t = getProgress();
    const reachW = sampleSeries(active._style.reach, t);
    if (reachW < 0.08 || t > 0.78) return;

    const item = active.item;
    const well = getMagWellWorld(avatar, aim);
    const holdPose =
      window.LpWeaponHold?.resolveHoldPose?.(item) ?? item?.holdPose;
    const forendIsBack = (holdPose?.forendLimb || 'front') === 'back';
    const forendHand = forendIsBack
      ? Entity?.getBackHandWorld?.(avatar)
      : Entity?.getFrontHandWorld?.(avatar);
    if (!well || !forendHand) return;

    const u = Math.min(1, reachW);
    const mx = forendHand.x + (well.x - forendHand.x) * Math.min(1, u * 1.15);
    const my = forendHand.y + (well.y - forendHand.y) * Math.min(1, u * 1.15);
    const scale = t > 0.5 ? Math.max(0.15, 1 - (t - 0.5) * 2.2) : 1;
    if (scale <= 0.05) return;

    const pose = window.LpWeaponHold?.getHoldPose?.(avatar, aim, item);
    const mw = 6 * scale;
    const mh = 12 * scale;
    ctx.save();
    ctx.translate(mx, my);
    if (pose) {
      ctx.rotate(pose.angle);
      if (pose.flipY) ctx.scale(1, -1);
    }
    ctx.fillStyle = item.color || '#1f2937';
    ctx.fillRect(-mw / 2, -mh, mw, mh);
    ctx.fillStyle = item.accent || '#9ca3af';
    ctx.fillRect(-mw / 2, -mh, mw, 2.5 * scale);
    ctx.restore();
  }

  window.LpReloadAction = {
    begin,
    cancel,
    tick,
    isBusy,
    getProgress,
    getAimOverride,
    applyArmPose,
    draw,
    STYLES,
  };
})();
