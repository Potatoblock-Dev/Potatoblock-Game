/**
 * 手持武器姿态：枪械绘制、枪口与抛壳点（随瞄准方向）。
 * 握把锚优先用 AvatarEntity.getFirearmHoldWorld（程序化附着点），与臂 IK 同源。
 * 过中垂线（枪口朝左）时纵向镜像，与卫兵防御炮塔一致；可用 item.autoMirror: false 关闭。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const Entity = window.AvatarEntity;
  /** @type {Map<string, { img: HTMLImageElement, ok: boolean, failed: boolean }>} */
  const spriteCache = new Map();

  /** 加载武器世界贴图（优先 holdSprite，否则 icon）；失败不永久卡死缓存。 */
  function getSprite(item) {
    const url = item?.holdSprite || item?.icon;
    if (!url) return null;
    let entry = spriteCache.get(url);
    if (!entry) {
      const img = new Image();
      entry = { img, ok: false, failed: false };
      spriteCache.set(url, entry);
      img.onload = () => {
        entry.ok = img.naturalWidth > 0;
        entry.failed = !entry.ok;
      };
      img.onerror = () => {
        entry.ok = false;
        entry.failed = true;
      };
      img.src = url;
    }
    if (entry.failed || !entry.ok) return null;
    return entry.img;
  }

  /**
   * 枪管朝左时纵向镜像（贴图默认朝右）。
   * @param {number} angle 枪管世界角
   * @param {object} [item]
   */
  function shouldMirrorY(angle, item) {
    if (item && item.autoMirror === false) return false;
    return Math.cos(angle) < 0;
  }

  /** 握把回退（无附着点 API 时）。 */
  function fallbackGrip(avatar, item) {
    const facing = avatar.facing >= 0 ? 1 : -1;
    const gripOffX = item?.gripOffset?.x ?? 22;
    const gripOffY = item?.gripOffset?.y ?? -22;
    return {
      x: avatar.x + facing * gripOffX,
      y: avatar.y + (avatar.bodyBob || 0) + gripOffY,
    };
  }

  /**
   * 握把世界坐标 + 枪管朝向角 + 是否纵向镜像。
   * @param {{ x: number, y: number, facing: number, bodyBob?: number, joints?: object }} avatar
   * @param {{ x: number, y: number }} aim
   * @param {object} [item]
   */
  function getHoldPose(avatar, aim, item) {
    const facing = avatar.facing >= 0 ? 1 : -1;
    const hold = Entity?.getFirearmHoldWorld?.(avatar, aim, item?.holdPose);
    const gripX = hold?.gripX;
    const gripY = hold?.gripY;
    const hand = (Number.isFinite(gripX) && Number.isFinite(gripY))
      ? { x: gripX, y: gripY }
      : (Entity?.getBackHandWorld?.(avatar) || Entity?.getFrontHandWorld?.(avatar) || fallbackGrip(avatar, item));
    const angle = Number.isFinite(hold?.angle)
      ? hold.angle
      : Math.atan2(aim.y - hand.y, aim.x - hand.x);
    const flipY = shouldMirrorY(angle, item);
    return {
      gripX: hand.x,
      gripY: hand.y,
      angle,
      facing,
      flipY,
      mirrorY: flipY ? -1 : 1,
    };
  }

  /** 将枪本地点转到世界坐标（含过中轴纵向镜像）。 */
  function localToWorld(pose, lx, ly) {
    const my = (pose.mirrorY ?? 1) * ly;
    const c = Math.cos(pose.angle);
    const s = Math.sin(pose.angle);
    return {
      x: pose.gripX + c * lx - s * my,
      y: pose.gripY + s * lx + c * my,
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
    if (pose.flipY) ctx.scale(1, -1);
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

  /** 持枪：双臂 IK 到物品 holdPose 附着点（可复用默认规格）。 */
  function applyAimArmPose(avatar, aim, item) {
    Entity?.applyAimArmPose?.(avatar, aim, item?.holdPose);
  }

  window.LpWeaponHold = {
    getHoldPose,
    getMuzzleWorld,
    getEjectWorld,
    drawHeldWeapon,
    applyAimArmPose,
    getSprite,
    shouldMirrorY,
    localToWorld,
  };
})();
