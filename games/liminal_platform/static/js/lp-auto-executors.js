/**
 * 枢机自动化行为执行 + 轻量规则调度。
 * 统一优先级列表：按数组顺序；同冲突域同 tick 只执行最高优先级匹配项。
 * select_ammo：经 LpArmedAmmo.applyAmmoSelection 写入 autoByCar（自动装载序列），
 * 不改写本机弹药箱弹链；玩家手动切组/弹种会清除自动装载。
 * lock_unit：写入 LpCombat 锁定（卫兵多塔分塔锁，尽量不重复目标）；
 * 空闲卫兵炮塔各自对分塔锁定提前瞄准并开火。
 */
(() => {
  const Prog = () => window.LpAutoProgram;
  const Cat = () => window.LpAutoProgramCatalog;
  const Sensors = () => window.LpAutoSensors;
  const Ammo = () => window.LpArmedAmmo;
  const Combat = () => window.LpCombat;
  const Guard = () => window.LpGuardTurret;

  /**
   * 边沿状态：carId → ruleId → 上一帧条件真假。
   * @type {Record<string, Record<string, boolean>>}
   */
  const edgePrev = Object.create(null);

  /**
   * 执行「选择弹种/弹链」：解析 target；弹链优先用 params.slots（内嵌），旧 belt:id 回退查 beltsByCar。
   * @param {string} carId
   * @param {Record<string, unknown>} params
   * @returns {boolean}
   */
  function executeSelectAmmo(carId, params) {
    const parsed = Cat()?.parseAmmoTarget?.(params?.target) || {
      kind: 'type',
      ammo: 'ap',
    };
    if (parsed.kind === 'belt') {
      let slots = Array.isArray(params?.slots) ? params.slots : null;
      if (!slots?.length && parsed.beltId) {
        slots = Prog()?.getBelt?.(carId, parsed.beltId)?.slots || null;
      }
      if (!slots?.length) return false;
      const normalized =
        Cat()?.normalizeAmmoSlots?.(carId, slots) || slots;
      return Boolean(
        Ammo()?.applyAmmoSelection?.(
          carId,
          { kind: 'belt', slots: normalized },
          { toast: false }
        )
      );
    }
    return Boolean(
      Ammo()?.applyAmmoSelection?.(
        carId,
        { kind: 'type', ammo: parsed.ammo },
        { toast: false }
      )
    );
  }

  /**
   * 按 params.target 模式锁定射程内敌方，写入 LpCombat（供传感与炮塔交战）。
   * 卫兵：对每座空闲自动塔各写一把锁；选敌时尽量避开同车其它塔已锁之敌（仅一目标时可共享）。
   * 入座塔清自动锁，避免与玩家抢目标。
   * @param {string} carId
   * @param {Record<string, unknown>} params
   * @returns {boolean}
   */
  function executeLockUnit(carId, params) {
    const combat = Combat();
    if (!combat?.pickLockTarget || !combat?.setLockedHostile) return false;
    const mode = String(params?.target || 'nearest');
    const gt = Guard();
    if (carId === 'guard' && typeof gt?.getAutoEngageTurretIds === 'function') {
      const free = gt.getAutoEngageTurretIds() || [];
      for (const id of ['left', 'right']) {
        if (!free.includes(id)) combat.clearLockedHostile?.(carId, id);
      }
      if (!free.length) return false;
      /** @type {string[]} */
      const claimed = [];
      let any = false;
      for (const turretId of free) {
        const picked = combat.pickLockTarget(carId, mode, {
          turretId,
          excludeIds: claimed,
        });
        if (!picked) {
          combat.clearLockedHostile?.(carId, turretId);
          continue;
        }
        combat.setLockedHostile(carId, picked, turretId);
        if (picked.id != null) claimed.push(String(picked.id));
        any = true;
      }
      return any;
    }
    const picked = combat.pickLockTarget(carId, mode);
    if (!picked) {
      combat.clearLockedHostile?.(carId);
      return false;
    }
    combat.setLockedHostile(carId, picked);
    return true;
  }

  /**
   * 简化表达式：数字、`$变量名`、`$变量 ± 数`。
   * @param {string} carId
   * @param {string} expr
   */
  function evalSimpleExpr(carId, expr) {
    const raw = String(expr || '').trim();
    if (!raw) return 0;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw) || 0;
    const m = raw.match(/^\$([^\s+-]+)\s*([+-])\s*(-?\d+(\.\d+)?)$/);
    if (m) {
      const base = Sensors()?.readProgramVar?.(carId, m[1]) ?? 0;
      const n = Number(m[3]) || 0;
      return m[2] === '-' ? base - n : base + n;
    }
    if (raw.startsWith('$')) {
      return Sensors()?.readProgramVar?.(carId, raw.slice(1)) ?? 0;
    }
    return Number(raw) || 0;
  }

  /**
   * 执行一条行为；未知 id 视为成功无操作。
   * @param {{ id?: string, params?: Record<string, unknown> }} action
   * @param {string} carId
   * @returns {boolean}
   */
  function executeAction(action, carId) {
    if (!action?.id || !carId) return false;
    const params = action.params || {};
    switch (action.id) {
      case 'select_ammo':
      case 'turret_ammo': {
        const migrated =
          Cat()?.migrateAction?.(action, { carId }) || action;
        return executeSelectAmmo(carId, migrated.params || {});
      }
      case 'send_alert': {
        const msg = String(params.message || '').trim();
        if (msg) window.LiminalInteract?.showToast?.(msg);
        return true;
      }
      case 'set_var': {
        const name = String(params.name || '');
        if (!name || Cat()?.isReadonlyVar?.(name)) return false;
        const value = evalSimpleExpr(carId, String(params.expr || '0'));
        if (Cat()?.isGlobalScopedVar?.(name)) {
          const g = Prog()?.getGlobalVars?.() || {};
          g[name] = value;
          Prog()?.setGlobalVars?.(g);
          return true;
        }
        if (Cat()?.isCarScopedVar?.(name)) {
          const c = Prog()?.getCarVars?.(carId) || {};
          c[name] = value;
          Prog()?.setCarVars?.(carId, c);
          return true;
        }
        return false;
      }
      case 'set_speed': {
        /* 驾驶台自动驾驶接通时由 LpAutoAutopilot 独占节流；跳过规则改速以免抢写 */
        if (window.LpAutoAutopilot?.isEngaged?.()) return false;
        const speed = evalSimpleExpr(carId, String(params.speed || '0'));
        const drive = window.LpTrainDrive;
        if (typeof drive?.setTargetSpeed === 'function') {
          drive.setTargetSpeed(speed);
          return true;
        }
        if (typeof drive?.setSpeed === 'function') {
          drive.setSpeed(speed);
          return true;
        }
        return false;
      }
      case 'lock_unit':
        return executeLockUnit(carId, params);
      case 'noop':
        return true;
      default:
        return false;
    }
  }

  /**
   * 取车厢运行时规则列表（扁平；兼容旧 continuous+edge 结构）。
   * @param {string} carId
   * @returns {object[]}
   */
  function rulesForCar(carId) {
    const raw = Prog()?.rulesForRuntime?.(carId);
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    return [...(raw.continuous || []), ...(raw.edge || [])];
  }

  /**
   * 清除某冲突域边沿闩锁：下次条件仍为真时 edge 规则会再执行一次。
   * 用于玩家离席后恢复 select_ammo（入座曾清 autoByCar，边沿已闩住则无人炮不会重装）。
   * @param {string} carId
   * @param {string} domain
   */
  function resetEdgeForDomain(carId, domain) {
    if (!carId || !domain || !edgePrev[carId]) return;
    const catalog = Cat();
    const prevMap = edgePrev[carId];
    for (const rule of rulesForCar(carId)) {
      if (!rule?.id) continue;
      if ((catalog?.conflictDomainForAction?.(rule.action) ?? null) !== domain) {
        continue;
      }
      prevMap[rule.id] = false;
    }
  }

  /**
   * 调度一节车厢：统一优先级列表；冲突域内只执行最高优先级匹配项。
   * edge 仅在实际胜出冲突域后才闩锁；被高优先级挡住时保持上升沿，域空闲后仍可执行。
   * @param {string} carId
   */
  function tickCar(carId) {
    const sensors = Sensors();
    const catalog = Cat();
    if (!sensors?.evaluateCondition) return;
    const rules = rulesForCar(carId);
    if (!edgePrev[carId]) edgePrev[carId] = Object.create(null);
    const prevMap = edgePrev[carId];
    /** @type {Set<string>} */
    const claimed = new Set();

    for (const rule of rules) {
      if (!rule?.id) continue;
      const now = Boolean(sensors.evaluateCondition(rule.condition, carId));
      const isEdge = rule.trigger === 'edge';
      const domain = catalog?.conflictDomainForAction?.(rule.action) ?? null;

      if (isEdge) {
        if (!now) {
          prevMap[rule.id] = false;
          continue;
        }
        if (prevMap[rule.id]) continue;
        if (domain && claimed.has(domain)) continue;
        if (domain) claimed.add(domain);
        prevMap[rule.id] = true;
        executeAction(rule.action, carId);
        continue;
      }

      if (!now) continue;
      if (domain) {
        if (claimed.has(domain)) continue;
        claimed.add(domain);
      }
      executeAction(rule.action, carId);
    }
  }

  /**
   * 卫兵空闲炮塔对各自的分塔锁定：每帧再验 canEngageHostile(敌, 塔)；
   * 各塔用自己的提前点瞄准，仅 canTurretFire 通过的塔开火。本机入座的塔不接管。
   */
  function engageGuardFromLock() {
    const combat = Combat();
    const gt = Guard();
    if (!combat?.getLockedHostile || !gt?.getAutoEngageTurretIds) return;

    const free = gt.getAutoEngageTurretIds() || [];
    if (!free.length) return;

    const pivots = (gt.getPivotsWorld?.() || []).filter((p) =>
      free.includes(p.id)
    );
    if (!pivots.length) return;

    const maxRange =
      combat.PROJECTILE_STYLE?.shell?.maxRange != null
        ? Number(combat.PROJECTILE_STYLE.shell.maxRange)
        : 9600;
    const r2 = maxRange * maxRange;

    /** @type {Record<string, { x: number, y: number }>} */
    const aimsByTurret = Object.create(null);
    /** @type {string[]} */
    const readyIds = [];

    for (const p of pivots) {
      const locked = combat.getLockedHostile('guard', p.id);
      if (!locked || locked.x == null || !Number.isFinite(Number(locked.x))) {
        continue;
      }
      /* 每发前再验：过近 / 钳制打不中则 getLockedHostile 已清该塔锁，此处双保险。 */
      if (
        combat.canEngageHostile &&
        !combat.canEngageHostile(locked, p.id)
      ) {
        continue;
      }
      const mx = Number(p.x);
      const my = Number(p.y);
      if (!Number.isFinite(mx) || !Number.isFinite(my)) continue;
      const ty =
        locked.y != null && Number.isFinite(Number(locked.y))
          ? Number(locked.y)
          : my;
      const target = { ...locked, y: ty };
      const lead =
        combat.predictLeadAim?.(mx, my, target) || {
          x: Number(locked.x),
          y: ty,
        };
      const ax = Number(lead.x);
      const ay = Number(lead.y);
      if (!Number.isFinite(ax) || !Number.isFinite(ay)) continue;
      const dx = ax - mx;
      const dy = ay - my;
      if (dx * dx + dy * dy > r2) continue;
      if (!gt.canTurretEngageAim?.(ax, ay, p.id)) continue;
      gt.aimTurrets?.(ax, ay, [p.id]);
      aimsByTurret[p.id] = { x: ax, y: ay };
      if (!gt.canTurretFire?.(ax, ay, p.id)) continue;
      readyIds.push(p.id);
    }
    if (!readyIds.length) return;
    const primary = aimsByTurret[readyIds[0]];
    gt.tryFireTurrets?.(primary.x, primary.y, readyIds, {
      silentEmpty: true,
      aimsByTurret,
    });
  }

  /**
   * 每帧规则调度（在传感器写入局部变量之后调用）。
   * 枢机控制台打开时暂停规则，避免编辑中误触发。
   * 驾驶台自动驾驶与枢机无关：规则暂停时仍 tick 自动驾驶。
   */
  function tick(_dt) {
    if (!window.LpAutoConsole?.isOpen?.()) {
      const cars = window.LiminalCarriageSpec?.CARRIAGES || [];
      for (const car of cars) {
        if (car?.id) tickCar(car.id);
      }
      engageGuardFromLock();
    }
    window.LpAutoAutopilot?.tick?.();
  }

  /**
   * 兼容窥视：while=条件为真；edge=上升沿（只读 prevMap，不闩锁）。
   * 真正调度以 tickCar 为准（冲突域胜出后才写边沿闩）。
   * @param {object} rule
   * @param {boolean} now
   * @param {Record<string, boolean>} prevMap
   */
  function shouldFireRule(rule, now, prevMap) {
    if (rule?.trigger === 'edge') {
      return Boolean(now) && !Boolean(prevMap?.[rule.id]);
    }
    return Boolean(now);
  }

  window.LpAutoExecutors = {
    executeAction,
    executeSelectAmmo,
    executeLockUnit,
    engageGuardFromLock,
    shouldFireRule,
    resetEdgeForDomain,
    tick,
    tickCar,
  };
})();
