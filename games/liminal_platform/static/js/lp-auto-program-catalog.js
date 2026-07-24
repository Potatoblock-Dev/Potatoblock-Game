/**
 * 枢机车厢自动化：条件 / 行为目录（按车厢过滤行为）。
 * 规则语义见 docs/liminal-auto-program.md；持续判定段内上→下为优先级，瞬时触发无优先级。
 */
(() => {
  /** 触发模式。 */
  const TRIGGERS = [
    {
      id: 'while',
      label: '持续判定',
      hint: '每帧检查；条件为真就执行（类似 while）',
    },
    {
      id: 'edge',
      label: '瞬时触发',
      hint: '仅在条件从假变真的那一帧执行一次；列表顺序无优先级',
    },
  ];

  /**
   * 比较符选项（条件共用）：eq/neq/gt/lt/gte/lte。
   * UI 用 Python 风格符号；title 为中文名（悬浮延迟提示）。
   * @type {Array<{ value:string, label:string, title:string }>}
   */
  const COMPARE_OPS = [
    { value: 'eq', label: '=', title: '等于' },
    { value: 'neq', label: '!=', title: '不等于' },
    { value: 'gt', label: '>', title: '大于' },
    { value: 'lt', label: '<', title: '小于' },
    { value: 'gte', label: '>=', title: '大于等于' },
    { value: 'lte', label: '<=', title: '小于等于' },
  ];

  /**
   * 构造条件共用的比较符 select 参数。
   * @param {string} defaultOp COMPARE_OPS 中的 value
   */
  function compareOpParam(defaultOp) {
    return {
      key: 'op',
      label: '比较符',
      type: 'select',
      options: COMPARE_OPS,
      default: defaultOp,
    };
  }

  /**
   * 数值比较：按 op 判断 a 与 b（非有限数视为不等成立条件为假）。
   * @param {number} a
   * @param {string} op
   * @param {number} b
   */
  function compare(a, op, b) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    switch (op) {
      case 'eq':
        return left === right;
      case 'neq':
        return left !== right;
      case 'gt':
        return left > right;
      case 'lt':
        return left < right;
      case 'gte':
        return left >= right;
      case 'lte':
        return left <= right;
      default:
        return false;
    }
  }

  /**
   * 旧剪贴板/存档中比较条件缺 `op` 时的默认比较符（保持历史「低于/高于/大于」语义）。
   * @type {Record<string, string>}
   */
  const LEGACY_COMPARE_OPS = {
    enemy_hp_below: 'lt',
    ammo_below: 'lt',
    fuel_below: 'lt',
    speed_above: 'gt',
    var_gt: 'gt',
  };

  /**
   * 迁移条件 params：为旧比较条件补默认 `op`；其它键原样保留。
   * @param {{ id?: string, params?: Record<string, unknown> }|null|undefined} condition
   */
  function migrateConditionParams(condition) {
    if (!condition || typeof condition !== 'object') {
      return { id: 'always', params: {} };
    }
    const id = typeof condition.id === 'string' && condition.id ? condition.id : 'always';
    const params = { ...(condition.params || {}) };
    const legacyOp = LEGACY_COMPARE_OPS[id];
    if (legacyOp && (params.op == null || params.op === '')) {
      params.op = legacyOp;
    }
    return { id, params };
  }

  /**
   * 条件目录。cars: null=全车可用；否则为允许的 carId 列表。params 为空数组表示无需填参。
   * 比较类条件统一带 `op` + 阈值；id 保留旧名以兼容存档。
   * @type {Array<{ id:string, label:string, hint?:string, cars:string[]|null, params:Array<object> }>}
   */
  const CONDITIONS = [
    {
      id: 'enemy_in_range',
      label: '射程内存在敌方',
      hint: '炮塔/探测射程内是否有敌方单位',
      cars: ['guard', 'huigui'],
      params: [],
    },
    {
      id: 'enemy_hp_below',
      label: '敌方生命值',
      hint: '当前锁定或最近敌方的生命值，按比较符与阈值判定',
      cars: ['guard', 'huigui'],
      params: [
        compareOpParam('lt'),
        { key: 'hp', label: '生命值', type: 'number', min: 0, max: 100, default: 10 },
      ],
    },
    {
      id: 'ammo_below',
      label: '弹药剩余量',
      hint: '本车厢弹药箱剩余，按比较符与阈值判定',
      cars: ['guard'],
      params: [
        compareOpParam('lt'),
        { key: 'count', label: '数量', type: 'number', min: 0, max: 999, default: 3 },
      ],
    },
    {
      id: 'fuel_below',
      label: '锅炉燃料',
      hint: '动力车锅炉燃料百分比或点数，按比较符与阈值判定',
      cars: ['power'],
      params: [
        compareOpParam('lt'),
        { key: 'level', label: '燃料', type: 'number', min: 0, max: 100, default: 20 },
      ],
    },
    {
      id: 'speed_above',
      label: '车速绝对值',
      hint: '列车速度绝对值，按比较符与阈值判定',
      cars: null,
      params: [
        compareOpParam('gt'),
        { key: 'speed', label: '速度', type: 'number', min: 0, max: 200, default: 40 },
      ],
    },
    {
      id: 'var_gt',
      label: '变量',
      hint: '比较玩家参数 / 计数器与阈值',
      cars: null,
      params: [
        { key: 'name', label: '变量名', type: 'var', default: '计数器' },
        compareOpParam('gt'),
        { key: 'value', label: '阈值', type: 'number', default: 10 },
      ],
    },
    {
      id: 'targets_in_view',
      label: '视野内目标数',
      hint: '绘轨雷达探测射程内目标数量（同「范围内目标数」传感）',
      cars: ['huigui'],
      params: [
        compareOpParam('gte'),
        { key: 'count', label: '数量', type: 'number', min: 0, max: 99, default: 1 },
      ],
    },
    {
      id: 'car_on_fire',
      label: '车厢着火',
      hint: '本车厢是否着火（着火系统尚未接入；运行时暂恒为假）',
      cars: null,
      params: [],
    },
    {
      id: 'always',
      label: '总是（无条件）',
      cars: null,
      params: [],
    },
  ];

  /**
   * 行为目录。cars: null=全车可用；否则为允许的 carId 列表。
   * 不提供「控制炮塔角度」类行为；瞄准由锁定单位驱动。
   */
  const ACTIONS = [
    {
      id: 'lock_unit',
      label: '锁定单位',
      hint: '按选项锁定射程内敌方（最近/最远/生命值/护甲）',
      cars: ['guard', 'huigui'],
      params: [
        {
          key: 'target',
          label: '目标',
          type: 'select',
          options: [
            { value: 'nearest', label: '最近' },
            { value: 'farthest', label: '最远' },
            { value: 'highest_hp', label: '生命值最高' },
            { value: 'lowest_hp', label: '生命值最低' },
            { value: 'highest_armor', label: '护甲最高' },
            { value: 'lowest_armor', label: '护甲最低' },
          ],
          default: 'nearest',
        },
      ],
    },
    {
      id: 'select_ammo',
      label: '选择弹种/弹链',
      hint:
        '在参数区选弹种，或（连发车）直接编辑弹链槽位；写入 params.target + 可选 params.slots，无需手输 id',
      cars: ['guard'],
      params: [
        {
          key: 'target',
          label: '弹种/弹链',
          type: 'ammoTarget',
          default: 'type:ap',
        },
      ],
    },
    {
      id: 'set_var',
      label: '设置变量',
      cars: null,
      hint: '支持 = 常数或 变量±常数（简化式）',
      params: [
        { key: 'name', label: '变量名', type: 'var', default: '计数器' },
        {
          key: 'expr',
          label: '表达式',
          type: 'text',
          default: '$计数器 + 1',
          placeholder: '$计数器 + 1 或 0',
        },
      ],
    },
    {
      id: 'set_speed',
      label: '车厢设置速度',
      cars: ['power'],
      params: [
        {
          key: 'speed',
          label: '速度',
          type: 'varOrNumber',
          default: '$撤退速度',
          placeholder: '数字或 $变量名',
        },
      ],
    },
    {
      id: 'send_alert',
      label: '发送警报',
      cars: null,
      params: [
        { key: 'message', label: '内容', type: 'text', default: '弹药告急！' },
      ],
    },
    {
      id: 'noop',
      label: '（占位）无操作',
      cars: null,
      params: [],
    },
  ];

  /**
   * 玩家变量目录。scope=global 列车共用；scope=car 随选中车厢。
   * cars: null=全车局部；否则仅这些 carId 显示/建表。
   * readonly: 运行时传感器写入，控制台不可改。
   * 炮塔瞄准提前量 / 角速度修正已内置（LpGuardTurret），不作为玩家参数。
   */
  const VAR_DEFS = [
    { name: '撤退速度', default: -40, scope: 'global' },
    { name: '冲锋速度', default: 60, scope: 'global' },
    {
      name: '计数器',
      id: 'counter',
      default: 0,
      scope: 'car',
      cars: null,
      hint: '通用整数计数（各车独立；可写）',
    },
    {
      name: '锁定计数器',
      id: 'lock_counter',
      default: 0,
      scope: 'car',
      cars: null,
      hint: '锁定相关计数（各车独立；可写）',
    },
    {
      name: '范围内目标数',
      id: 'targets_in_range',
      default: 0,
      scope: 'car',
      cars: ['guard', 'huigui'],
      readonly: true,
      hint: '本车武器/探测射程内的目标数量（运行时传感器）',
    },
    {
      name: '剩余弹药数',
      id: 'ammo_remaining',
      default: 0,
      scope: 'car',
      cars: ['guard'],
      readonly: true,
      hint: '卫兵弹药箱剩余发数（同状态栏「弹药 N」）',
    },
  ];

  /** 旧剪贴板/localStorage 中已移除的炮塔瞄准参数名（导入时丢弃）。 */
  const RETIRED_VAR_NAMES = ['动态提前量', '角速度修正'];

  /** 按 name 查变量定义。 */
  function varDefByName(name) {
    return VAR_DEFS.find((d) => d.name === name) || null;
  }

  /** 车厢局部定义是否适用于该 carId（cars 空/null = 全车）。 */
  function varDefAppliesToCar(def, carId) {
    if (!def || def.scope !== 'car') return false;
    if (!def.cars || !def.cars.length) return true;
    if (!carId) return false;
    return def.cars.includes(carId);
  }

  /** 按 scope 取出默认键值表（car 且无 carId 时为全部局部键并集）。 */
  function defaultsForScope(scope, carId) {
    const out = {};
    for (const d of VAR_DEFS) {
      if (d.scope !== scope) continue;
      if (scope === 'car' && carId != null && !varDefAppliesToCar(d, carId)) continue;
      out[d.name] = d.default;
    }
    return out;
  }

  /** 全局变量默认值。 */
  function defaultGlobalVars() {
    return defaultsForScope('global');
  }

  /**
   * 车厢局部变量默认值。
   * @param {string} [carId] 传入则只含该车可用键；省略则为全部局部键并集（迁移用）
   */
  function defaultCarVars(carId) {
    return defaultsForScope('car', carId);
  }

  /** 该车只读传感器局部变量名。 */
  function sensorCarVarNames(carId) {
    return VAR_DEFS.filter(
      (d) => d.readonly && varDefAppliesToCar(d, carId)
    ).map((d) => d.name);
  }

  /** 该车玩家可写局部变量名。 */
  function writableCarVarNames(carId) {
    return VAR_DEFS.filter(
      (d) => !d.readonly && varDefAppliesToCar(d, carId)
    ).map((d) => d.name);
  }

  /**
   * 兼容旧 DEFAULT_VARS 扁平表（仅含当前仍暴露的变量）。
   * @deprecated 优先用 defaultGlobalVars / defaultCarVars
   */
  const DEFAULT_VARS = { ...defaultGlobalVars(), ...defaultCarVars() };

  /** 变量名是否为车厢局部。 */
  function isCarScopedVar(name) {
    return VAR_DEFS.some((d) => d.name === name && d.scope === 'car');
  }

  /** 变量名是否为全局。 */
  function isGlobalScopedVar(name) {
    return VAR_DEFS.some((d) => d.name === name && d.scope === 'global');
  }

  /** 变量是否只读传感器。 */
  function isReadonlyVar(name) {
    return Boolean(varDefByName(name)?.readonly);
  }

  /**
   * 向导下拉：全局名 + 当前车厢可用局部名。
   * @param {string} [carId]
   * @param {{ writableOnly?: boolean }} [opts] set_var 等写入场景可只列可写名
   */
  function varNamesForPicker(carId, opts) {
    const writableOnly = Boolean(opts?.writableOnly);
    return VAR_DEFS.filter((d) => {
      if (writableOnly && d.readonly) return false;
      if (d.scope === 'car' && carId && !varDefAppliesToCar(d, carId)) return false;
      return true;
    }).map((d) => d.name);
  }

  /** 按车厢过滤可用行为（cars 为空/null 表示全车可用）。 */
  function actionsForCar(carId) {
    return ACTIONS.filter((a) => !a.cars || a.cars.includes(carId));
  }

  /** 按车厢过滤可用条件（cars 为空/null 表示全车可用）。 */
  function conditionsForCar(carId) {
    return CONDITIONS.filter((c) => !c.cars || c.cars.includes(carId));
  }

  function conditionById(id) {
    return CONDITIONS.find((c) => c.id === id) || null;
  }

  function actionById(id) {
    return ACTIONS.find((a) => a.id === id) || null;
  }

  function triggerById(id) {
    return TRIGGERS.find((t) => t.id === id) || TRIGGERS[0];
  }

  /**
   * 解析 select_ammo 的 target：`type:ap` / `belt`（内嵌 slots）/ 旧 `belt:pb_…`；裸 id 视为弹种。
   * @param {unknown} raw
   * @returns {{ kind: 'type', ammo: string } | { kind: 'belt', beltId: string }}
   */
  function parseAmmoTarget(raw) {
    const s = String(raw ?? '').trim();
    if (s === 'belt' || s.startsWith('belt:')) {
      return { kind: 'belt', beltId: s === 'belt' ? '' : s.slice(5) };
    }
    if (s.startsWith('type:')) {
      return { kind: 'type', ammo: s.slice(5).toLowerCase() || 'ap' };
    }
    return { kind: 'type', ammo: (s || 'ap').toLowerCase() };
  }

  /**
   * 按车厢配置消毒弹链槽位数组（长度=slotsPerBelt，落在 allowedTypes）。
   * @param {string} carId
   * @param {unknown} slots
   * @returns {string[]}
   */
  function normalizeAmmoSlots(carId, slots) {
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    const n = cfg?.slotsPerBelt || 3;
    const allowed = new Set(cfg?.allowedTypes?.length ? cfg.allowedTypes : ['ap']);
    const fallback = allowed.has('ap') ? 'ap' : [...allowed][0] || 'ap';
    const src = Array.isArray(slots) ? slots : cfg?.defaultSlots || [];
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const id = String(src[i] || '').toLowerCase();
      out.push(allowed.has(id) ? id : fallback);
    }
    return out;
  }

  /**
   * 弹种选项（内联 chips / 摘要）：车厢 allowedTypes。
   * @param {string} carId
   * @returns {Array<{ value: string, label: string, tag: string }>}
   */
  function ammoTypeOptionsForCar(carId) {
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    const types = cfg?.allowedTypes?.length ? cfg.allowedTypes : ['ap'];
    return types.map((id) => {
      const def = Ammo?.getType?.(id) || { tag: String(id).toUpperCase(), subtitle: id };
      return {
        value: `type:${id}`,
        label: `${def.subtitle} ${def.tag}`,
        tag: def.tag,
        ammo: id,
      };
    });
  }

  /**
   * 向导兼容：弹种 +（旧）程序弹链选项；新 UI 用 ammoTypeOptions + 内嵌 slots。
   * @param {string} carId
   * @returns {Array<{ value: string, label: string }>}
   */
  function ammoTargetOptionsForCar(carId) {
    const opts = ammoTypeOptionsForCar(carId).map((o) => ({
      value: o.value,
      label: o.label,
    }));
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    if (cfg?.supportsBelts) {
      const belts = window.LpAutoProgram?.getBelts?.(carId) || [];
      belts.forEach((belt, i) => {
        const pattern =
          Ammo?.formatBeltPattern?.(belt.slots) ||
          (belt.slots || []).join('/');
        opts.push({
          value: `belt:${belt.id}`,
          label: `程序弹链 ${i + 1}（${pattern}）`,
        });
      });
    }
    return opts.length ? opts : [{ value: 'type:ap', label: '穿甲 AP' }];
  }

  /**
   * 迁移行为：旧 turret_ammo → select_ammo；`belt:id` 展开为 target=belt + slots。
   * @param {{ id?: string, params?: Record<string, unknown> }} action
   * @param {{ carId?: string, belts?: Array<{ id: string, slots: string[] }> }} [ctx]
   */
  function migrateAction(action, ctx) {
    if (!action || typeof action !== 'object') {
      return { id: 'noop', params: {} };
    }
    const params = { ...(action.params || {}) };
    if (action.id === 'turret_ammo') {
      let ammo = String(params.ammo ?? params.target ?? 'ap')
        .replace(/^type:/i, '')
        .toLowerCase();
      const legacyMap = { he: 'ap', sap: 'ap', ap: 'ap', t: 't' };
      ammo = legacyMap[ammo] || (ammo === 'ap' || ammo === 't' ? ammo : 'ap');
      return { id: 'select_ammo', params: { target: `type:${ammo}` } };
    }
    if (action.id === 'select_ammo') {
      if (params.target == null || params.target === '') {
        const ammo = String(params.ammo || 'ap')
          .replace(/^type:/i, '')
          .toLowerCase();
        return { id: 'select_ammo', params: { target: `type:${ammo || 'ap'}` } };
      }
      const parsed = parseAmmoTarget(params.target);
      if (parsed.kind === 'type') {
        return { id: 'select_ammo', params: { target: `type:${parsed.ammo}` } };
      }
      const carId = ctx?.carId || '';
      let slots = Array.isArray(params.slots) ? params.slots : null;
      if (!slots?.length && parsed.beltId) {
        const found = (ctx?.belts || []).find((b) => b.id === parsed.beltId);
        if (found?.slots) slots = found.slots;
        else {
          const live = window.LpAutoProgram?.getBelt?.(carId, parsed.beltId);
          if (live?.slots) slots = live.slots;
        }
      }
      if (!slots?.length) {
        slots = normalizeAmmoSlots(carId, null);
      } else {
        slots = normalizeAmmoSlots(carId, slots);
      }
      return { id: 'select_ammo', params: { target: 'belt', slots } };
    }
    return { id: action.id || 'noop', params };
  }

  /** 生成可读摘要行（carId 用于 ammoTarget 选项文案）。 */
  function summarizeRule(rule, carId) {
    const trig = triggerById(rule.trigger)?.label || rule.trigger;
    const cond = conditionById(rule.condition?.id);
    const migratedAct = migrateAction(rule.action || {});
    const act = actionById(migratedAct.id);
    const cp = rule.condition?.params || {};
    const ap = migratedAct.params || {};
    const condTxt = cond
      ? `${cond.label}${formatParams(cond.params, cp, carId)}`
      : '(无条件)';
    const actTxt = act
      ? `${act.label}${formatParams(act.params, ap, carId)}`
      : '(无行为)';
    return `[${trig}] 若 ${condTxt} → ${actTxt}`;
  }

  /** 把参数值格式化为摘要文案（select / ammoTarget 显示选项中文或弹链图案）。 */
  function formatParams(schema, values, carId) {
    if (!schema?.length) return '';
    const parts = schema.map((p) => {
      const v = values[p.key];
      if (v === undefined || v === '') return null;
      if (p.type === 'ammoTarget') {
        const parsed = parseAmmoTarget(v);
        if (parsed.kind === 'belt') {
          const slots = normalizeAmmoSlots(carId, values.slots);
          const pattern =
            window.LpArmedAmmo?.formatBeltPattern?.(slots) || slots.join('/');
          return `弹链 ${pattern}`;
        }
        const opt = ammoTypeOptionsForCar(carId).find((o) => o.value === `type:${parsed.ammo}`);
        return opt?.label || String(v);
      }
      if (p.type === 'select' && Array.isArray(p.options)) {
        const opt = p.options.find((o) => o.value === v);
        return opt?.label || String(v);
      }
      return String(v);
    }).filter(Boolean);
    return parts.length ? `（${parts.join(', ')}）` : '';
  }

  /** 填参数默认值。 */
  function defaultParams(schema) {
    const out = {};
    for (const p of schema || []) {
      if (p.default !== undefined) out[p.key] = p.default;
    }
    return out;
  }

  /**
   * 车厢短名（警报文案用）：优先编组 map.shortLabel，否则兜底表。
   * @param {string} carId
   */
  function carShortLabel(carId) {
    const car = window.LiminalCarriageSpec?.carriageById?.(carId);
    const fromSpec = car?.map?.shortLabel || car?.label;
    if (fromSpec) return fromSpec;
    return (
      {
        guard: '卫兵',
        storage: '仓储',
        power: '动力',
        huigui: '绘轨',
        shuji: '枢机',
      }[carId] || carId || '未知'
    );
  }

  /** 默认着火警报文案，如「枢机车厢着火！」。 */
  function defaultFireAlertMessage(carId) {
    return `${carShortLabel(carId)}车厢着火！`;
  }

  /**
   * 是否为库存「着火→警报」规则（按 condition.id + action.id 判定，不比消息）。
   * @param {object} rule
   */
  function isStockFireAlertRule(rule) {
    return rule?.condition?.id === 'car_on_fire' && rule?.action?.id === 'send_alert';
  }

  /**
   * 构造单车默认持续规则：车厢着火 → 发送警报。
   * 使用稳定 id，便于导出/再导入时去重。
   * @param {string} carId
   */
  function makeDefaultFireAlertRule(carId) {
    return {
      id: `stock_fire_alert_${carId || 'unknown'}`,
      trigger: 'while',
      condition: { id: 'car_on_fire', params: {} },
      action: {
        id: 'send_alert',
        params: { message: defaultFireAlertMessage(carId) },
      },
      note: '',
    };
  }

  /** 某车厢程序默认规则列表（当前仅着火警报一行）。 */
  function defaultRulesForCar(carId) {
    return [makeDefaultFireAlertRule(carId)];
  }

  /**
   * 若列表中尚无 car_on_fire→send_alert，则在持续段最前插入库存规则；不删其它规则。
   * @param {string} carId
   * @param {Array<object>|null|undefined} rules
   * @returns {object[]}
   */
  function ensureStockRules(carId, rules) {
    const list = Array.isArray(rules) ? rules.slice() : [];
    if (list.some(isStockFireAlertRule)) return list;
    return [makeDefaultFireAlertRule(carId), ...list];
  }

  window.LpAutoProgramCatalog = {
    TRIGGERS,
    CONDITIONS,
    ACTIONS,
    COMPARE_OPS,
    LEGACY_COMPARE_OPS,
    VAR_DEFS,
    RETIRED_VAR_NAMES,
    DEFAULT_VARS,
    compare,
    compareOpParam,
    migrateConditionParams,
    migrateAction,
    parseAmmoTarget,
    normalizeAmmoSlots,
    ammoTypeOptionsForCar,
    ammoTargetOptionsForCar,
    defaultGlobalVars,
    defaultCarVars,
    defaultRulesForCar,
    defaultFireAlertMessage,
    makeDefaultFireAlertRule,
    isStockFireAlertRule,
    ensureStockRules,
    carShortLabel,
    varDefByName,
    varDefAppliesToCar,
    sensorCarVarNames,
    writableCarVarNames,
    isCarScopedVar,
    isGlobalScopedVar,
    isReadonlyVar,
    varNamesForPicker,
    actionsForCar,
    conditionsForCar,
    conditionById,
    actionById,
    triggerById,
    summarizeRule,
    formatParams,
    defaultParams,
  };
})();
