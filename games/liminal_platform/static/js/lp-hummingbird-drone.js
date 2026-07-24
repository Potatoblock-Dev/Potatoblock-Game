/**
 * 蜂鸟护卫无人机：手部栏装备后本地伴飞，自动点射小口径弹药。
 *
 * 规则摘要：
 * - 任意手部主手槽（0/1）有本物品即生成伴飞体；移出则销毁。
 * - 未选中：悬停玩家旁，优先打离玩家最近的敌人。
 * - 选中：环绕准星附近（仍钳制在玩家身边），优先打离准星最近的敌人。
 * - 射程：玩家左右各约半节车厢（0.5 * MODULE_W）。
 * - 攻击：3 连发点射；弹匣 stack.mag，上限 120；装填消耗小口径子弹。
 * - 联机：本地伴飞与本地弹道先行；其它客户端不同步无人机实体（见模块末尾注释）。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const ITEM_ID = 'hummingbird_drone';

  /** 左右各半节车厢 → 相对玩家的水平交战半径。 */
  function engageRangeX() {
    const Spec = window.LiminalCarriageSpec;
    const moduleW = Number(Spec?.MODULE_W) || 1980;
    return 0.5 * moduleW;
  }

  const imgs = {
    body: null,
    barrel: null,
  };

  /** 运行时伴飞状态；无手部无人机时为 null。 */
  let drone = null;

  /**
   * 预加载机身 / 炮管贴图。
   * @param {string} bodyUrl
   * @param {string} barrelUrl
   */
  function preload(bodyUrl, barrelUrl) {
    if (bodyUrl) {
      const img = new Image();
      img.src = bodyUrl;
      imgs.body = img;
    }
    if (barrelUrl) {
      const img = new Image();
      img.src = barrelUrl;
      imgs.barrel = img;
    }
  }

  /** 手部栏中的蜂鸟无人机槽（任一主手格）；初始化缺省弹匣。 */
  function getDroneHandSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isCompanionDrone) return null;
    for (let index = 0; index < hands.size(); index += 1) {
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isCompanionDrone(stack.itemId)) continue;
      const item = Catalog.getItem(stack.itemId);
      if (!item) continue;
      if (item.magazineSize != null && stack.mag == null) {
        stack = hands.updateSlot?.(index, { mag: item.magazineSize }) || {
          ...stack,
          mag: item.magazineSize,
        };
      }
      return { hands, index, stack, item };
    }
    return null;
  }

  /** 当前选中手部槽是否就是蜂鸟无人机。 */
  function isDroneSelected() {
    const held = getDroneHandSlot();
    if (!held) return false;
    const active = window.LpHandsHud?.getActiveIndex?.();
    return active === held.index;
  }

  /** 销毁伴飞运行时（卸下手部栏）。 */
  function despawn() {
    drone = null;
  }

  /**
   * 确保伴飞体存在并挂上图鉴绘制参数。
   * @param {object} item
   * @param {{ playerX: number, playerY: number, facing: number }} [anchor]
   */
  function ensureSpawn(item, anchor) {
    if (drone) return drone;
    if (item?.bodySprite) preload(item.bodySprite, item.barrelSprite);
    const facing = anchor?.facing >= 0 ? 1 : -1;
    const px = Number(anchor?.playerX) || 0;
    const py = Number(anchor?.playerY) || 0;
    drone = {
      x: px + facing * 36,
      y: py - 78,
      vx: 0,
      vy: 0,
      aimAngle: facing >= 0 ? 0 : Math.PI,
      facing,
      bobT: Math.random() * Math.PI * 2,
      burstLeft: 0,
      shotCd: 0.35,
      targetId: null,
    };
    return drone;
  }

  /**
   * 在交战半径内按锚点选最近敌人。
   * @param {number} anchorX
   * @param {number} anchorY
   * @param {number} playerX
   * @returns {object|null}
   */
  function pickTarget(anchorX, anchorY, playerX) {
    const hostiles = window.LpCombat?.listHostiles?.() || [];
    const rangeX = engageRangeX();
    let best = null;
    let bestD2 = Infinity;
    for (const h of hostiles) {
      if (!h || h.x == null || !Number.isFinite(Number(h.x))) continue;
      const hx = Number(h.x);
      if (Math.abs(hx - playerX) > rangeX) continue;
      const hy =
        h.y != null && Number.isFinite(Number(h.y)) ? Number(h.y) : anchorY;
      const d2 = (hx - anchorX) ** 2 + (hy - anchorY) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { ...h, x: hx, y: hy };
      }
    }
    return best;
  }

  /**
   * Helldivers 护卫犬式跟飞：软跟随目标点 + 上下轻晃，不硬绑骨骼。
   * @param {number} dt
   * @param {{ playerX: number, playerY: number, aimX: number, aimY: number, facing: number, selected: boolean }} ctx
   */
  function updateMotion(dt, ctx) {
    if (!drone) return;
    const item = Catalog.getItem(ITEM_ID) || {};
    const hoverX = Number(item.hoverOffsetX) || 36;
    const hoverY = Number(item.hoverOffsetY) || -78;
    const maxLeash = Number(item.leashRadius) || 110;
    const bobAmp = Number(item.bobAmp) || 5.5;
    const bobHz = Number(item.bobHz) || 2.2;

    let desireX;
    let desireY;
    if (ctx.selected) {
      /* 准星方向拉近，但仍钳在玩家身边 */
      const toAimX = ctx.aimX - ctx.playerX;
      const toAimY = ctx.aimY - ctx.playerY;
      const aimLen = Math.hypot(toAimX, toAimY) || 1;
      const pull = Math.min(maxLeash * 0.85, Math.max(42, aimLen * 0.28));
      desireX = ctx.playerX + (toAimX / aimLen) * pull;
      desireY = ctx.playerY + (toAimY / aimLen) * pull * 0.55 - 40;
    } else {
      desireX = ctx.playerX + ctx.facing * hoverX;
      desireY = ctx.playerY + hoverY;
    }

    const dx = desireX - drone.x;
    const dy = desireY - drone.y;
    const leash = Math.hypot(drone.x - ctx.playerX, drone.y - ctx.playerY);
    if (leash > maxLeash * 1.35) {
      /* 脱绳瞬移回附近，避免穿墙后追不上 */
      drone.x = desireX;
      drone.y = desireY;
      drone.vx = 0;
      drone.vy = 0;
    } else {
      const spring = 10.5;
      const damp = 6.2;
      drone.vx += dx * spring * dt;
      drone.vy += dy * spring * dt;
      drone.vx *= Math.max(0, 1 - damp * dt);
      drone.vy *= Math.max(0, 1 - damp * dt);
      drone.x += drone.vx * dt;
      drone.y += drone.vy * dt;
    }

    drone.bobT += dt * bobHz * Math.PI * 2;
    drone.y += Math.sin(drone.bobT) * bobAmp * dt * 8;
    drone.facing = drone.vx >= 0 ? 1 : -1;
  }

  /**
   * 炮口世界坐标（按当前 aimAngle / 镜像）。
   * @param {object} item
   */
  function getMuzzleWorld(item) {
    if (!drone) return { x: 0, y: 0 };
    const mount = item.barrelMount || { x: 0, y: 9 };
    const pivotX = Number(item.barrelPivotX) || 5;
    const muzzleLen = Number(item.muzzleLength) || 30;
    const mx = drone.x + mount.x;
    const my = drone.y + mount.y;
    const ang = drone.aimAngle;
    const tipLocal = muzzleLen - pivotX;
    return {
      x: mx + Math.cos(ang) * tipLocal,
      y: my + Math.sin(ang) * tipLocal,
    };
  }

  /**
   * 扣除一发弹匣（仅离线权威；联机本地扣减供 UI，快照可能回写）。
   * @param {{ hands: object, index: number, stack: object, item: object }} held
   * @returns {boolean}
   */
  function consumeMagRound(held) {
    const mag = held.stack.mag ?? 0;
    if (mag <= 0) return false;
    const next = held.hands.updateSlot?.(held.index, { mag: mag - 1 });
    if (next) held.stack = next;
    else held.stack.mag = mag - 1;
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    return true;
  }

  /**
   * 发射单发小口径弹（走 LpCombat.spawnProjectile，不占玩家开火冷却）。
   * @param {object} held
   * @param {object} target
   */
  function fireOne(held, target) {
    const { item } = held;
    if (!consumeMagRound(held)) return false;
    const muzzle = getMuzzleWorld(item);
    let aimX = target.x;
    let aimY = target.y;
    const lead = window.LpCombat?.predictLeadAim?.(muzzle.x, muzzle.y, target);
    if (lead && Number.isFinite(lead.x)) {
      aimX = lead.x;
      aimY = lead.y;
    }
    const dirX = aimX - muzzle.x;
    const dirY = aimY - muzzle.y;
    const facing = dirX >= 0 ? 1 : -1;
    drone.aimAngle = Math.atan2(dirY, dirX);
    drone.facing = facing;

    const pressureScale = window.LpPressure?.getAccuracySpreadScale?.() ?? 1;
    const baseDeg = item.spreadBaseDeg ?? 1.4;
    const bloomDeg = item.spreadBloomDeg ?? 4;
    const spreadRad = ((baseDeg + bloomDeg * 0.25) * Math.PI) / 180 * pressureScale;
    const ang = drone.aimAngle + (Math.random() * 2 - 1) * spreadRad;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);

    window.LpCombat?.spawnProjectile?.({
      originX: muzzle.x,
      originY: muzzle.y,
      dirX: dx,
      dirY: dy,
      facing,
      weaponId: item.weaponId || ITEM_ID,
      item,
      style: item.projectileStyle || 'bullet',
      flash: true,
      damage: item.damage,
      range: item.maxRange,
    });
    window.LpCombat?.playFireSfxAt?.(item, muzzle.x, muzzle.y, {
      volume: (item.fireSoundVolume ?? 0.42) * 0.85,
    });
    return true;
  }

  /**
   * 点射状态机：3 连发，发间短间隔，轮间较长冷却。
   * @param {number} dt
   * @param {object} held
   * @param {object|null} target
   */
  function updateCombat(dt, held, target) {
    if (!drone || !held) return;
    const item = held.item;
    const burstSize = Math.max(1, Number(item.burstCount) || 3);
    const shotGap = Number(item.burstShotGap) || 0.075;
    const burstGap = Number(item.burstCooldown) || 0.55;

    drone.shotCd = Math.max(0, drone.shotCd - dt);

    if (target) {
      const muzzle = getMuzzleWorld(item);
      drone.aimAngle = Math.atan2(target.y - muzzle.y, target.x - muzzle.x);
      drone.targetId = target.id != null ? String(target.id) : null;
    } else {
      drone.targetId = null;
      /* 无目标时炮口略朝水平前进向 */
      const rest = drone.facing >= 0 ? 0 : Math.PI;
      let d = rest - drone.aimAngle;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      drone.aimAngle += d * Math.min(1, dt * 4);
    }

    if (!target) {
      drone.burstLeft = 0;
      return;
    }
    if ((held.stack.mag ?? 0) <= 0) {
      drone.burstLeft = 0;
      return;
    }
    if (drone.shotCd > 0) return;

    if (drone.burstLeft <= 0) {
      drone.burstLeft = burstSize;
    }
    if (fireOne(held, target)) {
      drone.burstLeft -= 1;
      drone.shotCd = drone.burstLeft > 0 ? shotGap : burstGap;
    } else {
      drone.burstLeft = 0;
      drone.shotCd = burstGap;
    }
  }

  /**
   * 用背包/手部小口径子弹装填无人机弹匣（无抬枪动画）。
   * @returns {boolean}
   */
  function tryReload() {
    const held = getDroneHandSlot();
    if (!held) {
      window.LiminalInteract?.showToast?.('没有装备蜂鸟无人机');
      return false;
    }
    if (!isDroneSelected()) {
      /* 未选中时仍允许 R 装填无人机，避免与枪抢键时无反馈 */
    }
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) return false;
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) {
      window.LiminalInteract?.showToast?.('无人机弹匣已满');
      return false;
    }
    const have =
      (window.LpInventory?.getPlayerInventory?.()?.countItem?.(item.ammoId) ?? 0) +
      (window.LpInventory?.getHandsInventory?.()?.countItem?.(item.ammoId) ?? 0);
    if (have <= 0) {
      const ammoName = Catalog.getItem(item.ammoId)?.name || '弹药';
      window.LiminalInteract?.showToast?.(`没有${ammoName}`);
      return false;
    }
    if (window.LpInventoryNet?.isActive?.()) {
      window.LpInventoryNet.sendOp({
        action: 'reload',
        handIndex: held.index,
      });
      window.LiminalInteract?.showToast?.('装填中…');
      return true;
    }
    const take = Math.min(need, have);
    const removed = window.LpInventory?.consumeItem?.(item.ammoId, take) ?? 0;
    if (removed <= 0) return false;
    const nextMag = (stack.mag ?? 0) + removed;
    const next = held.hands.updateSlot?.(held.index, { mag: nextMag });
    if (next) held.stack = next;
    else stack.mag = nextMag;
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    window.LiminalInteract?.showToast?.(
      `无人机装填 ${removed} 发（${(next || stack).mag}/${item.magazineSize}）`
    );
    return true;
  }

  /**
   * 每帧：生成/销毁、跟飞、选敌、点射。
   * @param {number} dt
   * @param {{ playerX: number, playerY: number, aimX: number, aimY: number, facing?: number }} ctx
   */
  function tick(dt, ctx = {}) {
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      despawn();
      return;
    }
    const held = getDroneHandSlot();
    if (!held) {
      despawn();
      return;
    }
    ensureSpawn(held.item, {
      playerX: ctx.playerX,
      playerY: ctx.playerY,
      facing: ctx.facing >= 0 ? 1 : -1,
    });

    const selected = isDroneSelected();
    const facing = ctx.facing >= 0 ? 1 : -1;
    updateMotion(dt, {
      playerX: ctx.playerX,
      playerY: ctx.playerY,
      aimX: ctx.aimX,
      aimY: ctx.aimY,
      facing,
      selected,
    });

    const anchorX = selected ? ctx.aimX : ctx.playerX;
    const anchorY = selected ? ctx.aimY : ctx.playerY - 40;
    const target = pickTarget(anchorX, anchorY, ctx.playerX);
    updateCombat(dt, held, target);
  }

  /**
   * 绘制炮管（下层）+ 机身（上层）；炮管绕挂点旋转，朝左时水平镜像。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!drone) return;
    const item = Catalog.getItem(ITEM_ID);
    if (!item) return;
    if (!imgs.body && item.bodySprite) preload(item.bodySprite, item.barrelSprite);

    const bodyW = Number(item.bodyDrawW) || 56;
    const bodyH = Number(item.bodyDrawH) || 24;
    const barrelW = Number(item.barrelDrawW) || 34;
    const barrelH = Number(item.barrelDrawH) || 5;
    const mount = item.barrelMount || { x: 0, y: 9 };
    const pivotX = Number(item.barrelPivotX) || 5;
    const pivotY = Number(item.barrelPivotY) || barrelH * 0.5;

    const mountWorldX = drone.x + mount.x;
    const mountWorldY = drone.y + mount.y;
    let ang = drone.aimAngle;
    while (ang > Math.PI) ang -= Math.PI * 2;
    while (ang <= -Math.PI) ang += Math.PI * 2;
    /* 朝左镜像：仰角用 |cos|，枪口始终朝目标且不倒置双管 */
    const faceLeft = Math.cos(ang) < 0;
    const elev = Math.atan2(Math.sin(ang), Math.abs(Math.cos(ang)));

    const barrelImg = imgs.barrel;
    const bodyImg = imgs.body;

    ctx.save();
    ctx.translate(mountWorldX, mountWorldY);
    if (faceLeft) ctx.scale(-1, 1);
    ctx.rotate(elev);
    if (barrelImg?.complete && barrelImg.naturalWidth) {
      ctx.drawImage(barrelImg, -pivotX, -pivotY, barrelW, barrelH);
    } else {
      ctx.fillStyle = '#3a614d';
      ctx.fillRect(-pivotX, -pivotY, barrelW * 0.35, barrelH);
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(-pivotX + barrelW * 0.32, -pivotY + 1, barrelW * 0.68, barrelH - 2);
    }
    ctx.restore();

    /* 机身略倾；水平朝向跟瞄准侧 */
    const lean = Math.max(-0.18, Math.min(0.18, Math.sin(ang) * 0.1));
    ctx.save();
    ctx.translate(drone.x, drone.y);
    ctx.rotate(lean);
    if (faceLeft) ctx.scale(-1, 1);
    if (bodyImg?.complete && bodyImg.naturalWidth) {
      ctx.drawImage(bodyImg, -bodyW / 2, -bodyH / 2, bodyW, bodyH);
    } else {
      ctx.fillStyle = '#4a7a5c';
      ctx.fillRect(-bodyW / 2, -bodyH / 2, bodyW, bodyH);
    }
    ctx.restore();
  }

  /**
   * 若选中无人机则优先走本模块装填；否则 false 交给枪械换弹。
   * @returns {boolean}
   */
  function tryReloadIfSelected() {
    if (!isDroneSelected()) return false;
    return tryReload();
  }

  window.LpHummingbirdDrone = {
    ITEM_ID,
    engageRangeX,
    getDroneHandSlot,
    isDroneSelected,
    tryReload,
    tryReloadIfSelected,
    tick,
    draw,
    despawn,
    getDrone: () => drone,
  };
})();

/*
 * 装填规则：
 * - 弹匣容量 magazineSize=120，存在手部堆叠 stack.mag。
 * - R（选中无人机时）从背包+手部消耗 small_caliber_ammo，补满至 120（有多少补多少）。
 * - 背包拖拽弹药到无人机（weaponAcceptsAmmo）仍走原有库存装填。
 *
 * 联机：
 * - 伴飞体与弹道仅本地；其它玩家看不到你的无人机。
 * - 弹匣经 hands 快照可能被服务端回写；开火未走服务端 weapon-fired。
 */
