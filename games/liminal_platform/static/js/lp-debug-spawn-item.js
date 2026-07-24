/**
 * 本地调试：脚下投放物品 + fun 彩蛋编辑/触发。
 * LOCAL ONLY — 仅 localhost；生产页不注入本脚本。` 呼出/收起。
 */
(() => {
  let rootEl = null;
  let statusEl = null;
  let funValueEl = null;
  let funAccumEl = null;
  let panelOpen = false;
  let keyBound = false;
  let funUnsub = null;
  let funPollTimer = 0;

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

  /** 按物品补全默认 mag / dur / ammo。 */
  function buildStack(itemId, qty) {
    const item = window.LpItemCatalog?.getItem?.(itemId);
    if (!item) return null;
    const stack = { itemId, qty: Math.max(1, Math.floor(Number(qty) || 1)) };
    if (item.magazineSize != null) stack.mag = item.magazineSize;
    if (item.maxDurability != null) stack.dur = item.maxDurability;
    if (item.maxAmmo != null) stack.ammo = item.maxAmmo;
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

  /** 刷新 fun 显示（当前值与距下次掷骰剩余）。 */
  function syncFunDisplay() {
    const st = window.LpFunEgg?.getState?.();
    if (!st) {
      if (funValueEl) funValueEl.textContent = '—';
      if (funAccumEl) funAccumEl.textContent = 'LpFunEgg 未加载';
      return;
    }
    if (funValueEl) {
      funValueEl.textContent = st.fun == null ? '（尚未掷过）' : String(st.fun);
    }
    if (funAccumEl) {
      const left = Math.ceil(st.nextInSec);
      const m = Math.floor(left / 60);
      const s = left % 60;
      funAccumEl.textContent = `距下次掷骰约 ${m}:${String(s).padStart(2, '0')}`;
    }
    const input = rootEl?.querySelector('#lpDbgFunInput');
    if (input && document.activeElement !== input && st.fun != null) {
      input.value = String(st.fun);
    }
  }

  /** 调试：写入 fun（不自动播）。 */
  function applyFunInput() {
    const input = rootEl?.querySelector('#lpDbgFunInput');
    const raw = Number(input?.value);
    if (!Number.isFinite(raw)) {
      setStatus('fun 需为数字', false);
      return;
    }
    if (!window.LpFunEgg?.setFun) {
      setStatus('LpFunEgg 未加载', false);
      return;
    }
    const v = window.LpFunEgg.setFun(raw);
    syncFunDisplay();
    setStatus(`已设 fun = ${v}`);
  }

  /** 调试：按输入框（或已存）fun 触发已注册彩蛋。 */
  function triggerFunEgg() {
    if (!window.LpFunEgg?.triggerEgg) {
      setStatus('LpFunEgg 未加载', false);
      return;
    }
    const input = rootEl?.querySelector('#lpDbgFunInput');
    if (input?.value !== '' && input?.value != null) {
      window.LpFunEgg.setFun(input.value);
    }
    const value = window.LpFunEgg.getFun?.();
    if (value == null) {
      setStatus('尚无 fun，先设置或等掷骰', false);
      return;
    }
    const ok = window.LpFunEgg.triggerEgg(value);
    syncFunDisplay();
    if (ok) setStatus(`已触发彩蛋 fun=${value}`);
    else setStatus(`fun=${value} 无注册彩蛋`, false);
  }

  /** 调试：点燃玩家所在车厢。 */
  function ignitePlayerCar() {
    const carId = window.LpCarriageFire?.ignitePlayerCar?.();
    if (!carId) {
      setStatus('无法点燃：不在车厢内', false);
      return;
    }
    setStatus(`已点燃车厢 ${carId}`);
  }

  /** 调试：扑灭玩家所在车厢。 */
  function extinguishPlayerCar() {
    const x = Number(window.LpGame?.getLocalX?.());
    const car = window.LiminalCarriageSpec?.carriageAt?.(x);
    if (!car) {
      setStatus('无法扑灭：不在车厢内', false);
      return;
    }
    window.LpCarriageFire?.extinguishCar?.(car.id);
    setStatus(`已扑灭车厢 ${car.id}`);
  }

  /** 调试：脚下生成临时灭火器站。 */
  function spawnDebugStation() {
    const st = window.LpFireExtinguisher?.debugSpawnStation?.();
    if (!st) {
      setStatus('生成灭火器站失败', false);
      return;
    }
    setStatus('已在脚下生成调试灭火器站（R 可装填）');
  }

  /** 显隐面板。 */
  function setPanelOpen(open) {
    panelOpen = open;
    if (rootEl) rootEl.hidden = !open;
    if (open) {
      syncFunDisplay();
      if (!funPollTimer) {
        funPollTimer = window.setInterval(() => {
          if (panelOpen) syncFunDisplay();
        }, 1000);
      }
    } else if (funPollTimer) {
      window.clearInterval(funPollTimer);
      funPollTimer = 0;
    }
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
      <div class="lp-dbg-spawn-section" aria-label="fun 彩蛋">
        <h3 class="lp-dbg-spawn-section-title">fun 彩蛋（本地）</h3>
        <p class="lp-dbg-spawn-fun-meta">当前 <strong id="lpDbgFunValue">—</strong>
          <span id="lpDbgFunAccum" class="lp-dbg-spawn-hint"></span></p>
        <label class="lp-dbg-spawn-row">
          <span>fun [0,10000)</span>
          <input id="lpDbgFunInput" type="number" min="0" max="9999" step="1" value="630" />
        </label>
        <div class="lp-dbg-spawn-actions">
          <button type="button" id="lpDbgFunSet">写入 fun</button>
          <button type="button" id="lpDbgFunTrigger">触发彩蛋</button>
        </div>
      </div>
      <div class="lp-dbg-spawn-section" aria-label="车厢火灾">
        <h3 class="lp-dbg-spawn-section-title">车厢火灾 / 灭火器站</h3>
        <div class="lp-dbg-spawn-actions">
          <button type="button" id="lpDbgIgniteCar">点燃当前车厢</button>
          <button type="button" id="lpDbgExtinguishCar">扑灭当前车厢</button>
        </div>
        <div class="lp-dbg-spawn-actions">
          <button type="button" id="lpDbgSpawnStation">脚下生成灭火器站</button>
        </div>
      </div>
    `;
    document.body.appendChild(rootEl);
    statusEl = rootEl.querySelector('#lpDbgSpawnStatus');
    funValueEl = rootEl.querySelector('#lpDbgFunValue');
    funAccumEl = rootEl.querySelector('#lpDbgFunAccum');
    const select = rootEl.querySelector('#lpDbgSpawnItem');
    fillSelect(select);
    syncQtyHint();
    syncFunDisplay();
    select.addEventListener('change', syncQtyHint);
    rootEl.querySelector('#lpDbgSpawnBtn')?.addEventListener('click', spawnSelected);
    rootEl.querySelector('#lpDbgSpawnRefresh')?.addEventListener('click', () => {
      fillSelect(select);
      syncQtyHint();
      setStatus('图鉴已刷新');
    });
    rootEl.querySelector('#lpDbgFunSet')?.addEventListener('click', applyFunInput);
    rootEl.querySelector('#lpDbgFunTrigger')?.addEventListener('click', triggerFunEgg);
    rootEl.querySelector('#lpDbgIgniteCar')?.addEventListener('click', ignitePlayerCar);
    rootEl.querySelector('#lpDbgExtinguishCar')?.addEventListener('click', extinguishPlayerCar);
    rootEl.querySelector('#lpDbgSpawnStation')?.addEventListener('click', spawnDebugStation);
    rootEl.querySelector('.lp-dbg-spawn-close')?.addEventListener('click', () => setPanelOpen(false));
    funUnsub?.();
    funUnsub = window.LpFunEgg?.subscribe?.(syncFunDisplay) || null;
  }

  /** 焦点是否在可编辑控件（输入时不呼出）。 */
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return true;
    }
    if (target.isContentEditable) return true;
    return Boolean(
      target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
    );
  }

  /** 是否为 ` 热键：优先 code=Backquote，回退 key=`/~。 */
  function isDebugHotkey(ev) {
    if (ev.repeat || ev.isComposing || ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ev.code === 'Backquote') return true;
    return ev.key === '`' || ev.key === '~';
  }

  /** 绑定 ` 切换面板（capture，避免被其它 keydown / IME 抢先吞掉）。 */
  function bindHotkey() {
    if (keyBound || !isEnabled()) return;
    window.addEventListener(
      'keydown',
      (ev) => {
        if (!isDebugHotkey(ev) || !isEnabled()) return;
        if (isTypingTarget(ev.target)) return;
        togglePanel();
        ev.preventDefault();
      },
      true
    );
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
