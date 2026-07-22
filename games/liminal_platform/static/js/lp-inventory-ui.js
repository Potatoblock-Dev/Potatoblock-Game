/**
 * 阈限月台物品栏 UI：Tab 开关、仓储双栏、点击/拖拽与 Shift 快速转移。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Catalog = window.LpItemCatalog;
  const Core = window.LpInventoryCore;
  const Bindings = window.LpInputBindings;

  const root = document.getElementById('lpInventoryRoot');
  const playerGrid = document.getElementById('lpPlayerGrid');
  const handsGrid = document.getElementById('lpHandsGrid');
  const storageGrid = document.getElementById('lpStorageGrid');
  const storagePanel = document.getElementById('lpStorageInventoryPanel');
  const playerPanel = document.getElementById('lpPlayerInventoryPanel');
  const cursorEl = document.getElementById('lpInventoryCursor');
  const settingsPanel = document.getElementById('lpInventorySettings');
  const closeButton = document.getElementById('lpInventoryClose');
  const settingsToggle = document.getElementById('lpInventorySettingsToggle');
  const detailEmpty = document.getElementById('lpInventoryDetailEmpty');
  const detailBody = document.getElementById('lpInventoryDetailBody');
  const detailIcon = document.getElementById('lpInventoryDetailIcon');
  const detailName = document.getElementById('lpInventoryDetailName');
  const detailQty = document.getElementById('lpInventoryDetailQty');
  const detailType = document.getElementById('lpInventoryDetailType');
  const detailSize = document.getElementById('lpInventoryDetailSize');
  const detailEquip = document.getElementById('lpInventoryDetailEquip');
  const detailUse = document.getElementById('lpInventoryDetailUse');

  const EQUIP_HOSTS = [
    document.getElementById('lpEquipSlot0'),
    document.getElementById('lpEquipSlot1'),
    document.getElementById('lpEquipSlot2'),
    document.getElementById('lpEquipSlot3'),
    document.getElementById('lpEquipSlot4'),
  ];

  if (!root || !playerGrid || !storageGrid || !handsGrid || EQUIP_HOSTS.some((el) => !el)) {
    return;
  }

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)');
  const { player, storage, hands, equip } = Core.loadInventories();
  const state = {
    open: false,
    inStorageCar: false,
    cursor: null,
    dragSource: null,
    dragMoved: false,
    suppressClick: false,
    pointerId: null,
    inspectPinned: false,
  };

  /** 是否触屏布局。 */
  function isCoarse() {
    return coarsePointer.matches;
  }

  /** 按 id 取库存实例。 */
  function inventoryById(id) {
    if (id === 'player') return player;
    if (id === 'storage') return storage;
    if (id === 'hands') return hands;
    if (id === 'equip') return equip;
    return null;
  }

  /** Shift 快速转移的目标库存。 */
  function shiftTarget(inventory, index) {
    if (state.inStorageCar) {
      return inventory.id === 'storage' ? player : storage;
    }
    if (inventory.id === 'hands' || inventory.id === 'equip') return player;
    if (inventory.id === 'player') {
      const stack = inventory.getSlot(index);
      const item = stack ? Catalog.getItem(stack.itemId) : null;
      if (item?.equipSlot && equip.acceptsItem(stack.itemId)) return equip;
      return hands;
    }
    return null;
  }

  /** 持久化并刷新界面。 */
  function persistAndRender() {
    Core.saveInventories(player, storage, hands, equip);
    renderGrids();
    renderCursor();
    if (state.cursor) {
      showDetail(state.cursor, { pinned: isCoarse() });
    }
  }

  /** 判断玩家是否在仓储车厢。 */
  function isInStorageCar(worldX) {
    return Spec.carriageAt(worldX)?.id === 'storage';
  }

  /** 清空详情窗。 */
  function clearDetail() {
    state.inspectPinned = false;
    if (detailEmpty) {
      detailEmpty.hidden = false;
      detailEmpty.textContent = isCoarse()
        ? '点击物品查看信息'
        : '将鼠标移到物品上查看信息';
    }
    if (detailBody) detailBody.hidden = true;
    for (const slot of root.querySelectorAll('.lp-inventory-slot.is-inspecting')) {
      slot.classList.remove('is-inspecting');
    }
  }

  /** 在内置详情窗显示堆叠信息。 */
  function showDetail(stack, options = {}) {
    const { pinned = false, slotEl = null } = options;
    if (!stack) {
      clearDetail();
      return;
    }
    const item = Catalog.getItem(stack.itemId);
    if (!item || !detailBody) {
      clearDetail();
      return;
    }

    state.inspectPinned = pinned;
    if (detailEmpty) detailEmpty.hidden = true;
    detailBody.hidden = false;

    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', item.color);
      detailIcon.style.setProperty('--item-accent', item.accent);
      detailIcon.textContent = item.short;
    }
    if (detailName) detailName.textContent = item.name;
    if (detailQty) detailQty.textContent = `×${stack.qty}`;
    if (detailType) detailType.textContent = Catalog.typeLabel(item.type);
    if (detailSize) {
      const size = Catalog.getItemSize(item.id);
      detailSize.textContent = `${size.w}×${size.h}`;
    }
    if (detailEquip) {
      detailEquip.textContent = item.equipSlot
        ? Catalog.equipSlotLabel(item.equipSlot)
        : '不可装备';
    }
    if (detailUse) detailUse.textContent = item.use || '暂无说明';

    for (const slot of root.querySelectorAll('.lp-inventory-slot.is-inspecting')) {
      slot.classList.remove('is-inspecting');
    }
    if (slotEl) slotEl.classList.add('is-inspecting');
  }

  /** 创建单个槽位 DOM。 */
  function createSlotElement(inventory, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lp-inventory-slot';
    button.dataset.inventoryId = inventory.id;
    button.dataset.slotIndex = String(index);
    button.addEventListener('click', (event) => handleSlotClick(event, inventory, index));
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      handleSlotRightClick(inventory, index);
    });
    button.addEventListener('pointerdown', (event) => beginDrag(event, inventory, index));
    button.addEventListener('pointerenter', () => {
      if (isCoarse() || state.cursor || state.dragSource) return;
      const stack = inventory.getSlot(index);
      if (stack) showDetail(stack, { slotEl: button });
    });
    button.addEventListener('pointerleave', () => {
      if (isCoarse() || state.inspectPinned || state.cursor) return;
      clearDetail();
    });
    return button;
  }

  /** 绘制槽位内容。 */
  function paintSlot(button, inventory, index) {
    const covered = inventory.isCovered(index);
    button.classList.toggle('is-covered', covered);
    button.classList.remove('is-span', 'has-item');
    button.style.removeProperty('grid-column');
    button.style.removeProperty('grid-row');
    button.replaceChildren();
    button.removeAttribute('title');
    if (covered) return;

    const origin = inventory.originIndex(index);
    if (origin !== index) return;

    const stack = inventory.getSlot(index);
    button.classList.toggle('has-item', Boolean(stack));
    if (!stack) return;

    const item = Catalog.getItem(stack.itemId);
    if (!item) return;

    const span = inventory.spanAt(index);
    if (span.w > 1 || span.h > 1) {
      button.classList.add('is-span');
      if (span.w > 1) button.style.gridColumn = `span ${span.w}`;
      if (span.h > 1) button.style.gridRow = `span ${span.h}`;
    }

    const icon = document.createElement('span');
    icon.className = 'lp-inventory-item-icon';
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    icon.textContent = item.short;

    const qty = document.createElement('span');
    qty.className = 'lp-inventory-item-qty';
    qty.textContent = stack.qty > 1 ? String(stack.qty) : '';

    button.append(icon, qty);
  }

  /** 渲染网格。 */
  function renderGrid(container, inventory) {
    container.style.setProperty('--cols', String(inventory.cols));
    if (container.childElementCount !== inventory.size()) {
      container.replaceChildren();
      for (let i = 0; i < inventory.size(); i += 1) {
        container.appendChild(createSlotElement(inventory, i));
      }
    }
    for (let i = 0; i < inventory.size(); i += 1) {
      paintSlot(container.children[i], inventory, i);
    }
  }

  /** 渲染装备人偶各槽。 */
  function renderEquipSlots() {
    for (let i = 0; i < EQUIP_HOSTS.length; i += 1) {
      const host = EQUIP_HOSTS[i];
      if (host.childElementCount !== 1) {
        host.replaceChildren(createSlotElement(equip, i));
      }
      paintSlot(host.children[0], equip, i);
    }
  }

  /** 刷新全部网格与布局。 */
  function renderGrids() {
    renderEquipSlots();
    renderGrid(handsGrid, hands);
    renderGrid(playerGrid, player);
    renderGrid(storageGrid, storage);
    root.classList.toggle('is-dual', state.inStorageCar);
    storagePanel.hidden = !state.inStorageCar;
    playerPanel.classList.toggle('is-compact', !state.inStorageCar);
  }

  /** 渲染鼠标持物光标。 */
  function renderCursor() {
    if (!state.cursor) {
      cursorEl.hidden = true;
      cursorEl.replaceChildren();
      return;
    }
    const item = Catalog.getItem(state.cursor.itemId);
    if (!item) {
      cursorEl.hidden = true;
      return;
    }
    cursorEl.hidden = false;
    cursorEl.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'lp-inventory-item-icon';
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    icon.textContent = item.short;
    const qty = document.createElement('span');
    qty.className = 'lp-inventory-item-qty';
    qty.textContent = state.cursor.qty > 1 ? String(state.cursor.qty) : '';
    cursorEl.append(icon, qty);
  }

  /** 更新光标跟随位置。 */
  function moveCursor(clientX, clientY) {
    if (!state.cursor) return;
    cursorEl.style.transform = `translate(${clientX}px, ${clientY}px)`;
  }

  /** 左键点击槽位：拾起 / 放置 / 合并；触屏单击优先查看信息。 */
  function handleSlotClick(event, inventory, index) {
    if (state.suppressClick || state.dragMoved) {
      state.suppressClick = false;
      state.dragMoved = false;
      return;
    }

    const stackBefore = inventory.getSlot(index);
    const slotEl = event.currentTarget;

    // 触屏：空手单击有物品 → 查看信息；再点同一格则拾起；拖拽仍可转移
    if (isCoarse() && !state.cursor && stackBefore && !event.shiftKey) {
      const already =
        state.inspectPinned &&
        slotEl.classList.contains('is-inspecting');
      if (!already) {
        showDetail(stackBefore, { pinned: true, slotEl });
        return;
      }
    }

    if (event.shiftKey) {
      const other = shiftTarget(inventory, index);
      if (other) {
        Core.quickTransfer(inventory, index, other);
        persistAndRender();
        if (stackBefore) showDetail(stackBefore, { pinned: isCoarse() });
      }
      return;
    }

    if (!state.cursor) {
      const taken = inventory.takeSlot(index);
      if (taken) {
        state.cursor = taken;
        showDetail(taken, { pinned: isCoarse(), slotEl });
      }
      persistAndRender();
      return;
    }

    const returned = Core.placeOnSlot(inventory, index, state.cursor);
    state.cursor = returned;
    persistAndRender();
    if (returned) showDetail(returned, { pinned: isCoarse() });
    else if (isCoarse()) clearDetail();
  }

  /** 右键分堆：拾起一半或放置一个（不交换异类）。 */
  function handleSlotRightClick(inventory, index) {
    if (state.dragSource) return;
    const origin = inventory.originIndex(index);

    if (!state.cursor) {
      const stack = inventory.getSlot(origin);
      if (!stack) return;
      const half = Math.ceil(stack.qty / 2);
      if (half >= stack.qty) {
        state.cursor = inventory.takeSlot(origin);
      } else {
        inventory.slots[origin].qty = stack.qty - half;
        state.cursor = { itemId: stack.itemId, qty: half };
      }
      persistAndRender();
      return;
    }

    const current = inventory.getSlot(origin);
    if (current && current.itemId !== state.cursor.itemId) return;

    const returned = Core.placeOnSlot(inventory, origin, {
      itemId: state.cursor.itemId,
      qty: 1,
    });
    if (returned === null) {
      state.cursor = {
        itemId: state.cursor.itemId,
        qty: state.cursor.qty - 1,
      };
      if (state.cursor.qty <= 0) state.cursor = null;
    }
    persistAndRender();
  }

  /** 开始拖拽槽位（有位移才真正转移，避免与 click 冲突）。 */
  function beginDrag(event, inventory, index) {
    if (event.button !== 0 || state.cursor) return;
    const origin = inventory.originIndex(index);
    const stack = inventory.getSlot(origin);
    if (!stack) return;
    state.dragSource = {
      inventory,
      index: origin,
      startX: event.clientX,
      startY: event.clientY,
    };
    state.dragMoved = false;
    state.pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** 拖拽过程中检测是否离开原槽。 */
  function onPointerMove(event) {
    if (state.cursor) moveCursor(event.clientX, event.clientY);
    if (!state.dragSource) return;
    const dx = event.clientX - state.dragSource.startX;
    const dy = event.clientY - state.dragSource.startY;
    if (Math.hypot(dx, dy) > 8) state.dragMoved = true;
  }

  /** 结束拖拽到目标槽。 */
  function finishDrag(event) {
    if (!state.dragSource) return;
    const source = state.dragSource;
    const didMove = state.dragMoved;
    state.dragSource = null;
    state.pointerId = null;

    if (!didMove) return;

    state.suppressClick = true;
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest?.('.lp-inventory-slot');
    if (!target) return;

    const targetInventory = inventoryById(target.dataset.inventoryId);
    if (!targetInventory) return;
    const targetIndex = Number(target.dataset.slotIndex);
    if (targetInventory === source.inventory && targetIndex === source.index) return;

    const moving = source.inventory.takeSlot(source.index);
    if (!moving) return;
    const returned = Core.placeOnSlot(targetInventory, targetIndex, moving);
    if (returned) {
      source.inventory.placeStack(source.index, returned);
    }
    persistAndRender();
  }

  /** 关闭时把手上物品退回背包。 */
  function returnCursorToPlayer() {
    if (!state.cursor) return;
    const leftover = player.addItem(state.cursor.itemId, state.cursor.qty);
    if (leftover > 0) {
      storage.addItem(state.cursor.itemId, leftover);
    }
    state.cursor = null;
  }

  /** 打开物品栏。 */
  function open(worldX) {
    state.inStorageCar = isInStorageCar(worldX);
    state.open = true;
    root.hidden = false;
    root.classList.toggle('is-dual', state.inStorageCar);
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-inventory-open');
    window.LpTouchControls?.setEnabled(false);
    clearDetail();
    renderGrids();
    Bindings.renderBindings?.();
  }

  /** 关闭物品栏。 */
  function close() {
    returnCursorToPlayer();
    state.open = false;
    state.inStorageCar = false;
    state.dragSource = null;
    state.dragMoved = false;
    root.hidden = true;
    root.classList.remove('is-dual');
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-inventory-open');
    settingsPanel.hidden = true;
    storagePanel.hidden = true;
    clearDetail();
    window.LpTouchControls?.setEnabled(true);
    persistAndRender();
  }

  /** 切换物品栏。 */
  function toggle(worldX) {
    if (state.open) {
      close();
      return;
    }
    open(worldX);
  }

  /** 物品栏是否打开。 */
  function isOpen() {
    return state.open;
  }

  /** 扣除物品并保存（优先手部，再背包；供锅炉等系统调用）。 */
  function consumeItem(itemId, qty) {
    let need = qty;
    let removed = 0;
    if (need > 0) {
      const fromHands = hands.removeItem(itemId, need);
      removed += fromHands;
      need -= fromHands;
    }
    if (need > 0) {
      removed += player.removeItem(itemId, need);
    }
    if (removed > 0) persistAndRender();
    return removed;
  }

  closeButton?.addEventListener('click', close);
  root.querySelector('.lp-inventory-backdrop')?.addEventListener('click', close);
  settingsToggle?.addEventListener('click', () => {
    settingsPanel.hidden = !settingsPanel.hidden;
  });

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', finishDrag);
  document.addEventListener('pointercancel', finishDrag);
  window.addEventListener('lp:bindings-changed', () => Bindings.renderBindings?.());

  window.LpInventory = {
    open,
    close,
    toggle,
    isOpen,
    getPlayerInventory: () => player,
    getStorageInventory: () => storage,
    getHandsInventory: () => hands,
    getEquipInventory: () => equip,
    consumeItem,
    persistAndRender,
  };

  renderGrids();
  window.LpInputBindings?.renderBindings?.();
})();
