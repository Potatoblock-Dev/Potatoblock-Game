/**
 * 换弹动作模组：抬枪露匣 → 后手 IK 扶顶匣 → 插入关键帧入弹 → 回瞄。
 * 前臂始终与枪管同轴（复用瞄准解算），避免枪手分离。
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
      /* 后手扶匣强度 0–1 */
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
   * 持枪附着点跟瞄；后手按进度 IK 到顶匣（换弹时临时覆盖护木手）。
   */
  function applyArmPose(avatar) {
    if (!active || !avatar?.joints) return false;
    const aim = getAimOverride(avatar);
    if (!aim) return false;
    Entity?.applyAimArmPose?.(avatar, aim, active.item?.holdPose);

    const reachW = sampleSeries(active._style.reach, getProgress());
    if (reachW < 0.05 || !Motion?.computeArmReachPose) return true;

    const well = getMagWellWorld(avatar, aim);
    const backShoulderWorld = Entity?.getBackShoulderWorld?.(avatar);
    if (!well || !backShoulderWorld) return true;

    const facing = avatar.facing >= 0 ? 1 : -1;
    const localX = (well.x - backShoulderWorld.x) * facing;
    const localY = well.y - backShoulderWorld.y;
    const reach = Motion.computeArmReachPose(localX, localY);
    const bsh = avatar.joints.backShoulder;
    const bel = avatar.joints.backElbow;
    if (bsh) {
      bsh.angle = Motion.lerp(bsh.angle, reach.shoulder, reachW);
      bsh.velocity = 0;
    }
    if (bel) {
      bel.angle = Motion.lerp(bel.angle, reach.elbow, reachW);
      bel.velocity = 0;
    }
    return true;
  }

  /** 绘制顶匣道具（沿后手 → 匣井）。 */
  function draw(ctx, avatar, aim) {
    if (!active || active.style !== 'top_mag') return;
    const t = getProgress();
    const reachW = sampleSeries(active._style.reach, t);
    if (reachW < 0.08 || t > 0.78) return;

    const item = active.item;
    const well = getMagWellWorld(avatar, aim);
    const backHand = Entity?.getBackHandWorld?.(avatar);
    if (!well || !backHand) return;

    const u = Math.min(1, reachW);
    const mx = backHand.x + (well.x - backHand.x) * Math.min(1, u * 1.15);
    const my = backHand.y + (well.y - backHand.y) * Math.min(1, u * 1.15);
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
