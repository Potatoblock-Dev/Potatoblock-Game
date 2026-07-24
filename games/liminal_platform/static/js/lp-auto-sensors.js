/**
 * 枢机自动化传感器：只读局部变量刷新 + 条件求值钩子。
 * - 范围内目标数 / 剩余弹药数：每帧写入武装车厢局部变量
 * - 比较类条件经 Catalog.compare(op)；绘轨「视野内目标数」与范围内计数同源
 * - compare_values：左右操作数可为数值或变量（leftKind/rightKind）
 * - turret_lock_kind：读炮塔锁定分类（API / hostile.kind / stub 表）
 * - car_on_fire：着火系统未接入前读 stub 表（默认假）；可用 setCarOnFire 调试
 */
(() => {
  const Prog = () => window.LpAutoProgram;
  const Cat = () => window.LpAutoProgramCatalog;

  /** @type {Array<{ id?: string, x: number, y?: number, kind?: string, hp?: number }>} */
  let hostiles = [];

  /** @type {Record<string, boolean>} carId → 是否着火（stub；默认无键=假） */
  const carOnFire = Object.create(null);

  /**
   * 炮塔当前锁定分类 stub：carId → none|ground|air|large。
   * 战斗/炮塔正式接入前由 setTurretLockKind 或 hostile.kind 推断。
   * @type {Record<string, string>}
   */
  const turretLockKindByCar = Object.create(null);

  const TURRET_LOCK_KINDS = new Set(['none', 'ground', 'air', 'large']);

  const ARMED_TARGET_CARS = ['guard', 'huigui'];
  const AMMO_CARS = ['guard'];

  /** 注册当前敌方/接触列表（世界坐标）；供战斗系统或调试喂入。 */
  function setHostiles(list) {
    hostiles = Array.isArray(list) ? list.slice() : [];
  }

  /** 当前敌方列表副本。 */
  function getHostiles() {
    return hostiles.slice();
  }

  /** 读取某车厢着火状态；未设置或未知 id 视为未着火。 */
  function isCarOnFire(carId) {
    if (!carId) return false;
    return Boolean(carOnFire[carId]);
  }

  /**
   * 写入某车厢着火状态（供未来着火系统或调试调用）。
   * @param {string} carId
   * @param {boolean} onFire
   */
  function setCarOnFire(carId, onFire) {
    if (!carId) return;
    if (onFire) {
      carOnFire[carId] = true;
    } else {
      delete carOnFire[carId];
    }
  }

  /** 车厢走道中心世界坐标。 */
  function carCenter(carId) {
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageById?.(carId);
    if (!car || !Spec) return null;
    const mid = (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    return { x: car.worldX + mid, y: Spec.FLOOR_Y };
  }

  /** 卫兵炮塔炮弹最大射程（世界像素）。 */
  function guardWeaponRange() {
    const shell = window.LpCombat?.PROJECTILE_STYLE?.shell;
    if (shell?.maxRange != null && Number.isFinite(shell.maxRange)) {
      return Math.max(0, shell.maxRange);
    }
    return 9600;
  }

  /** 绘轨锁定/探测量程上限（世界像素）。 */
  function huiguiDetectRange() {
    const radar = window.LpRadarScope;
    if (typeof radar?.getLockRangeMax === 'function') {
      return radar.getLockRangeMax();
    }
    return 6000;
  }

  /** 某武装车用于「范围内目标数」的射程。 */
  function rangeForCar(carId) {
    if (carId === 'guard') return guardWeaponRange();
    if (carId === 'huigui') return huiguiDetectRange();
    return 0;
  }

  /**
   * 收集敌方候选：优先 LpCombat.listHostiles；否则用本模块 setHostiles；
   * 再合并雷达外部 contacts（若暴露 getContacts）。
   */
  function collectHostiles() {
    const combatList = window.LpCombat?.listHostiles?.();
    if (Array.isArray(combatList) && combatList.length) return combatList;
    const fromRadar = window.LpRadarScope?.getContacts?.();
    const merged = hostiles.slice();
    if (Array.isArray(fromRadar)) {
      for (const c of fromRadar) {
        if (!c || c.x == null) continue;
        const kind = String(c.kind || '');
        if (kind.startsWith('own')) continue;
        merged.push(c);
      }
    }
    return merged;
  }

  /**
   * 统计 carId 射程内的目标数量。
   * 优先 LpCombat.countHostilesInRange(carId)；否则按中心距离过滤。
   */
  function countTargetsInRange(carId) {
    const fromCombat = window.LpCombat?.countHostilesInRange?.(carId);
    if (typeof fromCombat === 'number' && Number.isFinite(fromCombat)) {
      return Math.max(0, Math.floor(fromCombat));
    }
    const origin = carCenter(carId);
    const range = rangeForCar(carId);
    if (!origin || range <= 0) return 0;
    let n = 0;
    for (const h of collectHostiles()) {
      if (h?.x == null || !Number.isFinite(h.x)) continue;
      const dy = (h.y != null && Number.isFinite(h.y) ? h.y : origin.y) - origin.y;
      const dx = h.x - origin.x;
      if (dx * dx + dy * dy <= range * range) n += 1;
    }
    return n;
  }

  /** 卫兵剩余弹药（与状态栏「弹药 N」同源）。 */
  function readAmmo(carId) {
    if (carId !== 'guard') return 0;
    const n = window.LpGuardTurret?.ammoCount?.();
    return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  }

  /** 锅炉燃料水平（0–100；无接口时为 0）。 */
  function readFuelLevel() {
    const n = window.LiminalInteract?.getFuelLevel?.();
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  }

  /** 列车速度绝对值。 */
  function readAbsSpeed() {
    const n = window.LpTrainDrive?.getState?.()?.speed;
    return typeof n === 'number' && Number.isFinite(n) ? Math.abs(n) : 0;
  }

  /**
   * 读取程序变量数值（先局部后全局）。
   * @param {string} carId
   * @param {string} name
   */
  function readProgramVar(carId, name) {
    if (!name) return 0;
    const prog = Prog();
    const carVars = prog?.getCarVars?.(carId);
    if (carVars && Object.prototype.hasOwnProperty.call(carVars, name)) {
      const n = Number(carVars[name]);
      return Number.isFinite(n) ? n : 0;
    }
    const globals = prog?.getGlobalVars?.() || prog?.getVars?.() || {};
    const n = Number(globals[name]);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 把敌方对象粗分类为锁定类型；未知但有坐标时 stub 为 ground。
   * @param {{ kind?: string, targetClass?: string, class?: string, x?: number }|null|undefined} hostile
   * @returns {'none'|'ground'|'air'|'large'}
   */
  function classifyHostileLockKind(hostile) {
    if (!hostile) return 'none';
    const raw = String(hostile.kind || hostile.targetClass || hostile.class || '').toLowerCase();
    if (TURRET_LOCK_KINDS.has(raw) && raw !== 'none') return raw;
    if (raw.includes('air') || raw.includes('aerial') || raw.includes('fly')) return 'air';
    if (raw.includes('large') || raw.includes('capital') || raw.includes('巨')) return 'large';
    if (raw.includes('ground') || raw.includes('surface') || raw.includes('地')) return 'ground';
    if (hostile.x != null && Number.isFinite(Number(hostile.x))) return 'ground';
    return 'none';
  }

  /**
   * 读取炮塔当前锁定分类：优先战斗/炮塔 API，其次 stub 表，默认 none。
   * @param {string} carId
   * @returns {'none'|'ground'|'air'|'large'}
   */
  function readTurretLockKind(carId) {
    const fromApi =
      window.LpCombat?.getLockedHostileKind?.(carId) ??
      window.LpGuardTurret?.getLockKind?.(carId) ??
      window.LpRadarScope?.getLockedTargetKind?.(carId);
    if (typeof fromApi === 'string' && TURRET_LOCK_KINDS.has(fromApi)) return fromApi;

    const locked = window.LpCombat?.getLockedHostile?.(carId);
    if (locked) return classifyHostileLockKind(locked);

    if (Object.prototype.hasOwnProperty.call(turretLockKindByCar, carId)) {
      const stub = turretLockKindByCar[carId];
      if (TURRET_LOCK_KINDS.has(stub)) return stub;
    }
    return 'none';
  }

  /**
   * 写入炮塔锁定分类 stub（供 lock_unit / 战斗接入前调试）。
   * @param {string} carId
   * @param {string} kind none|ground|air|large
   */
  function setTurretLockKind(carId, kind) {
    if (!carId) return;
    const k = String(kind || 'none');
    if (!TURRET_LOCK_KINDS.has(k) || k === 'none') {
      delete turretLockKindByCar[carId];
      return;
    }
    turretLockKindByCar[carId] = k;
  }

  /**
   * 敌方生命值：优先战斗模块锁定目标；否则取射程内最近目标的 hp。
   * @returns {number|null}
   */
  function readEnemyHp(carId) {
    const fromCombat = window.LpCombat?.getLockedHostileHp?.(carId);
    if (typeof fromCombat === 'number' && Number.isFinite(fromCombat)) {
      return fromCombat;
    }
    const origin = carCenter(carId);
    const range = rangeForCar(carId);
    if (!origin || range <= 0) return null;
    let best = null;
    let bestD2 = Infinity;
    for (const h of collectHostiles()) {
      if (h?.x == null || !Number.isFinite(h.x)) continue;
      const dy = (h.y != null && Number.isFinite(h.y) ? h.y : origin.y) - origin.y;
      const dx = h.x - origin.x;
      const d2 = dx * dx + dy * dy;
      if (d2 > range * range || d2 >= bestD2) continue;
      if (h.hp == null || !Number.isFinite(Number(h.hp))) continue;
      bestD2 = d2;
      best = Number(h.hp);
    }
    return best;
  }

  /**
   * 从条件 params 取比较符；缺省用 legacy 默认或 fallback。
   * @param {Record<string, unknown>|null|undefined} params
   * @param {string} conditionId
   * @param {string} fallback
   */
  function resolveOp(params, conditionId, fallback) {
    const raw = params?.op;
    if (typeof raw === 'string' && raw) return raw;
    const legacy = Cat()?.LEGACY_COMPARE_OPS?.[conditionId];
    return legacy || fallback;
  }

  /**
   * 从条件 params 取有限数值；无效则用 fallback。
   * @param {Record<string, unknown>|null|undefined} params
   * @param {string} key
   * @param {number} [fallback=0]
   */
  function resolveNumber(params, key, fallback = 0) {
    const n = Number(params?.[key]);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * 比较 a 与 b；优先 Catalog.compare。
   * @param {number} a
   * @param {string} op
   * @param {number} b
   */
  function compareValues(a, op, b) {
    const fn = Cat()?.compare;
    if (typeof fn === 'function') return fn(a, op, b);
    return false;
  }

  /** 每帧把传感器值写入对应车厢局部变量（只读键）。 */
  function tick(_dt) {
    const prog = Prog();
    if (!prog?.applySensorVars) return;
    for (const carId of ARMED_TARGET_CARS) {
      const map = { 范围内目标数: countTargetsInRange(carId) };
      if (AMMO_CARS.includes(carId)) {
        map['剩余弹药数'] = readAmmo(carId);
      }
      prog.applySensorVars(carId, map);
    }
  }

  /**
   * 从 params 解析 numOrVar 操作数（left/right 等前缀）为有限数值。
   * @param {string} carId
   * @param {Record<string, unknown>|null|undefined} params
   * @param {string} prefix
   */
  function resolveNumOrVarOperand(carId, params, prefix) {
    const kind = String(params?.[`${prefix}Kind`] || 'num');
    if (kind === 'var') {
      return readProgramVar(carId, String(params?.[`${prefix}Var`] || ''));
    }
    return resolveNumber(params, `${prefix}Num`);
  }

  /**
   * 求值一条条件；未知 id 为假。着火系统落地前 car_on_fire 仅读 stub 表。
   * @param {{ id?: string, params?: Record<string, unknown> }|null|undefined} condition
   * @param {string} carId
   * @param {object} [_ctx] 预留给完整运行时（变量、弹药等）
   * @returns {boolean}
   */
  function evaluateCondition(condition, carId, _ctx) {
    const id = condition?.id;
    if (!id) return false;
    const params = condition?.params || {};
    switch (id) {
      case 'car_on_fire':
        return isCarOnFire(carId);
      case 'always':
        return true;
      case 'enemy_in_range':
        return countTargetsInRange(carId) > 0;
      case 'turret_lock_kind': {
        const want = String(params.kind || 'none');
        return readTurretLockKind(carId) === want;
      }
      case 'ammo_below':
        return compareValues(
          readAmmo(carId),
          resolveOp(params, id, 'lt'),
          resolveNumber(params, 'count')
        );
      case 'targets_in_view':
        if (carId !== 'huigui') return false;
        return compareValues(
          countTargetsInRange(carId),
          resolveOp(params, id, 'gte'),
          resolveNumber(params, 'count', 1)
        );
      case 'fuel_below':
        return compareValues(
          readFuelLevel(),
          resolveOp(params, id, 'lt'),
          resolveNumber(params, 'level')
        );
      case 'speed_above':
        return compareValues(
          readAbsSpeed(),
          resolveOp(params, id, 'gt'),
          resolveNumber(params, 'speed')
        );
      case 'var_gt':
        return compareValues(
          readProgramVar(carId, String(params.name || '')),
          resolveOp(params, id, 'gt'),
          resolveNumber(params, 'value')
        );
      case 'compare_values':
        return compareValues(
          resolveNumOrVarOperand(carId, params, 'left'),
          resolveOp(params, id, 'gt'),
          resolveNumOrVarOperand(carId, params, 'right')
        );
      case 'enemy_hp_below': {
        const hp = readEnemyHp(carId);
        if (hp == null) return false;
        return compareValues(hp, resolveOp(params, id, 'lt'), resolveNumber(params, 'hp'));
      }
      default:
        return false;
    }
  }

  window.LpAutoSensors = {
    tick,
    setHostiles,
    getHostiles,
    countTargetsInRange,
    readAmmo,
    readFuelLevel,
    readAbsSpeed,
    readProgramVar,
    readEnemyHp,
    classifyHostileLockKind,
    readTurretLockKind,
    setTurretLockKind,
    rangeForCar,
    isCarOnFire,
    setCarOnFire,
    evaluateCondition,
  };
})();
