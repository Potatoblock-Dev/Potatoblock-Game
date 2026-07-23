/**
 * 枢机车厢全屏自动化控制台：横滑选车厢 → 持续判定 / 瞬时触发两段规则 → 分步编辑。
 * 持续判定段内上→下为优先级；瞬时触发段内换行仅美观、无优先级。
 * 支持整份程序 / 单条规则复制到剪贴板；导入按 kind 覆盖或追加。
 * 整份覆盖导入后可「撤销导入」恢复快照（约 25s 或下次编辑前）。
 * UI 参考 Pixel Starships 船员/房间自动化行表。
 */
(() => {
  const root = document.getElementById('lpAutoConsoleRoot');
  const trainStrip = document.getElementById('lpAutoTrainStrip');
  const rulesList = document.getElementById('lpAutoRulesList');
  const carTitle = document.getElementById('lpAutoCarTitle');
  const varsBox = document.getElementById('lpAutoVarsBox');
  const wizard = document.getElementById('lpAutoWizard');
  const pasteDialog = document.getElementById('lpAutoPasteDialog');
  const pasteTextarea = document.getElementById('lpAutoPasteText');
  const pasteError = document.getElementById('lpAutoPasteError');
  const undoBanner = document.getElementById('lpAutoUndoBanner');
  const closeBtn = document.getElementById('lpAutoConsoleClose');
  if (!root || !trainStrip || !rulesList) return;

  const Spec = () => window.LiminalCarriageSpec;
  const Cat = () => window.LpAutoProgramCatalog;
  const Prog = () => window.LpAutoProgram;

  /** 覆盖导入后「撤销导入」横幅可见时长（毫秒）。 */
  const UNDO_BANNER_MS = 25000;

  let open = false;
  let selectedCarId = null;
  /** @type {null | { mode:'add'|'edit', rule: object, step: number }} */
  let editor = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let undoBannerTimer = null;

  function isOpen() {
    return open;
  }

  function openPanel() {
    if (open) return;
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-auto-console-open');
    const cars = Spec()?.CARRIAGES || [];
    if (!selectedCarId && cars.length) {
      selectedCarId = cars.find((c) => c.id === 'shuji')?.id || cars[0].id;
    }
    renderAll();
    if (Prog()?.hasUndoSnapshot?.()) showUndoBanner();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    editor = null;
    hidePasteDialog();
    hideUndoBanner({ clearSnapshot: false });
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-auto-console-open');
    wizard.hidden = true;
  }

  /** 控制台内短提示（优先画布 toast，否则 alert）。 */
  function notify(text) {
    if (window.LiminalInteract?.showToast) {
      window.LiminalInteract.showToast(text);
      return;
    }
    alert(text);
  }

  /**
   * 隐藏撤销横幅；可选同时丢弃程序快照。
   * @param {{ clearSnapshot?: boolean }} [opts]
   */
  function hideUndoBanner(opts) {
    if (undoBannerTimer) {
      clearTimeout(undoBannerTimer);
      undoBannerTimer = null;
    }
    if (undoBanner) undoBanner.hidden = true;
    if (opts?.clearSnapshot) Prog()?.clearUndoSnapshot?.();
  }

  /** 整份覆盖导入成功后展示「撤销导入」横幅（再次导入会替换快照并重置计时）。 */
  function showUndoBanner() {
    if (!undoBanner || !Prog()?.hasUndoSnapshot?.()) return;
    undoBanner.hidden = false;
    if (undoBannerTimer) clearTimeout(undoBannerTimer);
    undoBannerTimer = setTimeout(() => {
      hideUndoBanner({ clearSnapshot: true });
    }, UNDO_BANNER_MS);
  }

  /** 玩家改动程序后丢弃覆盖导入撤销机会。 */
  function discardImportUndo() {
    if (!Prog()?.hasUndoSnapshot?.()) {
      hideUndoBanner({ clearSnapshot: false });
      return;
    }
    hideUndoBanner({ clearSnapshot: true });
  }

  /** 执行撤销覆盖导入并刷新界面。 */
  function undoImportOverwrite() {
    const result = Prog().undoLastImport?.();
    hideUndoBanner({ clearSnapshot: false });
    if (!result?.ok) {
      notify(result?.error || '撤销失败');
      return;
    }
    renderAll();
    notify('已撤销导入');
  }

  function renderAll() {
    renderTrain();
    renderVars();
    renderRules();
  }

  function renderTrain() {
    const cars = Spec()?.CARRIAGES || [];
    trainStrip.innerHTML = '';
    for (const car of cars) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lp-auto-car-card';
      if (car.id === selectedCarId) btn.classList.add('is-selected');
      btn.dataset.carId = car.id;
      const icon = car.icon
        ? `<img src="${car.icon}" alt="" class="lp-auto-car-icon" draggable="false">`
        : '';
      const short = car.map?.shortLabel || car.label || car.id;
      btn.innerHTML = `${icon}<span class="lp-auto-car-name">${short}</span><span class="lp-auto-car-full">${car.label || ''}</span>`;
      btn.addEventListener('click', () => {
        selectedCarId = car.id;
        editor = null;
        wizard.hidden = true;
        renderAll();
      });
      trainStrip.appendChild(btn);
    }
    const car = cars.find((c) => c.id === selectedCarId);
    if (carTitle) {
      carTitle.textContent = car
        ? `编程 · ${car.label || car.id}`
        : '选择车厢';
    }
  }

  /** 渲染一块变量表（全局或当前车厢局部）。 */
  function appendVarBlock(parent, title, scope, vars) {
    const block = document.createElement('div');
    block.className = 'lp-auto-vars-block';
    const heading = document.createElement('h4');
    heading.textContent = title;
    block.appendChild(heading);
    const list = document.createElement('div');
    list.className = 'lp-auto-vars-list';
    for (const [name, value] of Object.entries(vars)) {
      const row = document.createElement('label');
      const readonly = scope === 'car' && Cat()?.isReadonlyVar?.(name);
      row.className = `lp-auto-var-row${readonly ? ' is-readonly' : ''}`;
      const roAttr = readonly ? ' readonly tabindex="-1" title="运行时传感器，不可编辑"' : '';
      row.innerHTML = `<span>${name}${readonly ? ' · 传感' : ''}</span><input type="number" data-scope="${scope}" data-var="${name}" value="${value}"${roAttr}>`;
      list.appendChild(row);
    }
    if (!Object.keys(vars).length) {
      const empty = document.createElement('p');
      empty.className = 'lp-auto-empty';
      empty.textContent = scope === 'car' && !selectedCarId ? '先选择车厢' : '无';
      list.appendChild(empty);
    }
    block.appendChild(list);
    parent.appendChild(block);
  }

  /** 刷新左侧全局 / 车厢局部两块变量；换车厢时随 renderAll 更新局部值。 */
  function renderVars() {
    if (!varsBox) return;
    varsBox.innerHTML = '';
    const globalVars = Prog().getGlobalVars?.() || Prog().getVars();
    appendVarBlock(varsBox, '全局变量', 'global', globalVars);

    const car = (Spec()?.CARRIAGES || []).find((c) => c.id === selectedCarId);
    const carTitle = car
      ? `车厢局部变量 · ${car.map?.shortLabel || car.label || car.id}`
      : '车厢局部变量';
    const carVars = selectedCarId
      ? Prog().getCarVars?.(selectedCarId) || {}
      : {};
    appendVarBlock(varsBox, carTitle, 'car', carVars);

    varsBox.querySelectorAll('input[data-var]:not([readonly])').forEach((input) => {
      input.addEventListener('change', () => {
        const name = input.getAttribute('data-var');
        const scope = input.getAttribute('data-scope');
        if (Cat()?.isReadonlyVar?.(name)) return;
        const value = Number(input.value) || 0;
        if (scope === 'car' && selectedCarId && Prog().setCarVars) {
          const next = Prog().getCarVars(selectedCarId);
          next[name] = value;
          Prog().setCarVars(selectedCarId, next);
          discardImportUndo();
          return;
        }
        const next = Prog().getGlobalVars?.() || Prog().getVars();
        next[name] = value;
        if (Prog().setGlobalVars) Prog().setGlobalVars(next);
        else Prog().setVars(next);
        discardImportUndo();
      });
    });
  }

  /**
   * 传感器写入后刷新只读行显示（控制台打开且仍选中该车时）。
   * @param {string} [carId]
   */
  function refreshSensorVars(carId) {
    if (!open || !varsBox) return;
    if (carId && selectedCarId && carId !== selectedCarId) return;
    const carVars = selectedCarId ? Prog().getCarVars?.(selectedCarId) || {} : {};
    varsBox.querySelectorAll('input[data-scope="car"][readonly]').forEach((input) => {
      const name = input.getAttribute('data-var');
      if (name && Object.prototype.hasOwnProperty.call(carVars, name)) {
        input.value = String(carVars[name]);
      }
    });
  }

  /**
   * 渲染一段规则区（持续判定 / 瞬时触发）。
   * @param {{ title:string, hint:string, rules:object[], priority:boolean }} section
   */
  function appendRuleSection(section) {
    const wrap = document.createElement('section');
    wrap.className = `lp-auto-rule-section${section.priority ? ' is-priority' : ' is-cosmetic'}`;
    wrap.innerHTML = `
      <header class="lp-auto-rule-section-head">
        <h4 class="lp-auto-rule-section-title">${section.title}</h4>
        <p class="lp-auto-rule-section-hint">${section.hint}</p>
      </header>
      <div class="lp-auto-rule-section-body"></div>
    `;
    const body = wrap.querySelector('.lp-auto-rule-section-body');
    if (!section.rules.length) {
      const empty = document.createElement('p');
      empty.className = 'lp-auto-empty';
      empty.textContent = '本段暂无规则';
      body.appendChild(empty);
    } else {
      section.rules.forEach((rule, index) => {
        body.appendChild(buildRuleRow(rule, index, section.priority));
      });
    }
    rulesList.appendChild(wrap);
  }

  /**
   * 构建单条规则行；priority=true 时 #n 与 ↑↓ 表示优先级，否则仅美观换行。
   * @param {object} rule
   * @param {number} index
   * @param {boolean} priority
   */
  function buildRuleRow(rule, index, priority) {
    const row = document.createElement('div');
    row.className = `lp-auto-rule-row${priority ? '' : ' is-edge'}`;
    row.dataset.ruleId = rule.id;
    const summary = Cat().summarizeRule(rule);
    const prioTitle = priority ? '优先级（数字越小越高）' : '显示序号（无优先级）';
    const prioHtml = priority
      ? `<span class="lp-auto-prio" title="${prioTitle}">#${index + 1}</span>`
      : `<span class="lp-auto-prio is-cosmetic" title="${prioTitle}">·</span>`;
    const upTitle = priority ? '上移（提高优先级）' : '上移（仅美观，无优先级）';
    const downTitle = priority ? '下移（降低优先级）' : '下移（仅美观，无优先级）';
    row.innerHTML = `
      ${prioHtml}
      <button type="button" class="lp-auto-rule-summary" data-act="edit">${summary}</button>
      <div class="lp-auto-rule-tools">
        <button type="button" data-act="up" title="${upTitle}">↑</button>
        <button type="button" data-act="down" title="${downTitle}">↓</button>
        <button type="button" data-act="copy" title="复制本条规则">复制</button>
        <button type="button" data-act="edit" title="编辑">✎</button>
        <button type="button" data-act="del" title="删除">×</button>
      </div>
    `;
    row.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'del') {
        if (Prog().removeRule) Prog().removeRule(selectedCarId, rule.id);
        else {
          Prog().setRules(
            selectedCarId,
            Prog().getRules(selectedCarId).filter((r) => r.id !== rule.id)
          );
        }
        discardImportUndo();
        renderRules();
      } else if (act === 'up') {
        if (Prog().moveRuleInSection(selectedCarId, rule.id, -1)) discardImportUndo();
        renderRules();
      } else if (act === 'down') {
        if (Prog().moveRuleInSection(selectedCarId, rule.id, 1)) discardImportUndo();
        renderRules();
      } else if (act === 'copy') {
        copyRuleToClipboard(rule);
      } else if (act === 'edit') {
        const list = Prog().getRules(selectedCarId);
        const found = list.find((r) => r.id === rule.id);
        if (found) openWizard('edit', found);
      }
    });
    return row;
  }

  /** 分两段渲染持续判定（有优先级）与瞬时触发（无优先级）。 */
  function renderRules() {
    rulesList.innerHTML = '';
    if (!selectedCarId) {
      rulesList.innerHTML = '<p class="lp-auto-empty">先在上方选择一节车厢</p>';
      return;
    }
    const split =
      Prog().getRulesByTrigger?.(selectedCarId) ||
      Prog().splitRulesByTrigger?.(Prog().getRules(selectedCarId)) || {
        continuous: Prog().getRules(selectedCarId).filter((r) => r.trigger !== 'edge'),
        edge: Prog().getRules(selectedCarId).filter((r) => r.trigger === 'edge'),
      };
    if (!split.continuous.length && !split.edge.length) {
      rulesList.innerHTML =
        '<p class="lp-auto-empty">尚无规则。点击「添加规则」。持续判定段内越靠上优先级越高；瞬时触发无优先级。</p>';
      return;
    }
    appendRuleSection({
      title: '持续判定',
      hint: '列表越靠上优先级越高（约每帧检查）。',
      rules: split.continuous,
      priority: true,
    });
    appendRuleSection({
      title: '瞬时触发',
      hint: '换行 / 顺序仅美观，无优先级（边沿触发时各自独立执行）。',
      rules: split.edge,
      priority: false,
    });
  }

  /** 分步向导：触发 → 条件（参数内联同行）→ 行为（参数内联同行）。 */
  function openWizard(mode, rule) {
    editor = {
      mode,
      rule: JSON.parse(JSON.stringify(rule)),
      step: 0,
    };
    wizard.hidden = false;
    paintWizard();
  }

  /**
   * 是否仍需独立参数步。当前全部 param 类型均可在选项行内联编辑，故恒为假。
   * @param {Array<object>|undefined} _schema
   */
  function schemaNeedsParamStep(_schema) {
    return false;
  }

  function wizardSteps() {
    const steps = [{ id: 'trigger', label: '1 · 触发模式' }, { id: 'cond', label: '2 · 选择条件' }];
    steps.push({ id: 'action', label: `${steps.length + 1} · 选择行为` });
    return steps;
  }

  function paintWizard() {
    if (!editor) return;
    const steps = wizardSteps();
    if (editor.step >= steps.length) editor.step = steps.length - 1;
    if (editor.step < 0) editor.step = 0;
    const step = steps[editor.step];
    const rule = editor.rule;
    const body = wizard.querySelector('[data-role="body"]');
    const title = wizard.querySelector('[data-role="title"]');
    const dots = wizard.querySelector('[data-role="steps"]');
    title.textContent = step.label;
    dots.innerHTML = steps
      .map(
        (s, i) =>
          `<span class="lp-auto-step-dot${i === editor.step ? ' is-on' : ''}">${i + 1}</span>`
      )
      .join('');

    if (step.id === 'trigger') {
      body.innerHTML = Cat()
        .TRIGGERS.map(
          (t) => `
        <label class="lp-auto-choice">
          <input type="radio" name="lpAutoTrig" value="${t.id}" ${rule.trigger === t.id ? 'checked' : ''}>
          <span><strong>${t.label}</strong><small>${t.hint || ''}</small></span>
        </label>`
        )
        .join('');
      body.querySelectorAll('input[name="lpAutoTrig"]').forEach((el) => {
        el.addEventListener('change', () => {
          rule.trigger = el.value;
        });
      });
    } else if (step.id === 'cond') {
      const conds = Cat().conditionsForCar(selectedCarId);
      if (!conds.some((c) => c.id === rule.condition.id)) {
        rule.condition = { id: conds[0].id, params: Cat().defaultParams(conds[0].params) };
      }
      body.innerHTML = conds
        .map((c) => {
          const values =
            rule.condition.id === c.id
              ? rule.condition.params
              : Cat().defaultParams(c.params);
          return renderChoiceRow({
            name: 'lpAutoCond',
            value: c.id,
            selected: rule.condition.id === c.id,
            label: c.label,
            hint: c.hint,
            schema: c.params,
            values,
            paramPrefix: 'cond',
          });
        })
        .join('');
      const selectCond = (id, row) => {
        const c = Cat().conditionById(id);
        rule.condition = { id: c.id, params: Cat().defaultParams(c.params) };
        syncInlineParamsFromRow(row, rule.condition.params);
      };
      bindChoiceRadios(body, 'lpAutoCond', selectCond);
      bindChoiceInlineParams(body, 'lpAutoCond', () => rule.condition.params, selectCond);
    } else if (step.id === 'condParams') {
      body.innerHTML = renderParamForm(
        Cat().conditionById(rule.condition.id)?.params,
        rule.condition.params,
        'cond'
      );
      bindParamForm(body, rule.condition.params);
    } else if (step.id === 'action') {
      const acts = Cat().actionsForCar(selectedCarId);
      if (!acts.some((a) => a.id === rule.action.id)) {
        rule.action = { id: acts[0].id, params: Cat().defaultParams(acts[0].params) };
      }
      body.innerHTML = acts
        .map((a) => {
          const values =
            rule.action.id === a.id ? rule.action.params : Cat().defaultParams(a.params);
          return renderChoiceRow({
            name: 'lpAutoAct',
            value: a.id,
            selected: rule.action.id === a.id,
            label: a.label,
            hint: a.hint,
            schema: a.params,
            values,
            paramPrefix: 'act',
          });
        })
        .join('');
      const selectAct = (id, row) => {
        const a = Cat().actionById(id);
        rule.action = { id: a.id, params: Cat().defaultParams(a.params) };
        syncInlineParamsFromRow(row, rule.action.params);
      };
      bindChoiceRadios(body, 'lpAutoAct', selectAct);
      bindChoiceInlineParams(body, 'lpAutoAct', () => rule.action.params, selectAct);
    } else if (step.id === 'actParams') {
      body.innerHTML = renderParamForm(
        Cat().actionById(rule.action.id)?.params,
        rule.action.params,
        'act'
      );
      bindParamForm(body, rule.action.params);
    }
  }

  /** HTML 转义，避免参数标签/选项注入。 */
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 解析 var 类型下拉选项（条件可读只读传感；行为写入侧可 writableOnly）。
   * @param {string} prefix 'cond' | 'act'
   * @param {*} current
   */
  function varSelectOptions(prefix, current) {
    const writableOnly = prefix === 'act';
    const names =
      Prog().listVarNames?.(selectedCarId, { writableOnly }) ||
      Cat()?.varNamesForPicker?.(selectedCarId, { writableOnly }) ||
      Object.keys(Prog().getVars());
    const opts = names.map((n) => ({ value: n, label: n }));
    if (current != null && current !== '' && !opts.some((o) => o.value === current)) {
      opts.unshift({ value: String(current), label: String(current) });
    }
    return opts;
  }

  /**
   * 在选项行右侧渲染该条目的全部参数控件（select / var / number / text）。
   * @param {Array<object>|undefined} schema
   * @param {Record<string, unknown>} values
   * @param {string} prefix
   */
  function renderInlineParamControls(schema, values, prefix) {
    if (!schema?.length) return '';
    const parts = schema.map((p) => {
      const v = values?.[p.key] ?? p.default ?? '';
      if (p.type === 'select') {
        return `<span class="lp-auto-choice-inline">${renderSelectControl(
          p.key,
          v,
          p.options || []
        )}</span>`;
      }
      if (p.type === 'var') {
        return `<span class="lp-auto-choice-inline">${renderSelectControl(
          p.key,
          v,
          varSelectOptions(prefix, v)
        )}</span>`;
      }
      if (p.type === 'number') {
        const minAttr = p.min != null ? ` min="${escapeHtml(p.min)}"` : '';
        const maxAttr = p.max != null ? ` max="${escapeHtml(p.max)}"` : '';
        return `<input type="number" class="lp-auto-choice-num" data-pkey="${escapeHtml(p.key)}"${minAttr}${maxAttr} value="${escapeHtml(v)}" aria-label="${escapeHtml(p.label || '数值')}" inputmode="decimal">`;
      }
      return `<input type="text" class="lp-auto-choice-text-input" data-pkey="${escapeHtml(p.key)}" value="${escapeHtml(v)}" placeholder="${escapeHtml(p.placeholder || '')}" aria-label="${escapeHtml(p.label || '文本')}">`;
    });
    return `<span class="lp-auto-choice-params">${parts.join('')}</span>`;
  }

  /**
   * 渲染条件/行为选项行；有参数时在右侧并排放全部控件。
   * @param {{ name:string, value:string, selected:boolean, label:string, hint?:string, schema?:Array<object>, values?:Record<string, unknown>, paramPrefix?:string }} opts
   */
  function renderChoiceRow(opts) {
    const {
      name,
      value,
      selected,
      label,
      hint,
      schema,
      values,
      paramPrefix = 'cond',
    } = opts;
    const text = `<span class="lp-auto-choice-text"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(hint || '')}</small></span>`;
    const hasParams = Boolean(schema?.length);
    const paramsHtml = hasParams
      ? renderInlineParamControls(schema, values || {}, paramPrefix)
      : '';
    return `
      <label class="lp-auto-choice${hasParams ? ' has-inline-params' : ''}">
        <input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}>
        ${text}
        ${paramsHtml}
      </label>`;
  }

  /** 把选项行内全部 data-pkey 控件写入 params。 */
  function syncInlineParamsFromRow(row, params) {
    if (!row || !params) return;
    row.querySelectorAll('[data-pkey]').forEach((el) => {
      const key = el.getAttribute('data-pkey');
      if (!key) return;
      if (el.type === 'number') {
        const n = Number(el.value);
        params[key] = Number.isFinite(n) ? n : 0;
      } else {
        params[key] = el.value;
      }
    });
  }

  /** 绑定条件/行为单选；切换时由 onSelect 重置默认参并读入本行内联控件。 */
  function bindChoiceRadios(body, name, onSelect) {
    body.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
      el.addEventListener('change', () => {
        onSelect(el.value, el.closest('.lp-auto-choice'));
      });
    });
  }

  /**
   * 绑定选项行内全部参数控件：改动即写回；未选中该行时先选中再写入。
   * @param {() => object} getParams
   * @param {(id: string, row: HTMLElement) => void} selectRow
   */
  function bindChoiceInlineParams(body, radioName, getParams, selectRow) {
    /** 将某控件所在行同步到当前选中项的 params。 */
    const applyFrom = (el) => {
      const row = el.closest('.lp-auto-choice');
      const radio = row?.querySelector(`input[name="${radioName}"]`);
      if (!radio || !row) return;
      if (!radio.checked) {
        radio.checked = true;
        selectRow(radio.value, row);
        return;
      }
      syncInlineParamsFromRow(row, getParams());
    };
    body.querySelectorAll('.lp-auto-choice [data-pkey]').forEach((el) => {
      el.addEventListener('input', () => applyFrom(el));
      el.addEventListener('change', () => applyFrom(el));
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
    });
    bindCustomSelects(body);
  }

  /**
   * 渲染内置下拉（替代原生 select），选项 value 仍为 catalog id。
   * @param {string} pkey
   * @param {string} value
   * @param {{ value: string, label: string }[]} options
   */
  function renderSelectControl(pkey, value, options) {
    const list = options || [];
    const current = list.find((o) => o.value === value) || list[0];
    const currentValue = current ? current.value : value;
    const currentLabel = current ? current.label : String(value || '');
    const items = list
      .map((o) => {
        const selected = o.value === currentValue;
        return `<li class="lp-auto-select-option${selected ? ' is-selected' : ''}" role="option" data-value="${escapeHtml(o.value)}" aria-selected="${selected ? 'true' : 'false'}">${escapeHtml(o.label)}</li>`;
      })
      .join('');
    return `
      <div class="lp-auto-select" data-lp-select>
        <button type="button" class="lp-auto-select-trigger" aria-haspopup="listbox" aria-expanded="false">
          <span class="lp-auto-select-label">${escapeHtml(currentLabel)}</span>
          <span class="lp-auto-select-chevron" aria-hidden="true"></span>
        </button>
        <ul class="lp-auto-select-menu" role="listbox" hidden>${items}</ul>
        <input type="hidden" data-pkey="${escapeHtml(pkey)}" value="${escapeHtml(currentValue)}">
      </div>`;
  }

  /** 关闭作用域内所有已打开的内置下拉。 */
  function closeAllAutoSelects(scope, except) {
    scope.querySelectorAll('.lp-auto-select.is-open').forEach((wrap) => {
      if (except && wrap === except) return;
      wrap.classList.remove('is-open');
      const trigger = wrap.querySelector('.lp-auto-select-trigger');
      const menu = wrap.querySelector('.lp-auto-select-menu');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (menu) menu.hidden = true;
    });
  }

  /**
   * 绑定内置下拉：点击展开、点选项写入 hidden、Esc / 外侧点击关闭。
   * @param {HTMLElement} scope
   */
  function bindCustomSelects(scope) {
    scope.querySelectorAll('[data-lp-select]').forEach((wrap) => {
      const trigger = wrap.querySelector('.lp-auto-select-trigger');
      const menu = wrap.querySelector('.lp-auto-select-menu');
      const hidden = wrap.querySelector('input[data-pkey]');
      const labelEl = wrap.querySelector('.lp-auto-select-label');
      if (!trigger || !menu || !hidden) return;

      /** 打开或关闭本下拉；打开时先关掉同表单其它下拉。 */
      const setOpen = (open) => {
        if (open) closeAllAutoSelects(scope, wrap);
        wrap.classList.toggle('is-open', open);
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.hidden = !open;
      };

      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!wrap.classList.contains('is-open'));
      });

      menu.querySelectorAll('.lp-auto-select-option').forEach((opt) => {
        opt.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = opt.getAttribute('data-value') || '';
          hidden.value = next;
          if (labelEl) labelEl.textContent = opt.textContent || next;
          menu.querySelectorAll('.lp-auto-select-option').forEach((o) => {
            const on = o === opt;
            o.classList.toggle('is-selected', on);
            o.setAttribute('aria-selected', on ? 'true' : 'false');
          });
          setOpen(false);
          hidden.dispatchEvent(new Event('change', { bubbles: true }));
        });
      });
    });

    if (document.documentElement.dataset.lpAutoSelectDoc === '1') return;
    document.documentElement.dataset.lpAutoSelectDoc = '1';
    document.addEventListener(
      'click',
      (e) => {
        document.querySelectorAll('.lp-auto-select.is-open').forEach((wrap) => {
          if (!wrap.contains(e.target)) {
            wrap.classList.remove('is-open');
            const trigger = wrap.querySelector('.lp-auto-select-trigger');
            const menu = wrap.querySelector('.lp-auto-select-menu');
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
            if (menu) menu.hidden = true;
          }
        });
      },
      true
    );
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.lp-auto-select.is-open').forEach((wrap) => {
        wrap.classList.remove('is-open');
        const trigger = wrap.querySelector('.lp-auto-select-trigger');
        const menu = wrap.querySelector('.lp-auto-select-menu');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
        if (menu) menu.hidden = true;
      });
    });
  }

  function renderParamForm(schema, values, prefix) {
    if (!schema?.length) return '<p class="lp-auto-empty">无需参数</p>';
    return schema
      .map((p) => {
        const v = values[p.key] ?? p.default ?? '';
        if (p.type === 'select') {
          return `<div class="lp-auto-param"><span>${escapeHtml(p.label)}</span>${renderSelectControl(p.key, v, p.options || [])}</div>`;
        }
        if (p.type === 'var') {
          const writableOnly = prefix === 'act';
          const names =
            Prog().listVarNames?.(selectedCarId, { writableOnly }) ||
            Cat()?.varNamesForPicker?.(selectedCarId, { writableOnly }) ||
            Object.keys(Prog().getVars());
          const opts = names.map((n) => ({ value: n, label: n }));
          return `<div class="lp-auto-param"><span>${escapeHtml(p.label)}</span>${renderSelectControl(p.key, v, opts)}</div>`;
        }
        const inputType = p.type === 'number' ? 'number' : 'text';
        return `<label class="lp-auto-param"><span>${escapeHtml(p.label)}</span><input type="${inputType}" data-pkey="${escapeHtml(p.key)}" value="${escapeHtml(v)}" placeholder="${escapeHtml(p.placeholder || '')}"></label>`;
      })
      .join('');
  }

  function bindParamForm(scope, target) {
    bindCustomSelects(scope);
    scope.querySelectorAll('[data-pkey]').forEach((el) => {
      const key = el.getAttribute('data-pkey');
      const sync = () => {
        target[key] = el.type === 'number' ? Number(el.value) : el.value;
      };
      el.addEventListener('input', sync);
      el.addEventListener('change', sync);
    });
  }

  /** 向导完成：写入对应触发段（改 trigger 时迁段）。 */
  function commitWizard() {
    if (!editor || !selectedCarId) return;
    if (Prog().upsertRule) {
      Prog().upsertRule(selectedCarId, editor.rule, editor.mode);
    } else {
      const list = Prog().getRules(selectedCarId);
      if (editor.mode === 'add') list.push(editor.rule);
      else {
        const i = list.findIndex((r) => r.id === editor.rule.id);
        if (i >= 0) list[i] = editor.rule;
        else list.push(editor.rule);
      }
      Prog().setRules(selectedCarId, list);
    }
    discardImportUndo();
    editor = null;
    wizard.hidden = true;
    renderRules();
  }

  /** 复制整份程序到剪贴板（失败则下载 JSON）。 */
  async function copyProgramToClipboard() {
    const text = Prog().toShareText();
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制整份程序到剪贴板');
    } catch {
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'liminal-auto-program.json';
      a.click();
      URL.revokeObjectURL(a.href);
      notify('无法写入剪贴板，已改为下载 JSON 文件');
    }
  }

  /**
   * 复制单条规则到剪贴板（kind=liminal-auto-rule；导入时追加，不覆盖整份）。
   * @param {object} rule
   */
  async function copyRuleToClipboard(rule) {
    if (!selectedCarId || !rule) return;
    const text = Prog().toRuleShareText
      ? Prog().toRuleShareText(selectedCarId, rule)
      : JSON.stringify(
          {
            kind: Prog().SHARE_RULE_KIND || 'liminal-auto-rule',
            version: 1,
            carId: selectedCarId,
            rule,
          },
          null,
          2
        );
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制规则');
    } catch {
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'liminal-auto-rule.json';
      a.click();
      URL.revokeObjectURL(a.href);
      notify('无法写入剪贴板，已改为下载规则 JSON');
    }
  }

  /**
   * 应用导入结果并刷新界面（覆盖可撤销；追加仅 toast）。
   * @param {{ ok: boolean, error?: string, mode?: string }} result
   */
  function applyImportResult(result) {
    if (!result.ok) {
      notify(result.error || '导入失败');
      return false;
    }
    hidePasteDialog();
    renderAll();
    if (result.mode === 'append') {
      notify('已添加规则');
      return true;
    }
    notify('已从文本导入整份程序（覆盖当前变量与规则）');
    showUndoBanner();
    return true;
  }

  function showPasteDialog(prefill, hint) {
    if (!pasteDialog) {
      const manual = window.prompt(
        hint || '请粘贴程序或单条规则 JSON 文本：',
        prefill || ''
      );
      if (manual == null) return;
      applyImportResult(
        Prog().importShareText(manual, { targetCarId: selectedCarId })
      );
      return;
    }
    pasteDialog.hidden = false;
    if (pasteError) pasteError.textContent = hint || '';
    if (pasteTextarea) {
      pasteTextarea.value = prefill || '';
      pasteTextarea.focus();
    }
  }

  function hidePasteDialog() {
    if (pasteDialog) pasteDialog.hidden = true;
    if (pasteError) pasteError.textContent = '';
    if (pasteTextarea) pasteTextarea.value = '';
  }

  /** 从系统剪贴板导入；按 kind 覆盖整份或追加单条规则。 */
  async function importProgramFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const result = Prog().importShareText(text, { targetCarId: selectedCarId });
      if (!result.ok) {
        showPasteDialog(text, result.error);
        return;
      }
      applyImportResult(result);
    } catch {
      showPasteDialog(
        '',
        '无法读取系统剪贴板（浏览器权限或非安全上下文）。请把程序或规则 JSON 粘贴到下方再导入。'
      );
    }
  }

  /** 确认粘贴对话框中的文本并导入（自动识别整份 / 单条）。 */
  function confirmPasteDialog() {
    const text = pasteTextarea?.value || '';
    const result = Prog().importShareText(text, { targetCarId: selectedCarId });
    if (!result.ok) {
      if (pasteError) pasteError.textContent = result.error;
      else notify(result.error);
      return;
    }
    applyImportResult(result);
  }

  document.getElementById('lpAutoAddRule')?.addEventListener('click', () => {
    if (!selectedCarId) return;
    openWizard('add', Prog().createBlankRule(selectedCarId));
  });

  document.getElementById('lpAutoCopyClipboard')?.addEventListener('click', () => {
    copyProgramToClipboard();
  });
  document.getElementById('lpAutoImportClipboard')?.addEventListener('click', () => {
    importProgramFromClipboard();
  });
  // 兼容旧按钮 id
  document.getElementById('lpAutoExport')?.addEventListener('click', () => {
    copyProgramToClipboard();
  });

  undoBanner?.querySelector('[data-act="undo-import"]')?.addEventListener('click', () => {
    undoImportOverwrite();
  });
  undoBanner?.querySelector('[data-act="dismiss-undo"]')?.addEventListener('click', () => {
    hideUndoBanner({ clearSnapshot: true });
  });

  pasteDialog?.querySelector('[data-act="paste-cancel"]')?.addEventListener('click', () => {
    hidePasteDialog();
  });
  pasteDialog?.querySelector('[data-act="paste-import"]')?.addEventListener('click', () => {
    confirmPasteDialog();
  });

  wizard?.querySelector('[data-act="prev"]')?.addEventListener('click', () => {
    if (!editor) return;
    editor.step -= 1;
    paintWizard();
  });
  wizard?.querySelector('[data-act="next"]')?.addEventListener('click', () => {
    if (!editor) return;
    const steps = wizardSteps();
    if (editor.step >= steps.length - 1) commitWizard();
    else {
      editor.step += 1;
      paintWizard();
    }
  });
  wizard?.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
    editor = null;
    wizard.hidden = true;
  });

  closeBtn?.addEventListener('click', () => closePanel());
  root.querySelector('.lp-auto-backdrop')?.addEventListener('click', () => closePanel());

  window.LpAutoConsole = {
    isOpen,
    open: openPanel,
    close: closePanel,
    refreshSensorVars,
  };
})();
