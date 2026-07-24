/**
 * 卫兵防御车厢弹药箱 / 回收箱：拖放取放 UI。
 * 箱内与「背包弹药/弹壳」均用库存格渲染，格子/物品占地与 footprint（含 rot）一致。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const Core = window.LpInventoryCore;
  const root = document.getElementById('lpGuardCrateRoot');
  const closeButton = document.getElementById('lpGuardCrateClose');
  const hintDesktop = document.getElementById('lpGuardCrateHintDesktop');
  const crateZone = document.getElementById('lpGuardCrateZone');
  const crateGrid = document.getElementById('lpGuardCrateGrid');
  const bagGrid = document.getElementById('lpGuardCrateBagGrid');
  const bagRack = bagGrid?.closest('.lp-fuel-rack') || null;
  const crateLabel = document.getElementById('lpGuardCrateLabel');
  const crateSub = document.getElementById('lpGuardCrateSub');
  const bagTitle = document.getElementById('lpGuardCrateBagTitle');
  const ghost = document.getElementById('lpGuardCrateDragGhost');
  const dock = document.getElementById('lpGuardCrateDock');
  const layout = document.getElementById('lpGuardCrateLayout');
  const ammoBottom = document.getElementById('lpGuardAmmoBottom');

  if (!root || !crateZone || !crateGrid || !bagGrid || !ghost || !Core) return;

  /**
   * 弹药箱模式：底栏挂弹链编辑（supportsBelts）或弹种介绍（火炮类）。
   * 回收箱模式：隐藏底栏，仅保留上下存取双栏。
   */
  function syncAmmoBottom() {
    if (!ammoBottom || !window.LpArmedAmmo) return;
    if (mode === 'ammo') {
      layout?.classList.add('has-ammo-bottom');
      window.LpArmedAmmo.mountCrateBottom?.(ammoBottom, 'guard');
    } else {
      layout?.classList.remove('has-ammo-bottom');
      window.LpArmedAmmo.unmountCrateBottom?.();
      ammoBottom.hidden = true;
    }
  }

  const MODES = {
    ammo: {
      itemId: 'turret_ammo',
      crateTitle: '弹药箱',
      crateSub: '拖入存放 · 拖出取出',
      bagTitle: '背包弹药',
      theme: 'ammo',
      chunk: 10,
    },
    recycle: {
      itemId: 'shell_casing',
      crateTitle: '回收箱',
      crateSub: '拖出取出弹壳',
      bagTitle: '背包弹壳',
      theme: 'recycle',
      chunk: 10,
    },
  };

  let open = false;
  /** @type {'ammo'|'recycle'|null} */
  let mode = null;
  /** @type {{ pointerId: number, from: 'crate'|'bag', slotEl: HTMLElement } | null} */
  let drag = null;
  /** 背包侧展示用临时库存（与真实背包同步，仅本 UI 渲染）。 */
  let bagViewInv = null;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 当前模式配置。 */
  function cfg() {
    return mode ? MODES[mode] : null;
  }

  /** 箱内权威库存。 */
  function crateInventory() {
    return window.LpGuardTurret?.getCrateInventory?.(mode) ?? null;
  }

  /** 玩家侧物品数量。 */
  function countPlayer(itemId) {
    const inv = window.LpInventory;
    let total = inv?.getPlayerInventory?.()?.countItem?.(itemId) ?? 0;
    total += inv?.getHandsInventory?.()?.countItem?.(itemId) ?? 0;
    return total;
  }

  /** 箱内数量。 */
  function countCrate() {
    const c = cfg();
    if (!c) return 0;
    if (mode === 'ammo') return window.LpGuardTurret?.ammoCount?.() ?? 0;
    return window.LpGuardTurret?.casingCount?.() ?? 0;
  }

  /**
   * 收集玩家背包 + 手部中指定物品的原点堆叠（保留 rot）。
   */
  function collectPlayerStacks(itemId) {
    const stacks = [];
    const sources = [
      window.LpInventory?.getPlayerInventory?.(),
      window.LpInventory?.getHandsInventory?.(),
    ];
    for (const inv of sources) {
      if (!inv) continue;
      for (let i = 0; i < inv.size(); i += 1) {
        if (inv.isCovered?.(i)) continue;
        const stack = inv.getSlot(i);
        if (!stack || stack.itemId !== itemId) continue;
        stacks.push(Core.normalizeStack(stack));
      }
    }
    return stacks;
  }

  /**
   * 为背包侧构建临时网格：每堆按 footprint/rot 占格，空时至少给默认占地高度。
   */
  function buildBagViewInventory(itemId) {
    const stacks = collectPlayerStacks(itemId);
    const base = Core.orientedSize(itemId, 0);
    if (stacks.length === 0) {
      return new Core.Inventory(
        'guard-bag-view',
        Math.max(2, base.w),
        Math.max(2, base.h),
        []
      );
    }

    let cols = 0;
    let rows = Math.max(2, base.h);
    for (const stack of stacks) {
      const size = Core.orientedSize(itemId, Core.stackRot(stack));
      cols += size.w;
      rows = Math.max(rows, size.h);
    }
    cols = Math.max(cols, base.w);

    const inv = new Core.Inventory('guard-bag-view', cols, rows, []);
    for (const stack of stacks) {
      const rot = Core.stackRot(stack);
      const origin = inv.findPlaceIndex(itemId, rot);
      if (origin >= 0) inv.placeStack(origin, stack);
    }
    return inv;
  }

  /** 图标是否按 90° 旋转显示。 */
  function applyIconRotation(iconEl, stack) {
    if (!iconEl) return;
    iconEl.classList.toggle('is-rotated', Core.stackRot(stack) === 90);
  }

  /**
   * 绘制单格：多格物品用 grid-column/row span，与主物品栏占地一致。
   */
  function paintSlot(button, inventory, index) {
    const covered = inventory.isCovered(index);
    const { col, row } = inventory.coordsOf(index);
    button.classList.toggle('is-covered', covered);
    button.classList.remove('is-span', 'has-item', 'is-dragging');
    button.style.removeProperty('--span-w');
    button.style.removeProperty('--span-h');
    button.replaceChildren();
    button.removeAttribute('title');

    if (covered) {
      button.hidden = true;
      button.style.removeProperty('grid-column');
      button.style.removeProperty('grid-row');
      return;
    }

    button.hidden = false;
    const stack = inventory.getSlot(index);
    const span = stack ? inventory.spanAt(index) : { w: 1, h: 1 };
    button.style.gridColumn = `${col + 1} / span ${span.w}`;
    button.style.gridRow = `${row + 1} / span ${span.h}`;
    button.classList.toggle('has-item', Boolean(stack));
    button.disabled = false;

    if (!stack) return;

    const item = Catalog.getItem(stack.itemId);
    if (!item) return;

    if (span.w > 1 || span.h > 1) {
      button.classList.add('is-span');
      button.style.setProperty('--span-w', String(span.w));
      button.style.setProperty('--span-h', String(span.h));
    }

    const icon = document.createElement('span');
    icon.className = 'lp-inventory-item-icon';
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    if (item.icon) {
      icon.classList.add('has-image');
      icon.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
      icon.textContent = '';
    } else {
      icon.textContent = item.short;
    }
    applyIconRotation(icon, stack);

    const qty = document.createElement('span');
    qty.className = 'lp-inventory-item-qty';
    qty.textContent = stack.qty > 1 ? String(stack.qty) : '';

    button.title = `${item.name} ×${stack.qty}`;
    button.append(icon, qty);
  }

  /** 创建或复用一格按钮。 */
  function ensureSlotButton(container, inventory, index, side) {
    let button = container.children[index];
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'lp-inventory-slot';
      button.dataset.crateSide = side;
      button.dataset.slotIndex = String(index);
      button.addEventListener('pointerdown', (event) => {
        if (event.button != null && event.button !== 0) return;
        if (!button.classList.contains('has-item')) return;
        beginDrag(event, side, button);
      });
      container.appendChild(button);
    } else {
      button.dataset.crateSide = side;
      button.dataset.slotIndex = String(index);
    }
    paintSlot(button, inventory, index);
  }

  /** 渲染一侧库存网格（占地与主物品栏一致）。 */
  function renderInvGrid(container, inventory, side) {
    if (!container || !inventory) return;
    container.style.setProperty('--cols', String(inventory.cols));
    container.style.setProperty('--rows', String(inventory.rows));
    while (container.childElementCount > inventory.size()) {
      container.lastElementChild.remove();
    }
    for (let i = 0; i < inventory.size(); i += 1) {
      ensureSlotButton(container, inventory, i, side);
    }
  }

  /** 刷新两侧网格与主题。 */
  function render() {
    const c = cfg();
    if (!c) return;
    const item = Catalog?.getItem?.(c.itemId);
    if (!item) return;
    if (crateLabel) crateLabel.textContent = c.crateTitle;
    if (crateSub) {
      const total = countCrate();
      crateSub.textContent = total > 0 ? `${c.crateSub} · 共 ${total}` : c.crateSub;
    }
    if (bagTitle) {
      const total = countPlayer(c.itemId);
      bagTitle.textContent = total > 0 ? `${c.bagTitle} · ${total}` : c.bagTitle;
    }
    dock?.classList.toggle('is-ammo', c.theme === 'ammo');
    dock?.classList.toggle('is-recycle', c.theme === 'recycle');
    crateZone.classList.toggle('is-ammo', c.theme === 'ammo');
    crateZone.classList.toggle('is-recycle', c.theme === 'recycle');

    const crateInv = crateInventory();
    if (crateInv) renderInvGrid(crateGrid, crateInv, 'crate');

    bagViewInv = buildBagViewInventory(c.itemId);
    renderInvGrid(bagGrid, bagViewInv, 'bag');
    syncAmmoBottom();
  }

  /** 同步离席提示。 */
  function syncLeaveHint() {
    if (!hintDesktop) return;
    const key = window.LpInputBindings?.formatAction('interact') || 'F';
    const c = cfg();
    const title = c?.crateTitle || '箱子';
    hintDesktop.textContent = `拖拽存取${title} · ${key} 离开`;
  }

  /** 存入箱子。 */
  function deposit(qty) {
    const c = cfg();
    if (!c || qty <= 0) return 0;
    return window.LpGuardTurret?.depositItem?.(mode, qty) ?? 0;
  }

  /** 从箱子取出。 */
  function withdraw(qty) {
    const c = cfg();
    if (!c || qty <= 0) return 0;
    return window.LpGuardTurret?.withdrawItem?.(mode, qty) ?? 0;
  }

  /** 打开面板。 */
  function openPanel(nextMode) {
    if (!MODES[nextMode]) return;
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
    }
    if (window.LpInventory?.isOpen()) window.LpInventory.close();
    if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
    if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
    mode = nextMode;
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-crate-feed-open');
    window.LpTouchControls?.setEnabled(false);
    syncLeaveHint();
    render();
    const c = cfg();
    if (countPlayer(c.itemId) <= 0 && countCrate() <= 0) {
      window.LiminalInteract?.showToast?.(
        mode === 'ammo' ? '背包与弹药箱都没有弹药' : '回收箱与背包都没有弹壳'
      );
    }
  }

  /** 关闭面板。 */
  function closePanel() {
    if (!open) return;
    endDrag();
    open = false;
    mode = null;
    bagViewInv = null;
    window.LpArmedAmmo?.unmountCrateBottom?.();
    if (ammoBottom) ammoBottom.hidden = true;
    layout?.classList.remove('has-ammo-bottom');
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-crate-feed-open');
    window.LpTouchControls?.setEnabled(true);
  }

  /** 放置拖拽幽灵（紧凑方块，不按占地拉伸）。 */
  function placeGhost(clientX, clientY) {
    const c = cfg();
    const item = Catalog?.getItem?.(c?.itemId);
    const icon = ghost.querySelector('.lp-fuel-item-icon');
    if (icon && item) {
      icon.style.setProperty('--item-color', item.color);
      icon.style.setProperty('--item-accent', item.accent);
      if (item.icon) {
        icon.classList.add('has-image');
        icon.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
        icon.style.backgroundImage = '';
        icon.textContent = '';
      } else {
        icon.classList.remove('has-image');
        icon.style.removeProperty('--lp-item-icon');
        icon.style.backgroundImage = '';
        icon.textContent = item.short;
      }
    }
    ghost.hidden = false;
    ghost.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  }

  /** 结束拖拽。 */
  function endDrag() {
    if (drag?.slotEl) drag.slotEl.classList.remove('is-dragging');
    drag = null;
    ghost.hidden = true;
    crateZone.classList.remove('is-hot');
    bagRack?.classList.remove('is-hot');
    bagGrid.classList.remove('is-hot');
  }

  /** 指针是否在元素内。 */
  function overEl(el, clientX, clientY) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  /** 开始拖拽。 */
  function beginDrag(event, from, slotEl) {
    const c = cfg();
    if (!open || !c) return;
    const have = from === 'crate' ? countCrate() : countPlayer(c.itemId);
    if (have <= 0) return;
    drag = { pointerId: event.pointerId, from, slotEl };
    slotEl.classList.add('is-dragging');
    placeGhost(event.clientX, event.clientY);
    slotEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    placeGhost(event.clientX, event.clientY);
    if (drag.from === 'bag') {
      crateZone.classList.toggle('is-hot', overEl(crateZone, event.clientX, event.clientY));
      bagRack?.classList.remove('is-hot');
      bagGrid.classList.remove('is-hot');
    } else {
      const overBag = overEl(bagRack || bagGrid, event.clientX, event.clientY);
      bagRack?.classList.toggle('is-hot', overBag);
      bagGrid.classList.toggle('is-hot', overBag);
      crateZone.classList.remove('is-hot');
    }
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const c = cfg();
    const from = drag.from;
    const chunk = c?.chunk ?? 10;
    let moved = 0;
    if (from === 'bag' && overEl(crateZone, event.clientX, event.clientY)) {
      moved = deposit(Math.min(chunk, countPlayer(c.itemId)));
      if (moved > 0) {
        window.LiminalInteract?.showToast?.(`存入 ×${moved}（箱内 ${countCrate()}）`);
      }
    } else if (from === 'crate' && overEl(bagRack || bagGrid, event.clientX, event.clientY)) {
      moved = withdraw(Math.min(chunk, countCrate()));
      if (moved > 0) {
        window.LiminalInteract?.showToast?.(`取出 ×${moved}`);
      }
    }
    endDrag();
    render();
  });

  window.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag();
  });

  closeButton?.addEventListener('click', closePanel);
  window.addEventListener('lp:bindings-changed', syncLeaveHint);

  window.LpGuardCrateUi = {
    open: openPanel,
    openAmmo: () => openPanel('ammo'),
    openRecycle: () => openPanel('recycle'),
    close: closePanel,
    isOpen,
    getMode: () => mode,
    refresh: render,
  };
})();
