/**
 * 手持武器姿态：枪械绘制、枪口与抛壳点（随瞄准方向）。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const spriteCache = new Map();

  /** 加载武器世界贴图（优先 holdSprite，否则 icon）。 */
  function getSprite(item) {
    const url = item?.holdSprite || item?.icon;
    if (!url) return null;
    let img = spriteCache.get(url);
    if (img) return img.complete && img.naturalWidth ? img : null;
    img = new Image();
    img.src = url;
    spriteCache.set(url, img);
    return img.complete && img.naturalWidth ? img : null;
  }

  /**
   * 握把世界坐标 + 枪管朝向角。
   * @param {{ x: number, y: number, facing: number, bodyBob?: number }} avatar
   * @param {{ x: number, y: number }} aim
   * @param {object} [item]
   */
  function getHoldPose(avatar, aim, item) {
    const facing = avatar.facing >= 0 ? 1 : -1;
    const gripOffX = item?.gripOffset?.x ?? 16;
    const gripOffY = item?.gripOffset?.y ?? -50;
    const gripX = avatar.x + facing * gripOffX;
    const gripY = avatar.y + (avatar.bodyBob || 0) + gripOffY;
    const angle = Math.atan2(aim.y - gripY, aim.x - gripX);
    return { gripX, gripY, angle, facing };
  }

  /** 将枪本地点转到世界坐标。 */
  function localToWorld(pose, lx, ly) {
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    return {
      x: pose.gripX + c * lx - s * ly,
      y: pose.gripY + s * lx + c * ly,
    };
  }

  /** 枪口世界坐标。 */
  function getMuzzleWorld(avatar, aim, item) {
    const pose = getHoldPose(avatar, aim, item);
    const len = item?.muzzleLength ?? 34;
    const my = item?.muzzleOffsetY ?? -2;
    return localToWorld(pose, len, my);
  }

  /** 抛壳口世界坐标。 */
  function getEjectWorld(avatar, aim, item) {
    const pose = getHoldPose(avatar, aim, item);
    const ex = item?.ejectLocal?.x ?? 10;
    const ey = item?.ejectLocal?.y ?? -7;
    return localToWorld(pose, ex, ey);
  }

  /**
   * 绘制手持枪械（在 avatar 之后、曳光之前调用）。
   * @returns {object|null} hold pose
   */
  function drawHeldWeapon(ctx, avatar, aim, item) {
    if (!item || !Catalog?.isWeapon?.(item.id)) return null;
    const pose = getHoldPose(avatar, aim, item);
    const img = getSprite(item);
    const drawW = item.holdDrawW ?? 46;
    const drawH = item.holdDrawH ?? 20;
    const pivotX = item.holdPivotX ?? 10;
    const pivotY = item.holdPivotY ?? drawH * 0.55;

    ctx.save();
    ctx.translate(pose.gripX, pose.gripY);
    ctx.rotate(pose.angle);
    if (img) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, -pivotX, -pivotY, drawW, drawH);
    } else {
      ctx.fillStyle = item.color || '#374151';
      ctx.fillRect(-pivotX, -pivotY * 0.4, drawW, drawH * 0.55);
      ctx.fillStyle = item.accent || '#9ca3af';
      ctx.fillRect(drawW - pivotX - 8, -2, 8, 4);
    }
    ctx.restore();
    return pose;
  }

  /**
   * 持枪时把前臂朝向瞄准点（覆盖程序化摆臂）。
   */
  function applyAimArmPose(avatar, aim) {
    if (!avatar?.joints || !aim) return;
    const facing = avatar.facing >= 0 ? 1 : -1;
    const bob = avatar.bodyBob || 0;
    const shoulderX = avatar.x + facing * 18;
    const shoulderY = avatar.y + bob - 48;
    const localAimX = (aim.x - shoulderX) * facing;
    const localAimY = aim.y - shoulderY;
    const shoulderAngle = Math.atan2(localAimY, localAimX) - Math.PI / 2;
    const clamped = Math.max(-2.4, Math.min(0.6, shoulderAngle));
    const front = avatar.joints.frontShoulder;
    const frontElbow = avatar.joints.frontElbow;
    const back = avatar.joints.backShoulder;
    const backElbow = avatar.joints.backElbow;
    if (front) {
      front.angle = clamped;
      front.velocity = 0;
    }
    if (frontElbow) {
      frontElbow.angle = 0.42;
      frontElbow.velocity = 0;
    }
    if (back) {
      back.angle = clamped * 0.55;
      back.velocity = 0;
    }
    if (backElbow) {
      backElbow.angle = 0.55;
      backElbow.velocity = 0;
    }
  }

  window.LpWeaponHold = {
    getHoldPose,
    getMuzzleWorld,
    getEjectWorld,
    drawHeldWeapon,
    applyAimArmPose,
    getSprite,
  };
})();
