/**
 * 火器持握调试面板：本地调参 + 导出 JSON，供写回 catalog / ProceduralMotion。
 * LOCAL/DEBUG ONLY — do not enable in production upload.
 * 仅 URL ?debugHold=1|true 挂载；生产默认关闭。` 切换显隐。
 */
(() => {
  const HOLD_KEYS = [
    'chestX',
    'chestY',
    'gripAlong',
    'gripBelow',
    'gunForendX',
    'gunForendY',
    'forendAlong',
    'forendBelow',
    'gripLimb',
    'forendLimb',
    'gripElbowSign',
    'forendElbowSign',
    'shoulderX',
    'shoulderY',
    'upperLen',
    'lowerLen',
    'shoulderMin',
    'shoulderMax',
    'elbowMin',
    'elbowMax',
  ];
  const DRAW_KEYS = ['holdDrawW', 'holdDrawH', 'holdPivotX', 'holdPivotY'];

  /** @type {null | {
   *   itemId: string,
   *   holdPose: Record<string, number|string>,
   *   draw: Record<string, number>,
   *   aimDeg: number|null,
   *   aimLock: boolean
   * }} */
  let state = null;
  let rootEl = null;
  let panelOpen = true;
  let statusEl = null;

  /**
   * 是否启用调试模块。
   * 仅认明确的 ?debugHold=1|true；拒绝 ?debugHold%3D1（整段成 key）与 localStorage/localhost 默认开。
   */
  function isEnabled() {
    const params = new URLSearchParams(location.search);
    const flag = params.get('debugHold');
    if (flag === '0' || flag === 'false') return false;
    return flag === '1' || flag === 'true';
  }

  /** 打开面板（须已 ?debugHold=1；未挂载时先 mount）。 */
  function openPanel() {
    if (!isEnabled()) return;
    if (!rootEl) mount();
    else setPanelOpen(true);
  }

  /** 从默认规格 + 物品 holdPose / 绘制字段拼出当前可调值。 */
  function buildStateFromItem(item) {
    const Motion = window.ProceduralMotion;
    const defaults = Motion?.FIREARM_HOLD_DEFAULTS
      ? { ...Motion.FIREARM_HOLD_DEFAULTS }
      : {};
    const holdPose = { ...defaults, ...(item?.holdPose || {}) };
    const draw = {};
    for (const key of DRAW_KEYS) {
      if (Number.isFinite(item?.[key])) draw[key] = item[key];
    }
    if (!Number.isFinite(draw.holdDrawW)) draw.holdDrawW = 46;
    if (!Number.isFinite(draw.holdDrawH)) draw.holdDrawH = 20;
    if (!Number.isFinite(draw.holdPivotX)) draw.holdPivotX = 10;
    if (!Number.isFinite(draw.holdPivotY)) draw.holdPivotY = draw.holdDrawH * 0.55;
    return {
      itemId: String(item?.id || ''),
      holdPose,
      draw,
      aimDeg: null,
      aimLock: false,
    };
  }

  /** 面板是否已启用且持有覆盖值。 */
  function isActive() {
    return Boolean(isEnabled() && state);
  }

  /** 合并物品 holdPose 与调试覆盖（供 LpWeaponHold 使用）。 */
  function mergeHoldPose(itemId, base) {
    if (!isActive()) return base || null;
    if (itemId && state.itemId && itemId !== state.itemId) {
      return base || null;
    }
    return { ...(base || {}), ...state.holdPose };
  }

  /** 合并绘制尺寸/枢轴覆盖。 */
  function mergeDraw(itemId, item) {
    if (!isActive()) return item || null;
    if (itemId && state.itemId && itemId !== state.itemId) return item || null;
    return { ...(item || {}), ...state.draw };
  }

  /**
   * 锁定瞄准角时返回世界瞄准点（相对胸口沿 aimDeg）。
   * 未锁定返回 null，继续用准星。
   */
  function getAimWorld(avatar) {
    if (!isActive() || !state.aimLock || !Number.isFinite(state.aimDeg) || !avatar) {
      return null;
    }
    const facing = avatar.facing >= 0 ? 1 : -1;
    const rad = (state.aimDeg * Math.PI) / 180;
    const localX = Math.cos(rad) * 160;
    const localY = Math.sin(rad) * 160;
    const chestY = avatar.y + (avatar.bodyBob || 0) - 11;
    return {
      x: avatar.x + facing * localX,
      y: chestY + localY,
    };
  }

  /** 读取当前手持武器；无则 null。 */
  function readHeldItem() {
    return window.LpCombat?.getHeldWeaponItem?.() || null;
  }

  /** 同步面板到当前手持物品（换枪时重建 state）。 */
  function syncToHeldWeapon() {
    const item = readHeldItem();
    if (!item) {
      state = null;
      setStatus('手持 G65（或其它火器）后调参');
      syncFormDisabled(true);
      return;
    }
    if (!state || state.itemId !== item.id) {
      state = buildStateFromItem(item);
      fillFormFromState();
    }
    setStatus(`调参中：${item.name || item.id}`);
    syncFormDisabled(false);
  }

  /** 写入状态栏文案。 */
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  /** 禁用/启用表单控件。 */
  function syncFormDisabled(disabled) {
    if (!rootEl) return;
    rootEl.querySelectorAll('input, select, button[data-needs-item]').forEach((el) => {
      el.disabled = disabled;
    });
  }

  /** 把同一 data-* 键的 range/number/select 全部写成同一值。 */
  function setControlGroup(attr, key, value) {
    rootEl.querySelectorAll(`[${attr}="${key}"]`).forEach((el) => {
      el.value = String(value ?? '');
    });
  }

  /** 从 state 刷新所有控件显示值。 */
  function fillFormFromState() {
    if (!rootEl || !state) return;
    for (const key of HOLD_KEYS) {
      setControlGroup('data-hold', key, state.holdPose[key]);
    }
    for (const key of DRAW_KEYS) {
      setControlGroup('data-draw', key, state.draw[key]);
    }
    setControlGroup('data-aim', 'deg', state.aimDeg ?? 0);
    const lockEl = rootEl.querySelector('[data-aim="lock"]');
    if (lockEl) lockEl.checked = Boolean(state.aimLock);
  }

  /** 从控件读回 state（滑条/输入即时生效）。 */
  function readFormIntoState() {
    if (!rootEl || !state) return;
    for (const key of HOLD_KEYS) {
      const el = rootEl.querySelector(`[data-hold="${key}"]`);
      if (!el) continue;
      if (key === 'gripLimb' || key === 'forendLimb') {
        state.holdPose[key] = el.value === 'back' ? 'back' : 'front';
        continue;
      }
      const n = Number(el.value);
      if (Number.isFinite(n)) state.holdPose[key] = n;
    }
    for (const key of DRAW_KEYS) {
      const el = rootEl.querySelector(`[data-draw="${key}"]`);
      if (!el) continue;
      const n = Number(el.value);
      if (Number.isFinite(n)) state.draw[key] = n;
    }
    const aimEl = rootEl.querySelector('[data-aim="deg"]');
    const lockEl = rootEl.querySelector('[data-aim="lock"]');
    if (aimEl) {
      const n = Number(aimEl.value);
      state.aimDeg = Number.isFinite(n) ? n : 0;
    }
    if (lockEl) state.aimLock = Boolean(lockEl.checked);
  }

  /** 组装可粘贴导出对象（含字段落点说明）。 */
  function buildExportPayload() {
    const item = readHeldItem();
    const holdPose = {};
    for (const key of HOLD_KEYS) {
      if (state?.holdPose[key] !== undefined) holdPose[key] = state.holdPose[key];
    }
    const draw = { ...(state?.draw || {}) };
    return {
      _comment:
        'holdPose：红握把 gripAlong/Below（相对胸口）+ holdPivotX/Y（贴图锚点）；'
        + '橙护木 gunForendX/Y（相对握把沿枪管）。draw → holdDrawW/H。调好后把 JSON 贴给 agent 写回即可。',
      itemId: state?.itemId || item?.id || '',
      itemName: item?.name || '',
      holdPose,
      draw,
      aimDeg: state?.aimLock ? state.aimDeg : null,
    };
  }

  /** 复制导出 JSON 到剪贴板。 */
  async function copyExport() {
    if (!state) {
      setStatus('先手持武器再导出');
      return;
    }
    const text = `${JSON.stringify(buildExportPayload(), null, 2)}\n`;
    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制 JSON 到剪贴板');
    } catch {
      downloadExport();
      setStatus('剪贴板不可用，已改为下载');
    }
  }

  /** 下载导出 JSON 文件。 */
  function downloadExport() {
    if (!state) return;
    const blob = new Blob([`${JSON.stringify(buildExportPayload(), null, 2)}\n`], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `hold-pose-${state.itemId || 'weapon'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 从 JSON 文本导入覆盖值。 */
  function importJsonText(raw) {
    const data = JSON.parse(raw);
    const item = readHeldItem();
    if (!state) {
      if (!item) throw new Error('先手持武器再导入');
      state = buildStateFromItem(item);
    }
    if (data.holdPose && typeof data.holdPose === 'object') {
      state.holdPose = { ...state.holdPose, ...data.holdPose };
    }
    if (data.draw && typeof data.draw === 'object') {
      state.draw = { ...state.draw, ...data.draw };
    }
    if (Number.isFinite(data.aimDeg)) {
      state.aimDeg = data.aimDeg;
      state.aimLock = true;
    }
    if (data.itemId && state.itemId && data.itemId !== state.itemId) {
      setStatus(`警告：JSON 物品 ${data.itemId} ≠ 当前 ${state.itemId}，仍已套用数值`);
    } else {
      setStatus('已导入 JSON');
    }
    fillFormFromState();
  }

  /** 重置为当前物品 catalog 默认。 */
  function resetToCatalog() {
    const item = readHeldItem();
    if (!item) return;
    state = buildStateFromItem(item);
    fillFormFromState();
    setStatus('已重置为 catalog 默认');
  }

  /** 创建一行数字滑条控件。 */
  function rowRange(label, attrs, min, max, step) {
    return (
      `<label class="lp-hpd-row">`
      + `<span class="lp-hpd-label">${label}</span>`
      + `<input type="range" min="${min}" max="${max}" step="${step}" ${attrs}>`
      + `<input type="number" step="${step}" ${attrs} class="lp-hpd-num">`
      + `</label>`
    );
  }

  /** 构建面板 DOM。 */
  function buildPanel() {
    const el = document.createElement('aside');
    el.id = 'lpHoldPoseDebug';
    el.className = 'lp-hold-pose-debug';
    el.setAttribute('aria-label', '持握姿态调试');
    el.innerHTML = `
      <header class="lp-hpd-head">
        <strong>Hold Pose Debug</strong>
        <span class="lp-hpd-hint">\` 显隐 · ?debugHold=1</span>
        <button type="button" class="lp-hpd-close" data-action="hide" title="隐藏">×</button>
      </header>
      <p class="lp-hpd-status" data-role="status">…</p>
      <section class="lp-hpd-section">
        <h3>布局根（胸口）</h3>
        ${rowRange('chestX', 'data-hold="chestX"', -20, 30, 0.5)}
        ${rowRange('chestY', 'data-hold="chestY"', -40, 10, 0.5)}
      </section>
      <section class="lp-hpd-section lp-hpd-section--grip">
        <h3>红握把 · back</h3>
        ${rowRange('gripAlong', 'data-hold="gripAlong"', -10, 40, 0.5)}
        ${rowRange('gripBelow', 'data-hold="gripBelow"', -20, 30, 0.5)}
        ${rowRange('holdPivotX', 'data-draw="holdPivotX"', 0, 60, 1)}
        ${rowRange('holdPivotY', 'data-draw="holdPivotY"', 0, 40, 1)}
        <label class="lp-hpd-row">
          <span class="lp-hpd-label">gripLimb</span>
          <select data-hold="gripLimb">
            <option value="front">front（右/前）</option>
            <option value="back">back（左/后）</option>
          </select>
        </label>
        <label class="lp-hpd-row">
          <span class="lp-hpd-label">gripElbowSign</span>
          <select data-hold="gripElbowSign">
            <option value="-1">-1（肘在枪下）</option>
            <option value="1">+1（肘在枪上）</option>
          </select>
        </label>
        <p class="lp-hpd-hint">gripAlong/Below=相对胸口；holdPivot=贴图握把锚点（红手）</p>
      </section>
      <section class="lp-hpd-section lp-hpd-section--forend">
        <h3>橙护木 · front</h3>
        ${rowRange('gunForendX', 'data-hold="gunForendX"', 0, 60, 0.5)}
        ${rowRange('gunForendY', 'data-hold="gunForendY"', -20, 30, 0.5)}
        <label class="lp-hpd-row">
          <span class="lp-hpd-label">forendLimb</span>
          <select data-hold="forendLimb">
            <option value="front">front（右/前）</option>
            <option value="back">back（左/后）</option>
          </select>
        </label>
        <label class="lp-hpd-row">
          <span class="lp-hpd-label">forendElbowSign</span>
          <select data-hold="forendElbowSign">
            <option value="-1">-1（肘在枪下）</option>
            <option value="1">+1（肘在枪上）</option>
          </select>
        </label>
        <p class="lp-hpd-hint">gunForendX/Y=相对握把沿枪管（橙手第二插槽）</p>
      </section>
      <section class="lp-hpd-section">
        <h3>肩 / 臂长</h3>
        ${rowRange('shoulderX', 'data-hold="shoulderX"', 0, 24, 0.5)}
        ${rowRange('shoulderY', 'data-hold="shoulderY"', -36, 0, 0.5)}
        ${rowRange('upperLen', 'data-hold="upperLen"', 8, 24, 0.5)}
        ${rowRange('lowerLen', 'data-hold="lowerLen"', 8, 24, 0.5)}
      </section>
      <section class="lp-hpd-section">
        <h3>绘制尺寸</h3>
        ${rowRange('holdDrawW', 'data-draw="holdDrawW"', 20, 120, 1)}
        ${rowRange('holdDrawH', 'data-draw="holdDrawH"', 8, 60, 1)}
      </section>
      <section class="lp-hpd-section">
        <h3>瞄准角（可选）</h3>
        <label class="lp-hpd-row">
          <span class="lp-hpd-label">锁定</span>
          <input type="checkbox" data-aim="lock">
        </label>
        ${rowRange('aimDeg', 'data-aim="deg"', -90, 90, 1)}
      </section>
      <footer class="lp-hpd-actions">
        <button type="button" data-needs-item data-action="export-copy">复制 JSON</button>
        <button type="button" data-needs-item data-action="export-dl">下载</button>
        <button type="button" data-needs-item data-action="import">导入</button>
        <button type="button" data-needs-item data-action="reset">重置</button>
        <button type="button" data-action="disable">关闭调试</button>
      </footer>
      <input type="file" accept="application/json,.json" hidden data-role="file">
    `;
    return el;
  }

  /** 绑定滑条与数字框双向同步。 */
  function bindLinkedInputs(scope) {
    scope.querySelectorAll('input[type="range"][data-hold], input[type="range"][data-draw], input[type="range"][data-aim]').forEach((range) => {
      const keyAttr = range.hasAttribute('data-hold')
        ? 'data-hold'
        : range.hasAttribute('data-draw')
          ? 'data-draw'
          : 'data-aim';
      const key = range.getAttribute(keyAttr);
      const num = scope.querySelector(`input.lp-hpd-num[${keyAttr}="${key}"]`);
      if (!num) return;
      const sync = (from, to) => {
        to.value = from.value;
        readFormIntoState();
      };
      range.addEventListener('input', () => sync(range, num));
      num.addEventListener('input', () => sync(num, range));
    });
  }

  /** 切换面板显隐。 */
  function setPanelOpen(open) {
    panelOpen = open;
    if (rootEl) rootEl.hidden = !open;
  }

  /** 卸下面板；需再次 ?debugHold=1 刷新才能开。 */
  function disableDebug() {
    state = null;
    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }
    window.LpHoldPoseDebug = {
      isEnabled: () => false,
      isActive: () => false,
      mergeHoldPose: (_id, base) => base || null,
      mergeDraw: (_id, item) => item || null,
      getAimWorld: () => null,
      openPanel,
    };
  }

  /** 挂载面板与快捷键（可重复调用时若已挂载则只显示）。 */
  function mount() {
    if (!isEnabled()) return;
    if (rootEl) {
      setPanelOpen(true);
      return;
    }
    rootEl = buildPanel();
    document.body.appendChild(rootEl);
    statusEl = rootEl.querySelector('[data-role="status"]');
    const fileEl = rootEl.querySelector('[data-role="file"]');
    bindLinkedInputs(rootEl);

    rootEl.addEventListener('input', (event) => {
      const t = event.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.matches('select, input[type="checkbox"], input[data-aim], input[data-hold], input[data-draw]')) {
        readFormIntoState();
      }
    });
    rootEl.addEventListener('change', () => readFormIntoState());

    rootEl.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'hide') setPanelOpen(false);
      if (action === 'export-copy') copyExport();
      if (action === 'export-dl') downloadExport();
      if (action === 'reset') resetToCatalog();
      if (action === 'disable') disableDebug();
      if (action === 'import') fileEl?.click();
    });

    fileEl?.addEventListener('change', async () => {
      const file = fileEl.files?.[0];
      fileEl.value = '';
      if (!file) return;
      try {
        importJsonText(await file.text());
      } catch (err) {
        setStatus(`导入失败：${err?.message || err}`);
      }
    });

    /* 阻止面板内按键冒泡到游戏（避免 WASD 冲突时仍可输入数字） */
    rootEl.addEventListener('keydown', (event) => event.stopPropagation());
    rootEl.addEventListener('keyup', (event) => event.stopPropagation());

    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Backquote' || event.repeat) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      setPanelOpen(!panelOpen);
      event.preventDefault();
    });

    setInterval(syncToHeldWeapon, 400);
    syncToHeldWeapon();
    setPanelOpen(true);
  }

  window.LpHoldPoseDebug = {
    isEnabled,
    isActive,
    mergeHoldPose,
    mergeDraw,
    getAimWorld,
    openPanel,
  };

  function boot() {
    /* LOCAL/DEBUG ONLY — no HUD launcher in shipped UI; URL gate only */
    if (isEnabled()) mount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
