/**
 * 枢机自动化程序状态：按车厢存 rulesByCar（仍为一数组，trigger 区分类型）。
 * 持续判定（while）段内上→下 = 优先级；瞬时触发（edge）段内顺序仅美观、无优先级。
 * 变量分全局 vars 与车厢局部 varsByCar；程序弹链 beltsByCar；持久化 localStorage。
 * 分享两种 kind：整份程序 liminal-auto-program（覆盖）；单条规则 liminal-auto-rule（追加）。
 */
(() => {
  const STORAGE_KEY = 'lp-auto-program-v1';
  const SHARE_KIND = 'liminal-auto-program';
  /** 单条规则剪贴板 kind（导入时追加到当前车厢对应段，不覆盖整份程序）。 */
  const SHARE_RULE_KIND = 'liminal-auto-rule';
  /** v3：+beltsByCar 程序弹链；仍接受 v2。 */
  const SHARE_VERSION = 3;
  /** 单条规则分享包版本。 */
  const SHARE_RULE_VERSION = 1;
  const Catalog = () => window.LpAutoProgramCatalog;

  /**
   * 覆盖导入前的程序快照（仅内存）；用于「撤销导入」。
   * @type {null | { vars: object, varsByCar: object, rulesByCar: object, beltsByCar: object, at: number }}
   */
  let undoSnapshot = null;

  /** 旧锁定行为 → lock_unit + target。 */
  const LEGACY_LOCK = {
    lock_nearest: 'nearest',
    lock_farthest: 'farthest',
    lock_highest_hp: 'highest_hp',
    lock_lowest_hp: 'lowest_hp',
    lock_highest_armor: 'highest_armor',
    lock_lowest_armor: 'lowest_armor',
  };

  /**
   * @type {{
   *   vars: Record<string, number>,
   *   varsByCar: Record<string, Record<string, number>>,
   *   rulesByCar: Record<string, Array<object>>,
   *   beltsByCar: Record<string, Array<{ id: string, slots: string[] }>>
   * }}
   */
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        return normalizeProgram(JSON.parse(raw));
      }
    } catch {
      /* ignore */
    }
    return emptyProgram();
  }

  /** 空程序：目录默认全局变量 + 各车厢库存默认规则（着火警报）。 */
  function emptyProgram() {
    const Cat = Catalog();
    const rulesByCar = {};
    for (const c of window.LiminalCarriageSpec?.CARRIAGES || []) {
      if (!c?.id) continue;
      rulesByCar[c.id] = Cat?.defaultRulesForCar?.(c.id) || [];
    }
    return {
      vars: { ...(Cat?.defaultGlobalVars?.() || {}) },
      varsByCar: {},
      rulesByCar,
      beltsByCar: {},
    };
  }

  function save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          vars: state.vars,
          varsByCar: state.varsByCar,
          rulesByCar: state.rulesByCar,
          beltsByCar: state.beltsByCar,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function uid() {
    return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /** 程序弹链稳定 id。 */
  function beltUid() {
    return `pb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  /** 把数值表收成已知键（丢弃已退役名与非数字）。 */
  function pickNumberMap(src, allowedKeys) {
    const out = {};
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    const retired = new Set(Catalog()?.RETIRED_VAR_NAMES || []);
    for (const key of allowedKeys) {
      if (retired.has(key)) continue;
      if (src[key] === undefined || src[key] === null || src[key] === '') continue;
      out[key] = Number(src[key]) || 0;
    }
    return out;
  }

  /** 已知车厢 id（编组 + 传入的规则/局部变量/弹链键）。 */
  function knownCarIds(extra) {
    const ids = new Set();
    for (const c of window.LiminalCarriageSpec?.CARRIAGES || []) {
      if (c?.id) ids.add(c.id);
    }
    for (const map of [extra?.rulesByCar, extra?.varsByCar, extra?.beltsByCar]) {
      if (!map || typeof map !== 'object') continue;
      for (const id of Object.keys(map)) ids.add(id);
    }
    return [...ids];
  }

  /** 是否瞬时触发（edge）；其余一律持续判定。 */
  function isEdgeTrigger(rule) {
    return rule?.trigger === 'edge';
  }

  /**
   * 按触发类型拆成两段（各自保留相对顺序）。
   * @returns {{ continuous: object[], edge: object[] }}
   */
  function splitRulesByTrigger(rules) {
    const continuous = [];
    const edge = [];
    for (const r of rules || []) {
      if (isEdgeTrigger(r)) edge.push(r);
      else continuous.push(r);
    }
    return { continuous, edge };
  }

  /** 合并两段：持续判定在前、瞬时触发在后（导出/运行时约定）。 */
  function joinRulesByTrigger(continuous, edge) {
    return [...(continuous || []), ...(edge || [])];
  }

  /** 规范化车厢规则顺序：while 段在前、edge 段在后，段内相对顺序不变。 */
  function normalizeRulesOrder(rules) {
    const { continuous, edge } = splitRulesByTrigger(rules);
    return joinRulesByTrigger(continuous, edge);
  }

  /** 迁移旧 lock_* / turret_ammo 行为、比较条件缺省 op，并浅拷贝规则结构。 */
  function migrateRule(rule, carId, belts) {
    if (!rule || typeof rule !== 'object') return null;
    const Cat = Catalog();
    const migratedCond = Cat?.migrateConditionParams
      ? Cat.migrateConditionParams(rule.condition)
      : {
          id: rule.condition?.id || 'always',
          params: { ...(rule.condition?.params || {}) },
        };
    let action = {
      id: rule.action?.id || 'noop',
      params: { ...(rule.action?.params || {}) },
    };
    if (Cat?.migrateAction) {
      action = Cat.migrateAction(action, { carId, belts });
    }
    const next = {
      id: typeof rule.id === 'string' && rule.id ? rule.id : uid(),
      trigger: rule.trigger === 'edge' ? 'edge' : 'while',
      condition: migratedCond,
      action,
      note: typeof rule.note === 'string' ? rule.note : '',
    };
    const legacyTarget = LEGACY_LOCK[next.action.id];
    if (legacyTarget) {
      next.action = { id: 'lock_unit', params: { target: legacyTarget } };
    }
    return next;
  }

  /**
   * 消毒单车程序弹链：长度=车厢 slotsPerBelt，槽位落在 allowedTypes，组数≤maxBelts。
   * @param {string} carId
   * @param {unknown} list
   * @returns {Array<{ id: string, slots: string[] }>}
   */
  function normalizeBeltsForCar(carId, list) {
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    if (!cfg?.supportsBelts) return [];
    const max = cfg.maxBelts || 4;
    const n = cfg.slotsPerBelt || 3;
    const allowed = new Set(cfg.allowedTypes || ['ap']);
    const fallback = allowed.has('ap') ? 'ap' : [...allowed][0] || 'ap';
    const out = [];
    const seen = new Set();
    if (!Array.isArray(list)) return out;
    for (const raw of list.slice(0, max)) {
      if (!raw || typeof raw !== 'object') continue;
      let id = typeof raw.id === 'string' && raw.id ? raw.id : beltUid();
      if (seen.has(id)) id = beltUid();
      seen.add(id);
      const slots = [];
      const src = Array.isArray(raw.slots) ? raw.slots : [];
      for (let i = 0; i < n; i += 1) {
        const idSlot = String(src[i] || '').toLowerCase();
        slots.push(allowed.has(idSlot) ? idSlot : fallback);
      }
      out.push({ id, slots });
    }
    return out;
  }

  /**
   * 规范化整份程序：拆分全局/局部变量、剥离退役炮塔瞄准参数、迁移旧行为、消毒程序弹链。
   * 旧扁平 vars 中的局部键会作为种子写入各车厢（无 varsByCar 时）。
   * 各车只保留该车可用的局部键（含武装车传感器键）。
   * 各已知车厢若缺少库存「着火→警报」规则则补上（不覆盖已有自定义规则）。
   */
  function normalizeProgram(data) {
    const Cat = Catalog();
    const globalDefaults = Cat?.defaultGlobalVars?.() || {};
    const unionCarDefaults = Cat?.defaultCarVars?.() || {};
    const globalKeys = Object.keys(globalDefaults);
    const unionCarKeys = Object.keys(unionCarDefaults);
    const flat = data?.vars && typeof data.vars === 'object' && !Array.isArray(data.vars)
      ? data.vars
      : {};

    const vars = {
      ...globalDefaults,
      ...pickNumberMap(flat, globalKeys),
    };

    const legacyCarSeed = pickNumberMap(flat, unionCarKeys);
    const rawByCar =
      data?.varsByCar && typeof data.varsByCar === 'object' && !Array.isArray(data.varsByCar)
        ? data.varsByCar
        : null;

    const rawRules =
      data?.rulesByCar && typeof data.rulesByCar === 'object' ? data.rulesByCar : {};
    const rawBelts =
      data?.beltsByCar && typeof data.beltsByCar === 'object' && !Array.isArray(data.beltsByCar)
        ? data.beltsByCar
        : {};

    const carIds = knownCarIds({
      rulesByCar: rawRules,
      varsByCar: rawByCar || {},
      beltsByCar: rawBelts,
    });
    const varsByCar = {};
    const rulesByCar = {};
    const beltsByCar = {};
    for (const carId of carIds) {
      const carDefaults = Cat?.defaultCarVars?.(carId) || unionCarDefaults;
      const carKeys = Object.keys(carDefaults);
      const fromFile =
        rawByCar && rawByCar[carId] && typeof rawByCar[carId] === 'object'
          ? pickNumberMap(rawByCar[carId], carKeys)
          : null;
      const seeded = fromFile || pickNumberMap(legacyCarSeed, carKeys);
      varsByCar[carId] = {
        ...carDefaults,
        ...seeded,
      };
      const belts = normalizeBeltsForCar(carId, rawBelts[carId]);
      beltsByCar[carId] = belts;
      const srcList = Array.isArray(rawRules[carId]) ? rawRules[carId] : [];
      const migrated = srcList
        .map((r) => migrateRule(r, carId, belts))
        .filter(Boolean);
      const withStock = Cat?.ensureStockRules
        ? Cat.ensureStockRules(carId, migrated)
        : migrated;
      rulesByCar[carId] = normalizeRulesOrder(
        withStock.map((r) => migrateRule(r, carId, belts)).filter(Boolean)
      );
    }

    return { vars, varsByCar, rulesByCar, beltsByCar };
  }

  /** 浅拷贝单条规则（含 condition/action.params）。 */
  function cloneRule(r) {
    return {
      ...r,
      condition: { ...r.condition, params: { ...r.condition?.params } },
      action: { ...r.action, params: { ...r.action?.params } },
    };
  }

  /** 某车厢规则（副本；已按 while→edge 规范化）。 */
  function getRules(carId) {
    const list = state.rulesByCar[carId];
    return Array.isArray(list) ? list.map(cloneRule) : [];
  }

  /**
   * 某车厢按触发类型拆分的规则副本（控制台两段列表 / 运行时调度用）。
   * @returns {{ continuous: object[], edge: object[] }}
   */
  function getRulesByTrigger(carId) {
    return splitRulesByTrigger(getRules(carId));
  }

  /**
   * 运行时读取约定：continuous 按数组顺序做优先级；edge 全部边沿触发、无顺序竞争。
   * @returns {{ continuous: object[], edge: object[] }}
   */
  function rulesForRuntime(carId) {
    return getRulesByTrigger(carId);
  }

  /** 写回某车厢规则并持久化（自动 while 段在前、edge 段在后）。 */
  function setRules(carId, rules) {
    state.rulesByCar[carId] = normalizeRulesOrder(rules.slice());
    save();
  }

  /**
   * 在同一触发段内上/下移一条规则；跨段不会换位。
   * while 段移动改变优先级；edge 段移动仅改显示顺序。
   * @param {string} carId
   * @param {string} ruleId
   * @param {-1|1} delta -1 上移 / 1 下移
   * @returns {boolean} 是否发生了移动
   */
  function moveRuleInSection(carId, ruleId, delta) {
    const { continuous, edge } = splitRulesByTrigger(getRules(carId));
    const inEdge = edge.some((r) => r.id === ruleId);
    const section = inEdge ? edge : continuous;
    const i = section.findIndex((r) => r.id === ruleId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= section.length) return false;
    [section[i], section[j]] = [section[j], section[i]];
    setRules(carId, joinRulesByTrigger(continuous, edge));
    return true;
  }

  /**
   * 新增或覆盖一条规则：写入对应触发段；改 trigger 时迁到新段末（或原段原位）。
   * @param {'add'|'edit'} mode
   */
  function upsertRule(carId, rule, mode) {
    const next = cloneRule(rule);
    next.trigger = next.trigger === 'edge' ? 'edge' : 'while';
    const { continuous, edge } = splitRulesByTrigger(getRules(carId));
    const wasEdgeIdx = edge.findIndex((r) => r.id === next.id);
    const wasContIdx = continuous.findIndex((r) => r.id === next.id);
    const without = (list) => list.filter((r) => r.id !== next.id);
    let cont = without(continuous);
    let edg = without(edge);
    if (next.trigger === 'edge') {
      const idx = mode === 'edit' && wasEdgeIdx >= 0 ? wasEdgeIdx : edg.length;
      edg.splice(Math.min(idx, edg.length), 0, next);
    } else {
      const idx = mode === 'edit' && wasContIdx >= 0 ? wasContIdx : cont.length;
      cont.splice(Math.min(idx, cont.length), 0, next);
    }
    setRules(carId, joinRulesByTrigger(cont, edg));
  }

  /** 删除一条规则。 */
  function removeRule(carId, ruleId) {
    setRules(
      carId,
      getRules(carId).filter((r) => r.id !== ruleId)
    );
  }

  /** 全局变量副本。 */
  function getGlobalVars() {
    return { ...state.vars };
  }

  /** 覆盖全局变量并持久化。 */
  function setGlobalVars(vars) {
    const defaults = Catalog()?.defaultGlobalVars?.() || {};
    state.vars = {
      ...defaults,
      ...pickNumberMap(vars, Object.keys(defaults)),
    };
    save();
  }

  /**
   * 确保某车厢局部表存在，并补齐该车目录默认键（不删多余旧键以外的未知键）。
   * @returns {Record<string, number>}
   */
  function ensureCarVars(carId) {
    const Cat = Catalog();
    const defaults = Cat?.defaultCarVars?.(carId) || {};
    if (!carId) return { ...defaults };
    const prev = state.varsByCar[carId];
    if (!prev || typeof prev !== 'object') {
      state.varsByCar[carId] = { ...defaults };
      return state.varsByCar[carId];
    }
    const next = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (prev[key] !== undefined && prev[key] !== null && prev[key] !== '') {
        next[key] = Number(prev[key]) || 0;
      }
    }
    state.varsByCar[carId] = next;
    return state.varsByCar[carId];
  }

  /** 某车厢局部变量副本；首次访问时用该车目录默认值建表。 */
  function getCarVars(carId) {
    if (!carId) return { ...(Catalog()?.defaultCarVars?.() || {}) };
    return { ...ensureCarVars(carId) };
  }

  /**
   * 覆盖某车厢局部变量并持久化。
   * 只接受玩家可写键；只读传感器键保留内存中的现有值。
   */
  function setCarVars(carId, vars) {
    if (!carId) return;
    const Cat = Catalog();
    const defaults = Cat?.defaultCarVars?.(carId) || {};
    const prev = ensureCarVars(carId);
    const writable =
      Cat?.writableCarVarNames?.(carId) ||
      Object.keys(defaults).filter((n) => !Cat?.isReadonlyVar?.(n));
    const next = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (Cat?.isReadonlyVar?.(key)) {
        next[key] = Number(prev[key]) || 0;
        continue;
      }
      if (vars && Object.prototype.hasOwnProperty.call(vars, key)) {
        next[key] = Number(vars[key]) || 0;
      } else {
        next[key] = Number(prev[key]) || 0;
      }
    }
    /* 额外保险：只从 vars 吸收可写键 */
    Object.assign(next, pickNumberMap(vars, writable));
    for (const key of Cat?.sensorCarVarNames?.(carId) || []) {
      next[key] = Number(prev[key]) || 0;
    }
    state.varsByCar[carId] = next;
    save();
  }

  /**
   * 运行时写入只读传感器局部变量（不持久化，避免每帧刷 localStorage）。
   * @param {string} carId
   * @param {Record<string, number>} sensorMap
   */
  function applySensorVars(carId, sensorMap) {
    if (!carId || !sensorMap || typeof sensorMap !== 'object') return;
    const Cat = Catalog();
    const table = ensureCarVars(carId);
    let changed = false;
    for (const [name, raw] of Object.entries(sensorMap)) {
      const def = Cat?.varDefByName?.(name);
      if (!def?.readonly) continue;
      if (!Cat?.varDefAppliesToCar?.(def, carId)) continue;
      const value = Number(raw) || 0;
      if (table[name] !== value) {
        table[name] = value;
        changed = true;
      }
    }
    if (changed) {
      state.varsByCar[carId] = { ...table };
      window.LpAutoConsole?.refreshSensorVars?.(carId);
    }
  }

  /**
   * 兼容旧 API：返回「全局 + 当前无车厢上下文的局部默认」扁平表。
   * 控制台请改用 getGlobalVars / getCarVars。
   */
  function getVars() {
    return {
      ...getGlobalVars(),
      ...(Catalog()?.defaultCarVars?.() || {}),
    };
  }

  /** 兼容旧 API：仅写入全局键（局部键忽略）。 */
  function setVars(vars) {
    setGlobalVars(vars);
  }

  /** 向导变量名列表（全局 + 当前车厢局部；opts 透传 catalog）。 */
  function listVarNames(carId, opts) {
    const Cat = Catalog();
    if (Cat?.varNamesForPicker) return Cat.varNamesForPicker(carId, opts);
    return Object.keys(getVars());
  }

  /** 新建空规则草稿（未写入前）；条件/行为默认取当前车厢可用项。 */
  function createBlankRule(carId) {
    const Cat = Catalog();
    const conds = Cat.conditionsForCar(carId);
    const cond = conds[0] || Cat.CONDITIONS[Cat.CONDITIONS.length - 1];
    const acts = Cat.actionsForCar(carId);
    const act = acts[0] || Cat.ACTIONS[Cat.ACTIONS.length - 1];
    return {
      id: uid(),
      trigger: 'while',
      condition: {
        id: cond.id,
        params: Cat.defaultParams(cond.params),
      },
      action: {
        id: act.id,
        params: Cat.defaultParams(act.params),
      },
      note: '',
    };
  }

  /** 深拷贝当前程序核心字段（撤销导入用）。 */
  function cloneProgramState(src) {
    return {
      vars: JSON.parse(JSON.stringify(src.vars || {})),
      varsByCar: JSON.parse(JSON.stringify(src.varsByCar || {})),
      rulesByCar: JSON.parse(JSON.stringify(src.rulesByCar || {})),
      beltsByCar: JSON.parse(JSON.stringify(src.beltsByCar || {})),
    };
  }

  /** 覆盖导入前快照当前程序；再次导入会替换旧快照。 */
  function takeUndoSnapshot() {
    undoSnapshot = {
      ...cloneProgramState(state),
      at: Date.now(),
    };
  }

  /** 清除覆盖导入撤销快照。 */
  function clearUndoSnapshot() {
    undoSnapshot = null;
  }

  /** 是否有可撤销的覆盖导入快照。 */
  function hasUndoSnapshot() {
    return !!undoSnapshot;
  }

  /**
   * 撤销最近一次整份程序覆盖导入，恢复快照中的 vars / varsByCar / rulesByCar / beltsByCar。
   * @returns {{ ok: true } | { ok: false, error: string }}
   */
  function undoLastImport() {
    if (!undoSnapshot) {
      return { ok: false, error: '没有可撤销的导入。' };
    }
    state = normalizeProgram(cloneProgramState(undoSnapshot));
    clearUndoSnapshot();
    save();
    return { ok: true };
  }

  /**
   * 某车厢程序弹链副本（仅 supportsBelts 车厢有数据）。
   * @param {string} carId
   * @returns {Array<{ id: string, slots: string[] }>}
   */
  function getBelts(carId) {
    if (!carId) return [];
    const list = state.beltsByCar[carId];
    return Array.isArray(list)
      ? list.map((b) => ({ id: b.id, slots: (b.slots || []).slice() }))
      : [];
  }

  /**
   * 覆盖某车厢程序弹链并持久化（按车厢能力消毒）。
   * @param {string} carId
   * @param {Array<{ id?: string, slots?: string[] }>} belts
   */
  function setBelts(carId, belts) {
    if (!carId) return;
    if (!state.beltsByCar) state.beltsByCar = {};
    state.beltsByCar[carId] = normalizeBeltsForCar(carId, belts);
    save();
  }

  /**
   * 按 id 取一条程序弹链；不存在返回 null。
   * @param {string} carId
   * @param {string} beltId
   */
  function getBelt(carId, beltId) {
    return getBelts(carId).find((b) => b.id === beltId) || null;
  }

  /**
   * 添加一组程序弹链（不超过车厢 maxBelts）；返回新组或 null。
   * @param {string} carId
   */
  function addBelt(carId) {
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    if (!cfg?.supportsBelts) return null;
    const list = getBelts(carId);
    if (list.length >= (cfg.maxBelts || 4)) return null;
    const t0 = (cfg.allowedTypes && cfg.allowedTypes[0]) || 'ap';
    const slots = (cfg.defaultSlots || Array(cfg.slotsPerBelt || 3).fill(t0)).slice(
      0,
      cfg.slotsPerBelt || 3
    );
    while (slots.length < (cfg.slotsPerBelt || 3)) slots.push(t0);
    const next = { id: beltUid(), slots };
    list.push(next);
    setBelts(carId, list);
    return next;
  }

  /**
   * 删除一组程序弹链（可删至 0 组）。
   * @param {string} carId
   * @param {string} beltId
   */
  function removeBelt(carId, beltId) {
    setBelts(
      carId,
      getBelts(carId).filter((b) => b.id !== beltId)
    );
    return true;
  }

  /**
   * 设置程序弹链某槽弹种。
   * @param {string} carId
   * @param {string} beltId
   * @param {number} slotIndex
   * @param {string} ammoId
   */
  function setBeltSlot(carId, beltId, slotIndex, ammoId) {
    const Ammo = window.LpArmedAmmo;
    const cfg = Ammo?.getCarriage?.(carId);
    if (!cfg?.supportsBelts) return false;
    const list = getBelts(carId);
    const belt = list.find((b) => b.id === beltId);
    if (!belt) return false;
    if (slotIndex < 0 || slotIndex >= (cfg.slotsPerBelt || 3)) return false;
    const id = String(ammoId || '').toLowerCase();
    if (!(cfg.allowedTypes || []).includes(id)) return false;
    belt.slots[slotIndex] = id;
    setBelts(carId, list);
    return true;
  }

  /** 导出整份程序对象（分享 / 备份）。 */
  function exportJson() {
    return {
      kind: SHARE_KIND,
      version: SHARE_VERSION,
      _comment:
        '枢机自动化 v3：vars=全局；varsByCar=车厢局部；beltsByCar=可选遗留程序弹链库；rulesByCar 仍为一数组（while→edge）。select_ammo：params.target=type:ap|belt，弹链模式另带 params.slots[]（嵌入规则，无需手输 belt id）。旧 belt:pb_… / turret_ammo 导入时自动迁移。',
      vars: getGlobalVars(),
      varsByCar: { ...state.varsByCar },
      beltsByCar: { ...(state.beltsByCar || {}) },
      rulesByCar: { ...state.rulesByCar },
    };
  }

  /** 导出可粘贴到聊天的纯文本 JSON。 */
  function toShareText() {
    return JSON.stringify(exportJson(), null, 2);
  }

  /**
   * 导出单条规则分享对象（不包含变量 / 其它车厢）。
   * @param {string} carId 规则所属车厢（写入包内，导入时优先用当前选中车厢）
   * @param {object} rule
   */
  function exportRuleJson(carId, rule) {
    const belts = getBelts(carId);
    const migrated = migrateRule(rule, carId, belts);
    return {
      kind: SHARE_RULE_KIND,
      version: SHARE_RULE_VERSION,
      _comment:
        '单条枢机自动化规则。导入时追加到当前选中车厢的对应触发段，不会覆盖整份程序。',
      carId: typeof carId === 'string' ? carId : '',
      rule: migrated,
    };
  }

  /** 单条规则纯文本 JSON（行内「复制」用）。 */
  function toRuleShareText(carId, rule) {
    return JSON.stringify(exportRuleJson(carId, rule), null, 2);
  }

  /**
   * 校验单条规则分享包。
   * @returns {{ ok: true, data: object } | { ok: false, error: string }}
   */
  function validateRuleShare(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '格式错误：根节点必须是对象。' };
    }
    if (data.kind !== SHARE_RULE_KIND) {
      return { ok: false, error: `不是单条规则包（kind 应为 ${SHARE_RULE_KIND}）。` };
    }
    const r = data.rule;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, error: '格式错误：缺少 rule 对象。' };
    }
    if (!r.condition?.id || !r.action?.id) {
      return { ok: false, error: '规则缺少 condition.id 或 action.id。' };
    }
    return { ok: true, data };
  }

  /**
   * 校验程序对象结构。
   * @returns {{ ok: true, data: object } | { ok: false, error: string }}
   */
  function validateProgram(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '格式错误：根节点必须是对象。' };
    }
    if (data.kind === SHARE_RULE_KIND) {
      return {
        ok: false,
        error: `这是单条规则包（${SHARE_RULE_KIND}），请用导入入口识别 kind 后追加，勿当整份程序覆盖。`,
      };
    }
    if (data.kind != null && data.kind !== SHARE_KIND) {
      return { ok: false, error: `不是枢机自动化程序（kind 应为 ${SHARE_KIND}）。` };
    }
    if (data.vars != null && (typeof data.vars !== 'object' || Array.isArray(data.vars))) {
      return { ok: false, error: '格式错误：vars 必须是对象。' };
    }
    if (
      data.varsByCar != null &&
      (typeof data.varsByCar !== 'object' || Array.isArray(data.varsByCar))
    ) {
      return { ok: false, error: '格式错误：varsByCar 必须是对象。' };
    }
    if (
      data.rulesByCar != null &&
      (typeof data.rulesByCar !== 'object' || Array.isArray(data.rulesByCar))
    ) {
      return { ok: false, error: '格式错误：rulesByCar 必须是对象。' };
    }
    if (
      data.beltsByCar != null &&
      (typeof data.beltsByCar !== 'object' || Array.isArray(data.beltsByCar))
    ) {
      return { ok: false, error: '格式错误：beltsByCar 必须是对象。' };
    }
    if (
      data.vars == null &&
      data.varsByCar == null &&
      data.rulesByCar == null &&
      data.beltsByCar == null
    ) {
      return { ok: false, error: '缺少 vars / varsByCar / rulesByCar / beltsByCar，无法导入。' };
    }
    for (const [carId, list] of Object.entries(data.rulesByCar || {})) {
      if (!Array.isArray(list)) {
        return { ok: false, error: `车厢「${carId}」的规则必须是数组。` };
      }
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i];
        if (!r || typeof r !== 'object') {
          return { ok: false, error: `车厢「${carId}」第 ${i + 1} 条规则无效。` };
        }
        if (!r.condition?.id || !r.action?.id) {
          return {
            ok: false,
            error: `车厢「${carId}」第 ${i + 1} 条缺少 condition.id 或 action.id。`,
          };
        }
      }
    }
    for (const [carId, map] of Object.entries(data.varsByCar || {})) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) {
        return { ok: false, error: `车厢「${carId}」的局部变量必须是对象。` };
      }
    }
    for (const [carId, list] of Object.entries(data.beltsByCar || {})) {
      if (!Array.isArray(list)) {
        return { ok: false, error: `车厢「${carId}」的程序弹链必须是数组。` };
      }
    }
    return { ok: true, data };
  }

  /**
   * 解析剪贴板 JSON，按 kind 分支为整份程序或单条规则。
   * @returns {{ ok: true, kind: 'program'|'rule', data: object } | { ok: false, error: string }}
   */
  function parseSharePayload(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, error: '剪贴板为空，请先复制程序或规则文本。' };
    }
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      return {
        ok: false,
        error: '不是合法 JSON。请粘贴「复制到剪贴板」或行内「复制」得到的文本。',
      };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: '格式错误：根节点必须是对象。' };
    }
    if (data.kind === SHARE_RULE_KIND) {
      const checked = validateRuleShare(data);
      if (!checked.ok) return checked;
      return { ok: true, kind: 'rule', data: checked.data };
    }
    const checked = validateProgram(data);
    if (!checked.ok) return checked;
    return { ok: true, kind: 'program', data: checked.data };
  }

  /**
   * 校验并解析剪贴板/粘贴文本（仅整份程序；兼容旧调用）。
   * @returns {{ ok: true, data: object } | { ok: false, error: string }}
   */
  function parseShareText(raw) {
    const parsed = parseSharePayload(raw);
    if (!parsed.ok) return parsed;
    if (parsed.kind !== 'program') {
      return {
        ok: false,
        error: `这是单条规则包（${SHARE_RULE_KIND}），导入时会追加到当前车厢，不会覆盖整份程序。`,
      };
    }
    return { ok: true, data: parsed.data };
  }

  /**
   * 从对象导入并覆盖当前程序（先快照以便撤销）。
   * @returns {{ ok: true, mode: 'replace' } | { ok: false, error: string }}
   */
  function importJson(data) {
    const parsed = validateProgram(data);
    if (!parsed.ok) return parsed;
    takeUndoSnapshot();
    state = normalizeProgram(parsed.data);
    save();
    return { ok: true, mode: 'replace' };
  }

  /**
   * 将单条规则追加到目标车厢对应触发段末尾（新 id，不碰变量与其它规则）。
   * @param {object} share 已通过 validateRuleShare 的包
   * @param {string} targetCarId 当前选中车厢（优先于包内 carId）
   * @returns {{ ok: true, mode: 'append', carId: string, ruleId: string } | { ok: false, error: string }}
   */
  function appendRuleFromShare(share, targetCarId) {
    const checked = validateRuleShare(share);
    if (!checked.ok) return checked;
    const carId =
      (typeof targetCarId === 'string' && targetCarId) ||
      (typeof checked.data.carId === 'string' && checked.data.carId) ||
      '';
    if (!carId) {
      return { ok: false, error: '无法追加规则：未指定车厢。请先在控制台选中一节车厢。' };
    }
    const next = migrateRule(checked.data.rule, carId, getBelts(carId));
    next.id = uid();
    upsertRule(carId, next, 'add');
    return { ok: true, mode: 'append', carId, ruleId: next.id };
  }

  /**
   * 从纯文本导入：整份程序则覆盖（可撤销）；单条规则则追加到 targetCarId。
   * @param {string} raw
   * @param {{ targetCarId?: string }} [opts]
   * @returns {{ ok: true, mode: 'replace'|'append', carId?: string, ruleId?: string } | { ok: false, error: string }}
   */
  function importShareText(raw, opts) {
    const parsed = parseSharePayload(raw);
    if (!parsed.ok) return parsed;
    if (parsed.kind === 'rule') {
      return appendRuleFromShare(parsed.data, opts?.targetCarId);
    }
    return importJson(parsed.data);
  }

  window.LpAutoProgram = {
    SHARE_KIND,
    SHARE_RULE_KIND,
    SHARE_VERSION,
    SHARE_RULE_VERSION,
    getRules,
    setRules,
    getRulesByTrigger,
    rulesForRuntime,
    moveRuleInSection,
    upsertRule,
    removeRule,
    splitRulesByTrigger,
    normalizeRulesOrder,
    getBelts,
    setBelts,
    getBelt,
    addBelt,
    removeBelt,
    setBeltSlot,
    getVars,
    setVars,
    getGlobalVars,
    setGlobalVars,
    getCarVars,
    setCarVars,
    applySensorVars,
    listVarNames,
    createBlankRule,
    exportJson,
    toShareText,
    exportRuleJson,
    toRuleShareText,
    parseShareText,
    parseSharePayload,
    validateRuleShare,
    importJson,
    importShareText,
    appendRuleFromShare,
    takeUndoSnapshot,
    clearUndoSnapshot,
    hasUndoSnapshot,
    undoLastImport,
    save,
  };
})();
