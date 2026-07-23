/**
 * 阈限月台战斗层：手持武器开火、后坐散布、弹匣、地上弹壳。
 * 约定：弹药/炮弹均为飞行实体（离散弹头），禁止激光线/长曳光描边。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const DEFAULT_COOLDOWN = 0.22;
  const TRACE_LENGTH = 560;
  const CASING_REST_LIFE = 4.0;
  const GRAVITY = 920;
  /** 小口径子弹飞行速度。 */
  const PROJECTILE_SPEED_BULLET = 2400;
  /** 机炮炮弹稍慢。 */
  const PROJECTILE_SPEED_SHELL = 1650;

  /**
   * 弹种外观：实体尺寸（世界像素），非尾迹长度。
   * kind: bullet=步枪/冲锋枪弹头；shell=机炮弹体。
   */
  const PROJECTILE_STYLE = {
    bullet: {
      kind: 'bullet',
      speed: PROJECTILE_SPEED_BULLET,
      /* ~半原尺寸；勿再腰斩（曾误缩两次） */
      bodyLen: 4.5,
      bodyH: 1.2,
      tipLen: 1.6,
      tip: '#f5d0a0',
      body: '#c4a35a',
      band: '#8a6a2a',
      flashR: 4,
    },
    shell: {
      kind: 'shell',
      speed: PROJECTILE_SPEED_SHELL,
      bodyLen: 18,
      bodyH: 5.5,
      tipLen: 5,
      tip: '#f8fafc',
      body: '#d97706',
      band: '#92400e',
      flashR: 14,
    },
  };

  const state = {
    cooldown: 0,
    weaponId: 'rifle_stub',
    /** 后坐散布标度 0–1，驱动准星张开与弹道偏移。 */
    recoil: 0,
    shots: [],
    casings: [],
  };

  /** 解析弹种样式键（物品 projectileStyle，或武器类别回退）。 */
  function resolveProjectileStyleKey(options = {}) {
    if (options.style && PROJECTILE_STYLE[options.style]) return options.style;
    if (options.style === 'rifle') return 'bullet';
    if (options.style === 'turret') return 'shell';
    const weaponId = options.weaponId || state.weaponId;
    if (weaponId === 'guard_turret' || weaponId === 'cannon_stub') return 'shell';
    const item = options.item || getHeldWeaponItem();
    if (item?.projectileStyle && PROJECTILE_STYLE[item.projectileStyle]) {
      return item.projectileStyle;
    }
    return 'bullet';
  }

  /** 当前武器冷却间隔。 */
  function getCooldown(item) {
    if (item?.fireCooldown != null) return item.fireCooldown;
    if (state.weaponId === 'cannon_stub') return 0.85;
    return DEFAULT_COOLDOWN;
  }

  /** 手持武器槽位（优先 HUD 选中槽，再右手、左手）。 */
  function getHeldWeaponSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isWeapon) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    const order = [];
    if (preferred === 0 || preferred === 1) order.push(preferred);
    for (const index of [1, 0]) {
      if (!order.includes(index)) order.push(index);
    }
    for (const index of order) {
      if (index >= hands.size()) continue;
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isWeapon(stack.itemId)) continue;
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

  /** 当前持有的武器物品定义。 */
  function getHeldWeaponItem() {
    return getHeldWeaponSlot()?.item || null;
  }

  /** 归一化方向；零向量时按朝向回退。 */
  function normalizeDir(dirX, dirY, facing) {
    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) {
      return { x: facing >= 0 ? 1 : -1, y: 0 };
    }
    return { x: dirX / len, y: dirY / len };
  }

  /** 按角度旋转二维向量。 */
  function rotateDir(dir, radians) {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c };
  }

  /** 后坐标度 → 准星中心空隙（像素）。 */
  function getCrosshairGapPx() {
    return 3 + state.recoil * 24;
  }

  /** 同步准星张开尺寸。 */
  function syncCrosshairBloom() {
    const gap = getCrosshairGapPx();
    const el = document.getElementById('lpCrosshair');
    if (el) el.style.setProperty('--lp-aim-gap', `${gap.toFixed(1)}px`);
  }

  /** 抛出地上弹壳（从抛壳口飞出，速度相对枪口朝向）。 */
  function spawnShellCasing(originX, originY, dirX, dirY, item) {
    const speed = item?.shellEjectSpeed || { forward: -40, up: 140 };
    const len = Math.hypot(dirX, dirY) || 1;
    const fx = dirX / len;
    const fy = dirY / len;
    const nx = -fy;
    const ny = fx;
    const jitter = 0.8 + Math.random() * 0.4;
    const upSign = fy > 0.35 ? -1 : 1;
    state.casings.push({
      x: originX,
      y: originY,
      vx: (fx * speed.forward + nx * speed.up * upSign) * jitter * (0.75 + Math.random() * 0.4),
      vy: (fy * speed.forward + ny * speed.up * upSign) * jitter * (0.8 + Math.random() * 0.35),
      rot: Math.random() * Math.PI * 2,
      omega: (Math.random() * 10 + 4) * (nx >= 0 ? -1 : 1),
      resting: false,
      restLife: CASING_REST_LIFE,
      scale: item?.shellCasingScale ?? 1,
    });
  }

  /**
   * 尝试开火（须手持武器；有弹匣则扣弹）。
   * options.moveSpeed：水平速度，用于移动后坐。
   * options.ejectX/Y：抛壳口；缺省则靠近枪口略偏后。
   */
  function tryFire(options = {}) {
    if (window.LpReloadAction?.isBusy?.()) return null;
    if (state.cooldown > 0) return null;
    const held = getHeldWeaponSlot();
    if (!held) return null;
    const { item, stack } = held;
    const online = window.LpInventoryNet?.isActive?.();

    if (item.magazineSize != null) {
      const mag = stack.mag ?? 0;
      if (mag <= 0) {
        window.LiminalInteract?.showToast?.('弹匣空了 · 按 R 装填');
        state.cooldown = 0.25;
        return null;
      }
      if (!online) {
        const next = held.hands.updateSlot?.(held.index, { mag: mag - 1 });
        if (next) held.stack = next;
        else stack.mag = mag - 1;
        window.LpInventory?.persistAndRender?.();
      }
    }

    const weaponId = options.weaponId || Catalog.getWeaponId?.(item.id) || item.id;
    state.weaponId = weaponId;

    const facing = options.facing >= 0 ? 1 : -1;
    let dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const baseDeg = item.spreadBaseDeg ?? 0.6;
    const bloomDeg = item.spreadBloomDeg ?? 6;
    const spreadRad = ((baseDeg + state.recoil * bloomDeg) * Math.PI) / 180;
    dir = rotateDir(dir, (Math.random() * 2 - 1) * spreadRad);

    const moving = Math.abs(options.moveSpeed || 0) > 28;
    const kick = item.recoilKick ?? 0.18;
    const moveMul = moving ? item.moveRecoilMul ?? 1.4 : 1;
    state.recoil = Math.min(1, state.recoil + kick * moveMul);
    syncCrosshairBloom();

    const muzzleX = options.originX ?? options.x ?? 0;
    const muzzleY = options.originY ?? options.y ?? 0;
    const payload = spawnProjectile({
      ...options,
      originX: muzzleX,
      originY: muzzleY,
      dirX: dir.x,
      dirY: dir.y,
      weaponId,
      item,
      style: item.projectileStyle,
      facing,
      flash: true,
    });
    if (!payload) return null;

    const ejectX = options.ejectX ?? muzzleX - dir.x * 14;
    const ejectY = options.ejectY ?? muzzleY - dir.y * 14;
    spawnShellCasing(ejectX, ejectY, dir.x, dir.y, item);
    state.cooldown = getCooldown(item);
    if (item.fireSound) {
      window.LpSfx?.play?.(item.fireSound, {
        volume: item.fireSoundVolume ?? 0.65,
        rateJitter: item.fireSoundRateJitter ?? 0.04,
      });
    }
    window.dispatchEvent(
      new CustomEvent('lp:weapon-fired', {
        detail: { ...payload, handIndex: held.index },
      })
    );
    return payload;
  }

  /** 用背包/手中的对应弹药装填当前武器（带动画；弹药在插入关键帧入匣）。 */
  function tryReload() {
    if (window.LpReloadAction?.isBusy?.()) return false;
    const held = getHeldWeaponSlot();
    if (!held) {
      window.LiminalInteract?.showToast?.('没有手持武器');
      return false;
    }
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) {
      window.LiminalInteract?.showToast?.('该武器无需装填');
      return false;
    }
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) {
      window.LiminalInteract?.showToast?.('弹匣已满');
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

    const started = window.LpReloadAction?.begin?.({
      item,
      onCommit: () => commitReloadAmmo(),
    });
    if (!started) {
      return commitReloadAmmo();
    }
    window.LiminalInteract?.showToast?.('装填中…');
    return true;
  }

  /** 实际扣除备弹并写入弹匣（换弹关键帧或无动画回退）。 */
  function commitReloadAmmo() {
    const held = getHeldWeaponSlot();
    if (!held) return false;
    const { item, stack } = held;
    if (!item.magazineSize || !item.ammoId) return false;
    const need = item.magazineSize - (stack.mag ?? 0);
    if (need <= 0) return false;
    const have =
      (window.LpInventory?.getPlayerInventory?.()?.countItem?.(item.ammoId) ?? 0) +
      (window.LpInventory?.getHandsInventory?.()?.countItem?.(item.ammoId) ?? 0);
    if (have <= 0) return false;

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
    window.LiminalInteract?.showToast?.(
      `装填 ${removed} 发（${(next || stack).mag}/${item.magazineSize}）`
    );
    return true;
  }

  /** 生成飞行弹实体（本地或远端回放；不占用冷却、不检查持枪）。 */
  function spawnProjectile(options = {}) {
    const facing = options.facing >= 0 ? 1 : -1;
    const originX = options.originX ?? options.x ?? 0;
    const originY = options.originY ?? options.y ?? 0;
    const dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const range = options.range ?? TRACE_LENGTH;
    const weaponId = options.weaponId || state.weaponId;
    const styleKey = resolveProjectileStyleKey({ ...options, weaponId });
    const style = PROJECTILE_STYLE[styleKey] || PROJECTILE_STYLE.bullet;
    const speed = options.speed ?? style.speed;
    const shot = {
      x: originX,
      y: originY,
      prevX: originX,
      prevY: originY,
      vx: dir.x * speed,
      vy: dir.y * speed,
      dirX: dir.x,
      dirY: dir.y,
      distLeft: range,
      age: 0,
      maxAge: range / speed + 0.2,
      weaponId,
      style: styleKey,
      muzzleFlash: Boolean(options.flash),
      muzzleFlashLife: options.flash ? 0.07 : 0,
      originX,
      originY,
    };
    state.shots.push(shot);
    return {
      originX,
      originY,
      dirX: dir.x,
      dirY: dir.y,
      weaponId,
      range,
      facing,
    };
  }

  /** @deprecated 用 spawnProjectile；保留别名兼容会话/炮塔。 */
  function spawnTracer(options) {
    return spawnProjectile(options);
  }

  /** 推进冷却、后坐衰减、弹实体飞行与弹壳物理。 */
  function tick(dt, options = {}) {
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);

    const held = getHeldWeaponItem();
    const decay = held?.recoilDecay ?? 2.0;
    const moving = Math.abs(options.moveSpeed || 0) > 28;
    const decayMul = moving ? 0.55 : 1;
    if (state.recoil > 0) {
      state.recoil = Math.max(0, state.recoil - decay * decayMul * dt);
      syncCrosshairBloom();
    }

    for (let i = state.shots.length - 1; i >= 0; i -= 1) {
      const shot = state.shots[i];
      shot.prevX = shot.x;
      shot.prevY = shot.y;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      const step = Math.hypot(shot.vx, shot.vy) * dt;
      shot.distLeft -= step;
      shot.age += dt;
      if (shot.muzzleFlashLife > 0) {
        shot.muzzleFlashLife = Math.max(0, shot.muzzleFlashLife - dt);
      }
      if (shot.distLeft <= 0 || shot.age >= shot.maxAge) {
        state.shots.splice(i, 1);
      }
    }

    const floorY = options.floorY;
    for (let i = state.casings.length - 1; i >= 0; i -= 1) {
      const c = state.casings[i];
      if (c.resting) {
        c.restLife -= dt;
        if (c.restLife <= 0) state.casings.splice(i, 1);
        continue;
      }
      c.vy += GRAVITY * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.rot += c.omega * dt;
      c.vx *= Math.exp(-1.2 * dt);
      if (floorY != null && c.y >= floorY - 2) {
        c.y = floorY - 2;
        if (Math.abs(c.vy) < 60 && Math.abs(c.vx) < 40) {
          c.vx = 0;
          c.vy = 0;
          c.omega *= 0.2;
          c.resting = true;
        } else {
          c.vy *= -0.28;
          c.vx *= 0.55;
          c.omega *= -0.4;
        }
      }
    }
  }

  /** 绘制离散弹头实体（非激光线）。 */
  function drawProjectile(ctx, shot) {
    const style = PROJECTILE_STYLE[shot.style] || PROJECTILE_STYLE.bullet;
    const ang = Math.atan2(shot.dirY, shot.dirX);
    const len = style.bodyLen;
    const h = style.bodyH;
    const tip = style.tipLen;

    ctx.save();
    ctx.translate(shot.x, shot.y);
    ctx.rotate(ang);

    /* 弹体：尾在 -X，尖朝 +X */
    ctx.fillStyle = style.body;
    ctx.beginPath();
    ctx.moveTo(-len * 0.45, -h * 0.5);
    ctx.lineTo(len * 0.2, -h * 0.5);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.2, h * 0.5);
    ctx.lineTo(-len * 0.45, h * 0.5);
    ctx.closePath();
    ctx.fill();

    /* 弹底 / 弹带 */
    ctx.fillStyle = style.band;
    ctx.fillRect(-len * 0.45, -h * 0.5, len * 0.18, h);

    /* 弹尖高光 */
    ctx.fillStyle = style.tip;
    ctx.beginPath();
    ctx.moveTo(len * 0.12, -h * 0.28);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.12, h * 0.28);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    if (shot.muzzleFlash && shot.muzzleFlashLife > 0) {
      const t = shot.muzzleFlashLife / 0.07;
      ctx.save();
      ctx.translate(shot.originX, shot.originY);
      ctx.rotate(ang);
      const r = style.flashR * (0.6 + 0.4 * t);
      const flash = ctx.createRadialGradient(0, 0, 0, r * 0.4, 0, r);
      flash.addColorStop(0, `rgba(255, 250, 220, ${0.95 * t})`);
      flash.addColorStop(0.4, `rgba(251, 146, 60, ${0.8 * t})`);
      flash.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = flash;
      ctx.beginPath();
      ctx.ellipse(r * 0.35, 0, r * 1.1, r * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 在世界坐标层绘制弹实体与地上弹壳。 */
  function draw(ctx) {
    for (const shot of state.shots) {
      drawProjectile(ctx, shot);
    }

    for (const c of state.casings) {
      const fade = c.resting ? Math.max(0.25, c.restLife / CASING_REST_LIFE) : 1;
      const s = c.scale ?? 1;
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.scale(s, s);
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#c4a35a';
      ctx.fillRect(-4.5, -1.6, 9, 3.2);
      ctx.fillStyle = '#8a6a2a';
      ctx.fillRect(2.2, -1.6, 2.4, 3.2);
      ctx.restore();
    }
  }

  /** 切换占位武器（后续接真实武器表）。 */
  function setWeapon(weaponId) {
    state.weaponId = weaponId || 'rifle_stub';
  }

  /** 是否可开火。 */
  function canFire() {
    return (
      Boolean(getHeldWeaponItem()) &&
      state.cooldown <= 0 &&
      !window.LpReloadAction?.isBusy?.()
    );
  }

  /** 当前弹匣文案。 */
  function getMagReadout() {
    const held = getHeldWeaponSlot();
    if (!held?.item?.magazineSize) return null;
    return {
      mag: held.stack.mag ?? 0,
      size: held.item.magazineSize,
      name: held.item.name,
    };
  }

  syncCrosshairBloom();

  window.LpCombat = {
    tryFire,
    tryReload,
    spawnProjectile,
    spawnTracer,
    tick,
    draw,
    setWeapon,
    canFire,
    getHeldWeaponItem,
    getHeldWeaponSlot,
    getMagReadout,
    getRecoil: () => state.recoil,
    getCrosshairGapPx,
    syncCrosshairBloom,
    getWeaponId: () => state.weaponId,
    PROJECTILE_STYLE,
  };
})();
