/**
 * 阈限月台战斗层：手持武器开火、后坐散布、弹匣、地上弹壳。
 * 约定：弹药/炮弹均为飞行实体（离散弹头）；禁止激光线。
 * 武装车厢 T（曳光）可带短绿色拖尾，弹体消失后尾迹再滞空渐隐；AP 无亮绿拖尾。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const DEFAULT_COOLDOWN = 0.22;
  /** T 曳光尾迹在弹体销毁后的默认滞空时长（秒）。 */
  const TRAIL_LINGER_LIFE = 0.35;
  /** 滞空尾迹条数上限（双塔连射时丢弃最旧，避免拖垮帧率）。 */
  const MAX_LINGERING_TRAILS = 32;
  /**
   * 弹道射程兜底（世界像素）。优先 style.maxRange / item.maxRange / options.range。
   * 旧值 560 过短，炮弹约 0.3s 即消失。
   */
  const DEFAULT_MAX_RANGE = 1600;
  const CASING_REST_LIFE = 4.0;
  const GRAVITY = 920;
  /** 小口径子弹飞行速度（GUR-65 / machine_gun bullet 样式）。 */
  const PROJECTILE_SPEED_BULLET = 3000;
  /** 机炮炮弹：快于步枪弹，大弹体仍需可见航迹。 */
  const PROJECTILE_SPEED_SHELL = 3600;
  /**
   * 枪炮准星中心最小空隙（像素）。
   * 高精度武器也略微散开，禁止四臂收成实心十字。
   */
  const CROSSHAIR_MIN_GAP_PX = 7;
  /** 机炮塔准星最小空隙（像素）；大于手持，匹配炮口散布观感。 */
  const TURRET_CROSSHAIR_MIN_GAP_PX = 14;
  /** 机炮塔满 bloom 时额外张开（像素）；刻意封顶，避免准星过大。 */
  const TURRET_BLOOM_GAP_PX = 10;
  /** spreadBaseDeg → 准星基础空隙的像素换算。 */
  const SPREAD_DEG_TO_GAP_PX = 4;
  /** 后坐满时额外张开（像素）。 */
  const RECOIL_GAP_PX = 22;

  /**
   * 弹种外观与默认射程（世界像素）。
   * kind: bullet=步枪/冲锋枪弹头；shell=机炮弹体。
   * maxRange：飞行实体在命中前可走的最大距离；lifetime ≈ maxRange/speed。
   * 默认：bullet 1600（~0.53s @ 3000）；shell 9600（~2.7s @ 3600，约数节车厢）。
   * 武器 catalog 可设 item.maxRange 覆盖；spawn 也可传 options.range。
   */
  const PROJECTILE_STYLE = {
    bullet: {
      kind: 'bullet',
      speed: PROJECTILE_SPEED_BULLET,
      maxRange: 1600,
      /* ~半原尺寸；勿再腰斩（曾误缩两次） */
      bodyLen: 4.5,
      bodyH: 1.2,
      tipLen: 1.6,
      tip: '#f5d0a0',
      body: '#c4a35a',
      band: '#8a6a2a',
      flashR: 11,
      /** 枪口环境照亮半径（世界像素，additive 软晕）。 */
      flashLightR: 56,
      /** 命中车底 / 轨道时播尘土；scale 控制喷溅大小。 */
      impactDust: true,
      impactDustScale: 1,
    },
    shell: {
      kind: 'shell',
      speed: PROJECTILE_SPEED_SHELL,
      maxRange: 9600,
      /* 绘制长度（仅外观）；机炮弹体再拉长一点 */
      bodyLen: 30,
      bodyH: 5.5,
      tipLen: 8,
      tip: '#f8fafc',
      body: '#d97706',
      band: '#92400e',
      flashR: 26,
      flashLightR: 118,
      impactDust: true,
      impactDustScale: 1.75,
    },
  };

  /** 手持开火枪口火光寿命（秒）。 */
  const MUZZLE_FLASH_LIFE = 0.11;

  const state = {
    cooldown: 0,
    weaponId: 'rifle_stub',
    /** 后坐散布标度 0–1，驱动准星张开与弹道偏移。 */
    recoil: 0,
    shots: [],
    casings: [],
    /**
     * T 曳光滞空尾迹（与弹体解耦）。
     * 每项：{ pts, life, maxLife, color, glow, width }
     */
    lingeringTrails: [],
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

  /** 手持武器槽：仅用 HUD 选中槽；空槽/非武器视为徒手（不回退其它手槽）。 */
  function getHeldWeaponSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isWeapon) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    const order =
      preferred === 0 || preferred === 1 || preferred === 2
        ? [preferred]
        : [1, 0];
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

  /**
   * 计算准星中心空隙（像素）。
   * 手持：max(全局最小, spreadBaseDeg 换算) + 后坐张开；
   * 机炮塔：基础空隙 + 入座塔连射 bloom（封顶 TURRET_BLOOM_GAP_PX）。
   */
  function getCrosshairGapPx() {
    if (document.body.classList.contains('lp-turret-mode')) {
      const bloom = window.LpGuardTurret?.getFireBloom?.('primary') ?? 0;
      return TURRET_CROSSHAIR_MIN_GAP_PX + bloom * TURRET_BLOOM_GAP_PX;
    }
    const item = getHeldWeaponItem();
    const baseDeg = item?.spreadBaseDeg ?? 0.8;
    const fromSpread = baseDeg * SPREAD_DEG_TO_GAP_PX;
    const baseGap = Math.max(CROSSHAIR_MIN_GAP_PX, fromSpread);
    return baseGap + state.recoil * RECOIL_GAP_PX;
  }

  /**
   * 双联 2 号塔对角线准星空隙（像素）；非双联时返回 null。
   */
  function getSecondaryTurretCrosshairGapPx() {
    if (!document.body.classList.contains('lp-turret-mode')) return null;
    if (!window.LpGuardTurret?.isSoloDual?.()) return null;
    const bloom = window.LpGuardTurret?.getFireBloom?.('secondary') ?? 0;
    return TURRET_CROSSHAIR_MIN_GAP_PX + bloom * TURRET_BLOOM_GAP_PX;
  }

  /**
   * 同步准星张开尺寸到 --lp-aim-gap（覆盖 CSS）。
   * 机炮双联时另写对角线准星（#lpCrosshairAlt）的空隙。
   */
  function syncCrosshairBloom() {
    const gap = getCrosshairGapPx();
    const el = document.getElementById('lpCrosshair');
    if (el) el.style.setProperty('--lp-aim-gap', `${gap.toFixed(1)}px`);

    const alt = document.getElementById('lpCrosshairAlt');
    if (!alt) return;
    const altGap = getSecondaryTurretCrosshairGapPx();
    if (altGap == null) {
      alt.hidden = true;
      return;
    }
    alt.style.setProperty('--lp-aim-gap', `${altGap.toFixed(1)}px`);
    /* 显隐由 liminal-platform syncAimCursor 与 pointer 一并控制；此处只保证尺寸。 */
    if (document.body.classList.contains('lp-turret-mode')) {
      alt.hidden = Boolean(el?.hidden);
    }
  }

  /**
   * 抛出地上弹壳（从抛壳口飞出，速度相对枪口朝向）。
   * 卫士回收箱满时也走此路径播抛壳 FX（由 LpGuardTurret 调用）。
   */
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
      // 单机立即扣弹匣；联机由服务端权威扣减后快照回写。
      // 注意：TEST_AUTO_REFILL_CONSUMABLES 只管仓库/弹药堆，不得跳过弹匣消耗。
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

  /**
   * 解析弹道最大射程：显式 range > 物品 maxRange > 弹种 maxRange > 全局兜底。
   * 远端回放只带 weaponId 时，经 style 仍能与本机一致。
   */
  function resolveProjectileRange(options, style) {
    if (options.range != null && Number.isFinite(options.range)) {
      return Math.max(0, options.range);
    }
    const itemRange = options.item?.maxRange;
    if (itemRange != null && Number.isFinite(itemRange)) {
      return Math.max(0, itemRange);
    }
    if (style?.maxRange != null && Number.isFinite(style.maxRange)) {
      return Math.max(0, style.maxRange);
    }
    return DEFAULT_MAX_RANGE;
  }

  /**
   * 解析武装弹种（AP / T）；未知或缺省回退 null（用手持/默认 shell 外观）。
   * @param {object} options
   */
  function resolveAmmoType(options = {}) {
    const raw = String(options.ammoType || options.ammo || '').trim().toLowerCase();
    if (!raw) return null;
    if (raw === 'tracer') return 't';
    if (raw === 'ap' || raw === 't') return raw;
    const fromCatalog = window.LpArmedAmmo?.getType?.(raw);
    return fromCatalog?.id || null;
  }

  /**
   * 取弹种外观覆盖（体色 / 拖尾）；无弹种时 null。
   * @param {string | null} ammoType
   */
  function ammoVisual(ammoType) {
    if (!ammoType) return null;
    return window.LpArmedAmmo?.getType?.(ammoType) || null;
  }

  /** 生成飞行弹实体（本地或远端回放；不占用冷却、不检查持枪）。 */
  function spawnProjectile(options = {}) {
    const facing = options.facing >= 0 ? 1 : -1;
    const originX = options.originX ?? options.x ?? 0;
    const originY = options.originY ?? options.y ?? 0;
    const dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const weaponId = options.weaponId || state.weaponId;
    const styleKey = resolveProjectileStyleKey({ ...options, weaponId });
    const style = PROJECTILE_STYLE[styleKey] || PROJECTILE_STYLE.bullet;
    const range = resolveProjectileRange(options, style);
    const speed = options.speed ?? style.speed;
    const ammoType = resolveAmmoType(options);
    const visual = ammoVisual(ammoType);
    const trailCfg = visual?.trail || null;
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
      ammoType,
      penetrates: Boolean(visual?.penetrates),
      /** 拖尾采样点（世界坐标，队首为最新）。 */
      trail: trailCfg ? [{ x: originX, y: originY }] : null,
      trailMax: trailCfg?.length ?? 0,
      muzzleFlash: Boolean(options.flash),
      muzzleFlashLife: options.flash ? MUZZLE_FLASH_LIFE : 0,
      muzzleFlashMax: options.flash ? MUZZLE_FLASH_LIFE : 0,
      muzzleJitter: Math.random() * Math.PI,
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
      style: styleKey,
      ammoType,
      facing,
    };
  }

  /** @deprecated 用 spawnProjectile；保留别名兼容会话/炮塔。 */
  function spawnTracer(options) {
    return spawnProjectile(options);
  }

  /** 弹体命中车底 / 轨道时生成尘土并销毁弹实体。 */
  function applySurfaceImpact(shot) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.hitProjectileSurfaces) return false;
    const hit = Spec.hitProjectileSurfaces(shot.prevX, shot.prevY, shot.x, shot.y);
    if (!hit) return false;
    const style = PROJECTILE_STYLE[shot.style] || PROJECTILE_STYLE.bullet;
    if (style.impactDust) {
      window.LpImpactFx?.spawnDust?.(hit.x, hit.y, {
        surface: hit.surface,
        dirX: shot.dirX,
        dirY: shot.dirY,
        scale: style.impactDustScale ?? 1,
      });
    }
    return true;
  }

  /**
   * 弹体销毁时把 T 曳光采样点移交滞空池，短时渐隐；超上限丢最旧条。
   * @param {object} shot
   */
  function releaseLingeringTrail(shot) {
    const pts = shot.trail;
    if (!pts || pts.length < 2) return;
    const visual = ammoVisual(shot.ammoType);
    const trailCfg = visual?.trail;
    if (!trailCfg) return;
    const life = Number(trailCfg.linger) > 0 ? Number(trailCfg.linger) : TRAIL_LINGER_LIFE;
    while (state.lingeringTrails.length >= MAX_LINGERING_TRAILS) {
      state.lingeringTrails.shift();
    }
    state.lingeringTrails.push({
      pts,
      life,
      maxLife: life,
      color: trailCfg.color,
      glow: trailCfg.glow,
      width: trailCfg.width ?? 3,
    });
    shot.trail = null;
  }

  /** 销毁弹实体并把曳光尾迹移交滞空池（若有）。 */
  function removeShotAt(index) {
    const shot = state.shots[index];
    if (!shot) return;
    releaseLingeringTrail(shot);
    state.shots.splice(index, 1);
  }

  /** 推进冷却、后坐衰减、弹实体飞行、滞空尾迹与弹壳物理。 */
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
      if (shot.trail && shot.trailMax > 0) {
        shot.trail.unshift({ x: shot.x, y: shot.y });
        if (shot.trail.length > shot.trailMax) shot.trail.length = shot.trailMax;
      }
      if (shot.muzzleFlashLife > 0) {
        shot.muzzleFlashLife = Math.max(0, shot.muzzleFlashLife - dt);
      }
      if (applySurfaceImpact(shot)) {
        removeShotAt(i);
        continue;
      }
      if (shot.distLeft <= 0 || shot.age >= shot.maxAge) {
        removeShotAt(i);
      }
    }

    for (let i = state.lingeringTrails.length - 1; i >= 0; i -= 1) {
      const ribbon = state.lingeringTrails[i];
      ribbon.life -= dt;
      if (ribbon.life <= 0) state.lingeringTrails.splice(i, 1);
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

  /**
   * 绘制枪口火光：短促 additive 环境照亮 + 橙晕星爆 + 白核焰舌（约三拍）。
   * opts.t 为剩余寿命比例 1→0；lightR 照亮周围半径；flashR 星爆尺度。
   */
  function drawMuzzleFlash(ctx, opts) {
    const t = Math.max(0, Math.min(1, Number(opts.t) || 0));
    if (t <= 0.001) return;
    const age = 1 - t;
    const scale = opts.scale ?? 1;
    const lightR = (opts.lightR ?? 72) * scale;
    const flashR = (opts.flashR ?? 16) * scale;
    const punch = Math.max(0, 1 - age / 0.3);
    const ambient = Math.pow(t, 0.5) * (0.55 + 0.45 * Math.min(1, punch + 0.35));
    const tongue = Math.pow(t, 0.8);
    const coreFade = punch * 0.55 + t * t * 0.45;
    const jitter = opts.jitter || 0;

    ctx.save();
    ctx.translate(opts.x, opts.y);
    ctx.globalCompositeOperation = 'lighter';

    /* 拍 1–2：大半径暖光软晕，短暂照亮甲板 / 炮管 / 附近精灵 */
    const glowR = lightR * (0.9 + 0.22 * (1 - punch));
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
    glow.addColorStop(0, `rgba(255, 236, 190, ${0.52 * ambient})`);
    glow.addColorStop(0.2, `rgba(255, 175, 70, ${0.34 * ambient})`);
    glow.addColorStop(0.48, `rgba(210, 90, 25, ${0.15 * ambient})`);
    glow.addColorStop(1, 'rgba(40, 10, 0, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(opts.angle || 0);
    const r = flashR * (0.72 + 0.42 * punch + 0.22 * t);

    /* 拍 2：沿枪口轴向的橙晕星爆 */
    const bloom = ctx.createRadialGradient(r * 0.15, 0, 0, r * 0.15, 0, r * 1.45);
    bloom.addColorStop(0, `rgba(255, 252, 235, ${0.95 * coreFade})`);
    bloom.addColorStop(0.28, `rgba(255, 190, 70, ${0.82 * tongue})`);
    bloom.addColorStop(0.58, `rgba(251, 110, 28, ${0.48 * tongue})`);
    bloom.addColorStop(1, 'rgba(160, 30, 0, 0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.ellipse(r * 0.28, 0, r * 1.5, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();

    /* 拍 3：前伸焰舌 + 上下叉 */
    ctx.rotate(jitter * 0.1);
    ctx.fillStyle = `rgba(255, 245, 200, ${0.92 * tongue})`;
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(r * 1.65, -r * 0.24);
    ctx.lineTo(r * 1.2, 0);
    ctx.lineTo(r * 1.65, r * 0.24);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255, 175, 55, ${0.78 * tongue})`;
    ctx.beginPath();
    ctx.moveTo(0, -2);
    ctx.lineTo(r * 0.58, -r * 1.05);
    ctx.lineTo(r * 0.38, 0);
    ctx.lineTo(r * 0.58, r * 1.05);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = `rgba(255, 255, 248, ${0.98 * coreFade})`;
    ctx.beginPath();
    ctx.ellipse(3, 0, 5.5 + 7 * punch + 2.5 * t, 3.8 + 3.2 * punch, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  /**
   * 绘制 T（曳光）绿色短拖尾：沿采样点渐隐，非激光长线。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{x:number,y:number}[]} pts
   * @param {{color?:string,glow?:string,width?:number}} trailCfg
   * @param {number} [alphaMul=1] 整体透明度（滞空渐隐用）
   */
  function drawAmmoTrail(ctx, pts, trailCfg, alphaMul = 1) {
    if (!pts || pts.length < 2 || !trailCfg || alphaMul <= 0.001) return;
    const width = trailCfg.width ?? 3;
    const mul = Math.max(0, Math.min(1, alphaMul));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      const fade = 1 - i / Math.max(1, pts.length - 1);
      ctx.strokeStyle = trailCfg.glow || trailCfg.color;
      ctx.globalAlpha = 0.35 * fade * mul;
      ctx.lineWidth = width * 2.4 * fade;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = trailCfg.color;
      ctx.globalAlpha = 0.85 * fade * mul;
      ctx.lineWidth = width * fade;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * 绘制离散弹头实体（非激光线）。
   * 武装弹种可覆写体色、尺寸倍率、弹尖高光比例，并可带拖尾；不靠 alpha「藏」弹。
   */
  function drawProjectile(ctx, shot) {
    const style = PROJECTILE_STYLE[shot.style] || PROJECTILE_STYLE.bullet;
    const visual = ammoVisual(shot.ammoType);
    const ang = Math.atan2(shot.dirY, shot.dirX);
    const bodyScale = Number(visual?.bodyScale) > 0 ? Number(visual.bodyScale) : 1;
    const bodyHScale =
      Number(visual?.bodyHScale) > 0 ? Number(visual.bodyHScale) : bodyScale;
    const len = style.bodyLen * bodyScale;
    const h = style.bodyH * bodyHScale;
    const tip = style.tipLen * bodyScale;
    const tipHalf =
      h *
      (Number(visual?.tipHighlight) > 0 ? Number(visual.tipHighlight) : 0.28);
    const bodyColor = visual?.body || style.body;
    const bandColor = visual?.band || style.band;
    const tipColor = visual?.tip || style.tip;
    const flashScale =
      Number(visual?.flashScale) > 0 ? Number(visual.flashScale) : 1;

    if (visual?.trail && shot.trail) drawAmmoTrail(ctx, shot.trail, visual.trail);

    ctx.save();
    ctx.translate(shot.x, shot.y);
    ctx.rotate(ang);

    /* 弹体：尾在 -X，尖朝 +X；fill 用全不透明色 */
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(-len * 0.45, -h * 0.5);
    ctx.lineTo(len * 0.2, -h * 0.5);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.2, h * 0.5);
    ctx.lineTo(-len * 0.45, h * 0.5);
    ctx.closePath();
    ctx.fill();

    /* 弹底 / 弹带 */
    ctx.fillStyle = bandColor;
    ctx.fillRect(-len * 0.45, -h * 0.5, len * 0.18, h);

    /* 弹尖高光（窄带、低对比色；仍不透明） */
    ctx.fillStyle = tipColor;
    ctx.beginPath();
    ctx.moveTo(len * 0.12, -tipHalf);
    ctx.lineTo(len * 0.2 + tip, 0);
    ctx.lineTo(len * 0.12, tipHalf);
    ctx.closePath();
    ctx.fill();

    ctx.restore();

    if (shot.muzzleFlash && shot.muzzleFlashLife > 0) {
      const maxLife = shot.muzzleFlashMax || MUZZLE_FLASH_LIFE;
      drawMuzzleFlash(ctx, {
        x: shot.originX,
        y: shot.originY,
        angle: ang,
        t: shot.muzzleFlashLife / maxLife,
        lightR: (style.flashLightR ?? 56) * flashScale,
        flashR: style.flashR * flashScale,
        jitter: shot.muzzleJitter || 0,
      });
    }
  }

  /** 在世界坐标层绘制滞空曳光、弹实体与地上弹壳。 */
  function draw(ctx) {
    for (const ribbon of state.lingeringTrails) {
      const t = ribbon.maxLife > 0 ? ribbon.life / ribbon.maxLife : 0;
      /* 前半段保持较亮，后半段加速淡出。 */
      const alphaMul = Math.pow(Math.max(0, t), 0.65);
      drawAmmoTrail(ctx, ribbon.pts, ribbon, alphaMul);
    }

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

  /** 当前手持武器是否全自动（长按连发）；无持枪为 false。 */
  function isHeldWeaponFullAuto() {
    return Boolean(Catalog?.isFullAuto?.(getHeldWeaponItem()));
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
    spawnShellCasing,
    tick,
    draw,
    setWeapon,
    canFire,
    isHeldWeaponFullAuto,
    getHeldWeaponItem,
    getHeldWeaponSlot,
    getMagReadout,
    getRecoil: () => state.recoil,
    getCrosshairGapPx,
    syncCrosshairBloom,
    getSecondaryTurretCrosshairGapPx,
    getWeaponId: () => state.weaponId,
    drawMuzzleFlash,
    PROJECTILE_STYLE,
  };
})();
