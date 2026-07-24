/**
 * 枢机自动化行为执行 + 轻量规则调度。
 * select_ammo：经 LpArmedAmmo.applyAmmoSelection 写入 autoByCar（自动装载序列），
 * 不改写本机弹药箱弹链；玩家手动切组/弹种会清除自动装载。
 */
(() => {
  const Prog = () => window.LpAutoProgram;
  const Cat = () => window.LpAutoProgramCatalog;
  const Sensors = () => window.LpAutoSensors;
  const Ammo = () => window.LpArmedAmmo;

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
        const migrated = Cat()?.migrateAction?.(action) || action;
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
        /* 锁定由战斗/炮塔后续接入；此处占位以免打断调度。 */
        return true;
      case 'noop':
        return true;
      default:
        return false;
    }
  }

  /**
   * 调度一节车厢：持续规则全匹配执行；瞬时规则仅上升沿执行。
   * @param {string} carId
   */
  function tickCar(carId) {
    const prog = Prog();
    const sensors = Sensors();
    if (!prog?.rulesForRuntime || !sensors?.evaluateCondition) return;
    const { continuous, edge } = prog.rulesForRuntime(carId);
    if (!edgePrev[carId]) edgePrev[carId] = Object.create(null);
    const prevMap = edgePrev[carId];

    for (const rule of continuous || []) {
      if (sensors.evaluateCondition(rule.condition, carId)) {
        executeAction(rule.action, carId);
      }
    }

    for (const rule of edge || []) {
      const now = Boolean(sensors.evaluateCondition(rule.condition, carId));
      const was = Boolean(prevMap[rule.id]);
      if (now && !was) {
        executeAction(rule.action, carId);
      }
      prevMap[rule.id] = now;
    }
  }

  /**
   * 每帧规则调度（在传感器写入局部变量之后调用）。
   * 控制台打开时暂停，避免编辑中误触发。
   */
  function tick(_dt) {
    if (window.LpAutoConsole?.isOpen?.()) return;
    const cars = window.LiminalCarriageSpec?.CARRIAGES || [];
    for (const car of cars) {
      if (car?.id) tickCar(car.id);
    }
  }

  window.LpAutoExecutors = {
    executeAction,
    executeSelectAmmo,
    tick,
    tickCar,
  };
})();
