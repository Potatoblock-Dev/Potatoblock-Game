/**
 * 本地调试：在角色脚下投放任意图鉴物品。
 * LOCAL ONLY — 仅 localhost；生产页不注入本脚本。` 呼出/收起。
 */
(() => {
  let rootEl = null;
  let statusEl = null;
  let panelOpen = false;
  let keyBound = false;

  /** 是否本地开发主机。 */
  function isLocalDevHost() {
    const n = String(location.hostname || '').toLowerCase();
    return n === 'localhost' || n === '127.0.0.1' || n === '[::1]' || n === '::1';
  }

  /** 是否启用（仅本地；?debugHold=0 强制关）。 */
  function isEnabled() {
    const params = new URLSearchParams(location.search);
    const flag = params.get('debugHold');
    if (flag === '0' || flag === 'false') return false;
    return isLocalDevHost();
  }

  /** 图鉴条目列表（按显示名排序）。 */
  function listCatalogItems() {
    const items = window.LpItemCatalog?.ITEMS || {};
    return Object.values(items)
      .filter((it) => it && it.id && !String(it.id).includes('gur77'))
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh'));
  }

  /** 本地玩家脚下世界坐标。 */
  function playerDropPoint() {
    const x = Number(window.LpGame?.getLocalX?.());
    const floor = window.LiminalCarriageSpec?.FLOOR_Y ?? 0;
    if (!Number.isFinite(x)) return null;
    return { x, y: floor };
  }

  /** 按物品补全默认 mag / dur。 */
  function buildStack(itemId, qty) {
    const item = window.LpItemCatalog?.getItem?.(itemId);
    if (!item) return null;
    const stack = { itemId, qty: Math.max(1, Math.floor(Number(qty) || 1)) };
    if (item.magazineSize != null) stack.mag = item.magazineSize;
    if (item.maxDurability != null) stack.dur = item.maxDurability;
    return stack;
  }

  /** 写入状态行。 */
  function setStatus(text, ok = true) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = ok ? '#86efac' : '#fbbf24';
  }

  /** 执行投放。 */
  function spawnSelected() {
    if (window.LpInventoryNet?.isActive?.()) {
      setStatus('联机中：仅支持本地断线调试投放', false);
      return;
    }
    const select = rootEl?.querySelector('#lpDbgSpawnItem');
    const qtyEl = rootEl?.querySelector('#lpDbgSpawnQty');
    const itemId = String(select?.value || '');
    const qty = Number(qtyEl?.value || 1);
    const stack = buildStack(itemId, qty);
    const at = playerDropPoint();
    if (!stack || !at) {
      setStatus('无法投放：缺物品或玩家坐标', false);
      return;
    }
    const ok = window.LpGroundLoot?.dropFullStack?.(at.x, stack, at.y);
    if (!ok) {
      setStatus(`投放失败：${itemId}`, false);
      return;
    }
    const item = window.LpItemCatalog.getItem(itemId);
    setStatus(`已丢下 ${item?.name || itemId} ×${stack.qty}（开背包可检）`);
  }

  /** 填充下拉。 */
  function fillSelect(select) {
    const prev = select.value;
    select.innerHTML = '';
    for (const item of listCatalogItems()) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = `${item.name || item.id} (${item.id})`;
      select.appendChild(opt);
    }
    if (prev && [...select.options].some((o) => o.value === prev)) select.value = prev;
    else if (select.options.length) select.selectedIndex = 0;
  }

  /** 根据选中物品调整数量上限提示。 */
  function syncQtyHint() {
    const select = rootEl?.querySelector('#lpDbgSpawnItem');
    const qtyEl = rootEl?.querySelector('#lpDbgSpawnQty');
    const hint = rootEl?.querySelector('#lpDbgSpawnQtyHint');
    const item = window.LpItemCatalog?.getItem?.(select?.value);
    if (!item || !qtyEl) return;
    const cap = Math.max(1, Number(item.maxStack) || 1);
    qtyEl.max = String(cap);
    if (Number(qtyEl.value) > cap) qtyEl.value = String(cap);
    if (hint) hint.textContent = `上限 ${cap}`;
  }

  /** 显隐面板。 */
  function setPanelOpen(open) {
    panelOpen = open;
    if (rootEl) rootEl.hidden = !open;
  }

  /** 打开。 */
  function openPanel() {
    if (!isEnabled()) return;
    if (!rootEl) mount();
    setPanelOpen(true);
  }

  /** 切换；未挂载则挂载并打开。 */
  function togglePanel() {
    if (!isEnabled()) return;
    if (!rootEl) {
      mount();
      setPanelOpen(true);
      return;
    }
    setPanelOpen(!panelOpen);
  }

  /** 挂载面板。 */
  function mount() {
    if (!isEnabled() || rootEl) return;
    rootEl = document.createElement('aside');
    rootEl.className = 'lp-debug-spawn';
    rootEl.hidden = !panelOpen;
    rootEl.innerHTML = `
      <div class="lp-dbg-spawn-head">
        <strong>调试投放</strong>
        <span class="lp-dbg-spawn-hint">脚下地面 · \` 呼出 · 仅本地</span>
        <button type="button" class="lp-dbg-spawn-close" aria-label="关闭">×</button>
      </div>
      <p class="lp-dbg-spawn-status" id="lpDbgSpawnStatus">选物品后点投放</p>
      <label class="lp-dbg-spawn-row">
        <span>物品</span>
        <select id="lpDbgSpawnItem"></select>
      </label>
      <label class="lp-dbg-spawn-row">
        <span>数量 <small id="lpDbgSpawnQtyHint"></small></span>
        <input id="lpDbgSpawnQty" type="number" min="1" step="1" value="1" />
      </label>
      <div class="lp-dbg-spawn-actions">
        <button type="button" id="lpDbgSpawnBtn">丢到脚下</button>
        <button type="button" id="lpDbgSpawnRefresh">刷新图鉴</button>
      </div>
    `;
    document.body.appendChild(rootEl);
    statusEl = rootEl.querySelector('#lpDbgSpawnStatus');
    const select = rootEl.querySelector('#lpDbgSpawnItem');
    fillSelect(select);
    syncQtyHint();
    select.addEventListener('change', syncQtyHint);
    rootEl.querySelector('#lpDbgSpawnBtn')?.addEventListener('click', spawnSelected);
    rootEl.querySelector('#lpDbgSpawnRefresh')?.addEventListener('click', () => {
      fillSelect(select);
      syncQtyHint();
      setStatus('图鉴已刷新');
    });
    rootEl.querySelector('.lp-dbg-spawn-close')?.addEventListener('click', () => setPanelOpen(false));
  }

  function bindHotkey() {
    if (keyBound || !isEnabled()) return;
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== 'Backquote' || ev.repeat) return;
      if (!isEnabled()) return;
      if (ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
      togglePanel();
      ev.preventDefault();
    });
    keyBound = true;
  }

  function boot() {
    if (!isEnabled()) return;
    bindHotkey();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  window.LpDebugSpawnItem = {
    isEnabled,
    mount,
    open: openPanel,
    togglePanel,
  };
})();
