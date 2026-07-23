/**
 * 阈限月台物品栏 UI：Tab 开关、仓储双栏、点击/拖拽与 Shift 快速转移。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Catalog = window.LpItemCatalog;
  const Core = window.LpInventoryCore;
  const Bindings = window.LpInputBindings;
  const Entity = window.AvatarEntity;

  const root = document.getElementById('lpInventoryRoot');
  const playerGrid = document.getElementById('lpPlayerGrid');
  const groundGrid = document.getElementById('lpGroundGrid');
  const storageGrid = document.getElementById('lpStorageGrid');
  const sideLootPanel = document.getElementById('lpSideLootPanel');
  const groundSection = document.getElementById('lpGroundSection');
  const storageSection = document.getElementById('lpStorageSection');
  const sideLootDivider = document.getElementById('lpSideLootDivider');
  const handsHosts = [0, 1, 2].map((i) => document.getElementById(`lpHandsSlot${i}`));
  const playerPanel = document.getElementById('lpPlayerInventoryPanel');
  const cursorEl = document.getElementById('lpInventoryCursor');
  const settingsPanel = document.getElementById('lpInventorySettings');
  const closeButton = document.getElementById('lpInventoryClose');
  const settingsToggle = document.getElementById('lpInventorySettingsToggle');
  const tabsNav = document.getElementById('lpInventoryTabs');
  const detailPanel = document.getElementById('lpInventoryDetail');
  const detailEmpty = document.getElementById('lpInventoryDetailEmpty');
  const detailBody = document.getElementById('lpInventoryDetailBody');
  const detailIcon = document.getElementById('lpInventoryDetailIcon');
  const detailName = document.getElementById('lpInventoryDetailName');
  const detailQty = document.getElementById('lpInventoryDetailQty');
  const detailType = document.getElementById('lpInventoryDetailType');
  const detailSize = document.getElementById('lpInventoryDetailSize');
  const detailEquip = document.getElementById('lpInventoryDetailEquip');
  const detailUse = document.getElementById('lpInventoryDetailUse');
  const equipPreview = document.getElementById('lpEquipPreview');
  const hintEl = document.getElementById('lpInventoryHint');

  const EQUIP_HOSTS = [
    document.getElementById('lpEquipSlot0'),
    document.getElementById('lpEquipSlot1'),
    document.getElementById('lpEquipSlot2'),
    document.getElementById('lpEquipSlot3'),
    document.getElementById('lpEquipSlot4'),
    document.getElementById('lpEquipSlot5'),
  ];

  if (
    !root ||
    !playerGrid ||
    !storageGrid ||
    !groundGrid ||
    !sideLootPanel ||
    !groundSection ||
    !storageSection ||
    !sideLootDivider ||
    handsHosts.some((el) => !el) ||
    EQUIP_HOSTS.some((el) => !el)
  ) {
    return;
  }

  const coarsePointer = window.matchMedia('(hover: none), (pointer: coarse)');
  const loaded = Core.loadInventories();
  const { player, storage, hands, equip } = loaded;
  const state = {
    open: false,
    inStorageCar: false,
    openWorldX: 0,
    groundPile: null,
    groundInv: null,
    cursor: null,
    dragSource: null,
    dragMoved: false,
    suppressClick: false,
    pointerId: null,
    inspectPinned: false,
    /** 移动端分区：bag | gear | nearby */
    mobileTab: 'bag',
    /** 持物悬停格，供 render 后重绘占地预览 */
    hoverSlot: null,
    previewRaf: 0,
    previewLastTs: 0,
  };

  /** 开局溢出：等主循环给出坐标后再丢地面。 */
  let pendingSeedOverflow = loaded.seedOverflow || loaded.overflow || null;

  const previewEntity = Entity?.createAvatarEntity
    ? Entity.createAvatarEntity({ nickname: '' })
    : null;

  /** 从场上角色同步皮套到装备预览实体（站立 idle）。 */
  function syncEquipPreviewEntity(source) {
    if (!previewEntity || !source) return;
    previewEntity.uvAtlas = source.uvAtlas;
    previewEntity.texture = source.texture;
    previewEntity.heightScale = source.heightScale;
    previewEntity.appearanceKey = source.appearanceKey;
    previewEntity.facing = 1;
    previewEntity.vx = 0;
    previewEntity.vy = 0;
    previewEntity.moveDirection = 0;
    previewEntity.onGround = true;
    previewEntity.kneel = 0;
    previewEntity.gait = 'walk';
    previewEntity.headLook = 0;
    previewEntity.headLookVelocity = 0;
    previewEntity.nickname = '';
  }

  /** 在装备栏中间画玩家皮套。 */
  function paintEquipPreview(dt) {
    if (!equipPreview || !Entity?.drawAvatar || !previewEntity) return;
    const source = window.LpGame?.getLocalAvatar?.();
    if (!source) return;

    syncEquipPreviewEntity(source);
    if (typeof dt === 'number' && dt > 0) {
      Entity.updateEntityMotion(previewEntity, dt);
    }

    const cssW = Math.max(1, equipPreview.clientWidth || 120);
    const cssH = Math.max(1, equipPreview.clientHeight || 220);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.round(cssW * dpr);
    const pixelH = Math.round(cssH * dpr);
    if (equipPreview.width !== pixelW || equipPreview.height !== pixelH) {
      equipPreview.width = pixelW;
      equipPreview.height = pixelH;
    }

    const ctx = equipPreview.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const size = Entity.AVATAR_SIZE || 72;
    const drawScale = Entity.AVATAR_DRAW_SCALE || 1.35;
    const visualH = size * drawScale * previewEntity.heightScale;
    previewEntity.x = cssW * 0.5;
    previewEntity.y = Math.min(cssH * 0.78, cssH * 0.5 + visualH * 0.42);

    const fit = Math.min(1, (cssH * 0.86) / visualH, (cssW * 0.92) / (size * drawScale));
    ctx.save();
    ctx.translate(previewEntity.x, previewEntity.y);
    ctx.scale(fit, fit);
    ctx.translate(-previewEntity.x, -previewEntity.y);
    Entity.drawAvatar(ctx, previewEntity, { zoom: 1, offsetX: 0, offsetY: 0 }, dpr);
    ctx.restore();
  }

  /** 物品栏打开时循环刷新装备皮套预览。 */
  function startEquipPreviewLoop() {
    if (!equipPreview || state.previewRaf) return;
    state.previewLastTs = 0;
    const tick = (ts) => {
      if (!state.open) {
        state.previewRaf = 0;
        state.previewLastTs = 0;
        return;
      }
      if (!state.previewLastTs) state.previewLastTs = ts;
      const dt = Math.min((ts - state.previewLastTs) / 1000, 0.05);
      state.previewLastTs = ts;
      paintEquipPreview(dt);
      state.previewRaf = requestAnimationFrame(tick);
    };
    state.previewRaf = requestAnimationFrame(tick);
  }

  /** 停止装备皮套预览循环。 */
  function stopEquipPreviewLoop() {
    if (state.previewRaf) {
      cancelAnimationFrame(state.previewRaf);
      state.previewRaf = 0;
    }
    state.previewLastTs = 0;
  }

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
    if (id === 'ground' || id === state.groundInv?.id) return state.groundInv;
    return null;
  }

  /** Shift 快速转移的目标库存。 */
  function shiftTarget(inventory, index) {
    if (inventory?.id?.startsWith?.('ground') || inventory === state.groundInv) {
      return player;
    }
    if (state.groundInv && inventory.id === 'player') {
      return state.groundInv;
    }
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

  /** 是否显示附近侧栏（地面或仓库）。 */
  function hasSideLoot() {
    return Boolean(state.groundInv) || state.inStorageCar;
  }

  /** 同步附近侧栏（地面 / 仓库共用，可同时显示并以分割线隔开）。 */
  function syncSideLootPanel(worldX = state.openWorldX) {
    const pile = window.LpGroundLoot?.getNearbyPile?.(worldX) || null;
    state.groundPile = pile;
    state.groundInv = pile?.inv || null;
    const showGround = Boolean(state.groundInv);
    const showStorage = state.inStorageCar;
    const showSide = showGround || showStorage;

    groundSection.hidden = !showGround;
    storageSection.hidden = !showStorage;
    sideLootDivider.hidden = !(showGround && showStorage);
    sideLootPanel.hidden = !showSide;
    root.classList.toggle('is-side-loot', showSide);

    const nearbyTab = tabsNav?.querySelector('[data-lp-inv-tab="nearby"]');
    if (nearbyTab) nearbyTab.hidden = !showSide;
    if (!showSide && state.mobileTab === 'nearby') state.mobileTab = 'bag';
  }

  /** 绑定附近地面堆并刷新面板显隐。 */
  function syncGroundPanel(worldX = state.openWorldX) {
    syncSideLootPanel(worldX);
  }

  /** 装备变更后同步背包容量，溢出丢地面。 */
  function applyBagCapacity(worldX = state.openWorldX) {
    const dropped = Core.syncPlayerBagToEquip(player, equip);
    if (dropped.length) {
      window.LpGroundLoot?.dropStacks?.(worldX, dropped);
      if (dropped.length === 1) {
        window.LiminalInteract?.showToast?.(
          `背包空间不足，${Catalog.getItem(dropped[0].itemId)?.name || '物品'}掉在地上`
        );
      } else {
        window.LiminalInteract?.showToast?.(`背包空间不足，${dropped.length} 件物品掉在地上`);
      }
    }
    syncGroundPanel(worldX);
  }

  /** 持久化并刷新界面。 */
  function persistAndRender() {
    applyBagCapacity();
    Core.saveInventories(player, storage, hands, equip);
    window.LpGroundLoot?.pruneAndSave?.();
    renderGrids();
    renderCursor();
    window.LpHandsHud?.render?.();
    if (state.hoverSlot) {
      applyPlacePreview(state.hoverSlot.inventory, state.hoverSlot.index);
    } else {
      clearPlacePreview();
    }
    updateInventoryHint();
    if (state.cursor) {
      showDetail(state.cursor, { pinned: isCoarse() });
    } else if (!isCoarse()) {
      /* 桌面悬停态由 pointerenter 负责 */
    } else if (!state.inspectPinned) {
      clearDetail();
    }
  }

  /** 判断玩家是否在仓储车厢。 */
  function isInStorageCar(worldX) {
    return Spec.carriageAt(worldX)?.id === 'storage';
  }

  /** 清空详情窗（未选中时整块隐藏）。 */
  function clearDetail() {
    state.inspectPinned = false;
    if (detailPanel) {
      detailPanel.hidden = true;
      detailPanel.style.transform = '';
    }
    if (detailEmpty) detailEmpty.hidden = true;
    if (detailBody) detailBody.hidden = true;
    for (const slot of root.querySelectorAll('.lp-inventory-slot.is-inspecting')) {
      slot.classList.remove('is-inspecting');
    }
  }

  /** 桌面：把详情弹窗钉在鼠标旁（不挡指针）。 */
  function positionDetailPopup(clientX, clientY) {
    if (!detailPanel || isCoarse() || detailPanel.hidden) return;
    const pad = 12;
    const offset = 18;
    const rect = detailPanel.getBoundingClientRect();
    let left = clientX + offset;
    let top = clientY + offset;
    if (left + rect.width > window.innerWidth - pad) {
      left = clientX - rect.width - offset;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    detailPanel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** 显示物品详情；桌面跟随鼠标，移动端停靠底部。 */
  function showDetail(stack, options = {}) {
    const { pinned = false, slotEl = null, clientX = null, clientY = null } = options;
    if (!stack) {
      clearDetail();
      return;
    }
    const item = Catalog.getItem(stack.itemId);
    if (!item || !detailBody || !detailPanel) {
      clearDetail();
      return;
    }

    state.inspectPinned = pinned;
    detailPanel.hidden = false;
    if (detailEmpty) detailEmpty.hidden = true;
    detailBody.hidden = false;

    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', item.color);
      detailIcon.style.setProperty('--item-accent', item.accent);
      if (item.icon) {
        detailIcon.classList.add('has-image');
        detailIcon.style.backgroundImage = `url("${item.icon}")`;
        detailIcon.textContent = '';
      } else {
        detailIcon.classList.remove('has-image');
        detailIcon.style.backgroundImage = '';
        detailIcon.textContent = item.short;
      }
    }
    if (detailName) detailName.textContent = item.name;
    if (detailQty) {
      detailQty.textContent =
        item.magazineSize != null
          ? `弹匣 ${stack.mag ?? 0}/${item.magazineSize}`
          : `×${stack.qty}`;
    }
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

    if (!isCoarse() && clientX != null && clientY != null) {
      // 先清零再量宽高，避免沿用旧 transform
      detailPanel.style.transform = 'translate(-9999px, -9999px)';
      requestAnimationFrame(() => positionDetailPopup(clientX, clientY));
    } else if (!isCoarse()) {
      detailPanel.style.transform = '';
    }
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
    button.addEventListener('pointerenter', (event) => {
      if (isCoarse() || state.cursor || state.dragSource) return;
      const stack = inventory.getSlot(index);
      if (stack) {
        showDetail(stack, {
          slotEl: button,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
    });
    button.addEventListener('pointermove', (event) => {
      if (isCoarse() || state.cursor || state.dragSource || detailPanel?.hidden) return;
      positionDetailPopup(event.clientX, event.clientY);
    });
    button.addEventListener('pointerleave', () => {
      if (isCoarse() || state.inspectPinned || state.cursor) return;
      clearDetail();
    });
    return button;
  }

  /** 绘制槽位内容；多格物品用 grid 真实占格，图标铺满当前格子尺寸。 */
  function paintSlot(button, inventory, index) {
    const covered = inventory.isCovered(index);
    const { col, row } = inventory.coordsOf(index);
    button.classList.toggle('is-covered', covered);
    button.classList.remove('is-span', 'has-item', 'place-ok', 'place-bad', 'place-merge');
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
      icon.style.backgroundImage = `url("${item.icon}")`;
      icon.textContent = '';
    } else {
      icon.textContent = item.short;
    }

    const qty = document.createElement('span');
    qty.className = 'lp-inventory-item-qty';
    if (item.magazineSize != null) {
      qty.textContent = `${stack.mag ?? 0}/${item.magazineSize}`;
    } else {
      qty.textContent = stack.qty > 1 ? String(stack.qty) : '';
    }

    button.append(icon, qty);
  }

  /** 取某网格的槽位按钮列表。 */
  function slotButtonsFor(inventory) {
    if (inventory === player) return Array.from(playerGrid.querySelectorAll('.lp-inventory-slot'));
    if (inventory === storage) return Array.from(storageGrid.querySelectorAll('.lp-inventory-slot'));
    if (inventory === hands) {
      return handsHosts.map((host) => host.querySelector('.lp-inventory-slot')).filter(Boolean);
    }
    if (inventory === equip) {
      return EQUIP_HOSTS.map((host) => host.querySelector('.lp-inventory-slot')).filter(Boolean);
    }
    if (inventory === state.groundInv && groundGrid) {
      return Array.from(groundGrid.querySelectorAll('.lp-inventory-slot'));
    }
    return [];
  }

  /** 当前用于占地预览的手持堆叠（光标或拖拽中）。 */
  function heldStackForPreview() {
    if (state.cursor) return state.cursor;
    if (state.dragSource && state.dragMoved) {
      return state.dragSource.inventory.getSlot(state.dragSource.index);
    }
    return null;
  }

  /** 放置预览时忽略的原点（同网格拖拽源）。 */
  function ignoreOriginFor(inventory) {
    if (!state.dragSource || state.dragSource.inventory !== inventory) return -1;
    return state.dragSource.index;
  }

  /** 清除占地预览高亮。 */
  function clearPlacePreview() {
    root.querySelectorAll('.lp-inventory-slot.place-ok, .lp-inventory-slot.place-bad, .lp-inventory-slot.place-merge').forEach((el) => {
      el.classList.remove('place-ok', 'place-bad', 'place-merge');
    });
  }

  /** 给指定格子加上预览类名（占位格已隐藏时改标原点）。 */
  function paintPreviewCells(inventory, cells, className) {
    if (!cells) return;
    const buttons = slotButtonsFor(inventory);
    const marked = new Set();
    for (const idx of cells) {
      if (idx < 0 || idx >= buttons.length) continue;
      let target = idx;
      const btn = buttons[idx];
      if (btn.hidden || btn.classList.contains('is-covered')) {
        target = inventory.originIndex(idx);
      }
      if (target < 0 || target >= buttons.length || marked.has(target)) continue;
      marked.add(target);
      buttons[target].classList.add(className);
    }
  }

  /** 根据当前手持物与悬停格绘制占地预览。 */
  function applyPlacePreview(inventory, hoverIndex) {
    clearPlacePreview();
    const held = heldStackForPreview();
    if (!held || !inventory || hoverIndex == null || hoverIndex < 0) return;

    const size = Catalog.getItemSize(held.itemId);
    const item = Catalog.getItem(held.itemId);
    if (!item) return;
    const ignoreOrigin = ignoreOriginFor(inventory);

    if (inventory === equip || inventory === hands) {
      const existing = inventory.getSlot(hoverIndex);
      let mode = 'place-bad';
      if (size.w === 1 && size.h === 1) {
        if (!inventory.acceptsItem(held.itemId, hoverIndex)) mode = 'place-bad';
        else if (!existing || ignoreOrigin === hoverIndex) mode = 'place-ok';
        else if (existing.itemId === held.itemId && existing.qty < item.stack) mode = 'place-merge';
        else mode = 'place-merge';
      }
      paintPreviewCells(inventory, [hoverIndex], mode);
      return;
    }

    const originOfHover = inventory.originIndex(hoverIndex);
    const existing = inventory.getSlot(originOfHover);
    const hoveringOccupied =
      existing &&
      ignoreOrigin !== originOfHover &&
      (inventory.isCovered(hoverIndex) || originOfHover === hoverIndex);

    if (hoveringOccupied) {
      const cells = inventory.footprint(originOfHover, existing.itemId);
      if (existing.itemId === held.itemId && existing.qty < item.stack) {
        paintPreviewCells(inventory, cells, 'place-merge');
        return;
      }
      const canSwap = inventory.canPlaceAt(originOfHover, held.itemId, originOfHover);
      paintPreviewCells(inventory, cells, canSwap ? 'place-merge' : 'place-bad');
      return;
    }

    const cells = inventory.footprint(hoverIndex, held.itemId);
    const ok = Boolean(cells) && inventory.canPlaceAt(hoverIndex, held.itemId, ignoreOrigin);
    if (!cells) {
      const { col, row } = inventory.coordsOf(hoverIndex);
      const clipped = [];
      for (let dy = 0; dy < size.h; dy += 1) {
        for (let dx = 0; dx < size.w; dx += 1) {
          const idx = inventory.indexAt(col + dx, row + dy);
          if (idx >= 0) clipped.push(idx);
        }
      }
      paintPreviewCells(inventory, clipped, 'place-bad');
      return;
    }
    paintPreviewCells(inventory, cells, ok ? 'place-ok' : 'place-bad');
  }

  /** 按指针位置刷新占地预览。 */
  function refreshPlacePreviewFromPoint(clientX, clientY) {
    if (!heldStackForPreview()) {
      clearPlacePreview();
      state.hoverSlot = null;
      return;
    }
    const target = document.elementFromPoint(clientX, clientY)?.closest?.('.lp-inventory-slot');
    if (!target || !root.contains(target)) {
      clearPlacePreview();
      state.hoverSlot = null;
      return;
    }
    const inv = inventoryById(target.dataset.inventoryId);
    const index = Number(target.dataset.slotIndex);
    if (!inv || Number.isNaN(index)) {
      clearPlacePreview();
      state.hoverSlot = null;
      return;
    }
    state.hoverSlot = { inventory: inv, index };
    applyPlacePreview(inv, index);
  }

  /** 渲染网格。 */
  function renderGrid(container, inventory) {
    container.style.setProperty('--cols', String(inventory.cols));
    container.style.setProperty('--rows', String(inventory.rows));
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

  /** 渲染手部三槽。 */
  function renderHandsSlots() {
    for (let i = 0; i < handsHosts.length; i += 1) {
      const host = handsHosts[i];
      if (host.childElementCount !== 1) {
        host.replaceChildren(createSlotElement(hands, i));
      }
      paintSlot(host.children[0], hands, i);
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
    renderHandsSlots();
    renderGrid(playerGrid, player);
    renderGrid(storageGrid, storage);
    if (state.groundInv) {
      renderGrid(groundGrid, state.groundInv);
    } else {
      groundGrid.replaceChildren();
    }
    syncSideLootPanel();
    playerPanel.classList.toggle('is-compact', !hasSideLoot());
    syncMobileChrome();
  }

  /** 按端与当前分区更新底栏操作提示。 */
  function updateInventoryHint() {
    if (!hintEl) return;
    if (!isCoarse()) {
      hintEl.textContent = '拖拽移动 · Shift+点击快速转移 · Tab 关闭';
      return;
    }
    if (state.cursor) {
      hintEl.textContent = hasSideLoot()
        ? '持物中：点空位放置，或切换「背包 / 附近」转移'
        : '持物中：点空位放置，切到「人物」可装装备/手部';
      return;
    }
    if (state.mobileTab === 'gear') {
      hintEl.textContent = '点选查看 · 再点拾起 · 点格子穿戴或到手部';
      return;
    }
    if (state.mobileTab === 'nearby') {
      hintEl.textContent = '点选拾起 · 切到「背包」放入随身或仓库';
      return;
    }
    hintEl.textContent = '点选查看 · 再点拾起 · 拖到其他格移动';
  }

  /** 同步移动端顶栏分区与当前面板。 */
  function syncMobileChrome() {
    const mobile = isCoarse();
    root.classList.toggle('is-mobile-inv', mobile);
    if (tabsNav) tabsNav.hidden = !mobile;

    const nearbyTab = tabsNav?.querySelector('[data-lp-inv-tab="nearby"]');
    if (nearbyTab) nearbyTab.hidden = !hasSideLoot();

    if (!mobile) {
      root.dataset.lpInvTab = '';
      updateInventoryHint();
      return;
    }

    if (!hasSideLoot() && state.mobileTab === 'nearby') {
      state.mobileTab = 'bag';
    }
    root.dataset.lpInvTab = state.mobileTab;
    for (const btn of tabsNav?.querySelectorAll('[data-lp-inv-tab]') || []) {
      btn.classList.toggle('is-active', btn.dataset.lpInvTab === state.mobileTab);
    }
    updateInventoryHint();
  }

  /** 切换移动端分区。 */
  function setMobileTab(tab) {
    if (tab === 'nearby' && !hasSideLoot()) return;
    if (tab === 'storage' || tab === 'ground') {
      tab = 'nearby';
    }
    state.mobileTab = tab;
    syncMobileChrome();
  }

  /** 持物光标单格边长（优先跟随当前悬停网格，否则背包格）。 */
  function cursorCellPx() {
    const hoverInv = state.hoverSlot?.inventory;
    let probe = null;
    if (hoverInv === storage) probe = storageGrid?.querySelector('.lp-inventory-slot:not([hidden])');
    else if (hoverInv === state.groundInv) probe = groundGrid?.querySelector('.lp-inventory-slot:not([hidden])');
    else if (hoverInv === player) probe = playerGrid?.querySelector('.lp-inventory-slot:not([hidden])');
    if (!probe) probe = playerGrid?.querySelector('.lp-inventory-slot:not([hidden])');
    const w = probe?.getBoundingClientRect?.().width;
    return w > 8 ? w : 44;
  }

  /** 光标幽灵用的堆叠：点击持物或拖拽中。 */
  function heldGhostStack() {
    if (state.cursor) return state.cursor;
    if (state.dragSource && state.dragMoved) {
      return state.dragSource.inventory.getSlot(state.dragSource.index);
    }
    return null;
  }

  /** 拖拽源格半透明，表示物品已提起。 */
  function syncDragSourceVisual() {
    root
      .querySelectorAll('.lp-inventory-slot.is-dragging')
      .forEach((el) => el.classList.remove('is-dragging'));
    if (!state.dragSource || !state.dragMoved) return;
    const buttons = slotButtonsFor(state.dragSource.inventory);
    const btn = buttons[state.dragSource.index];
    btn?.classList.add('is-dragging');
  }

  /** 渲染鼠标持物 / 拖拽幽灵（按物品占格缩放）。 */
  function renderCursor() {
    const stack = heldGhostStack();
    if (!stack) {
      cursorEl.hidden = true;
      cursorEl.replaceChildren();
      cursorEl.style.width = '';
      cursorEl.style.height = '';
      cursorEl.style.margin = '';
      cursorEl.classList.remove('is-span');
      return;
    }
    const item = Catalog.getItem(stack.itemId);
    if (!item) {
      cursorEl.hidden = true;
      return;
    }
    const size = Catalog.getItemSize(item.id);
    const cell = cursorCellPx();
    const width = cell * size.w;
    const height = cell * size.h;
    cursorEl.hidden = false;
    cursorEl.classList.toggle('is-span', size.w > 1 || size.h > 1);
    cursorEl.style.width = `${width}px`;
    cursorEl.style.height = `${height}px`;
    cursorEl.style.margin = `${-height / 2}px 0 0 ${-width / 2}px`;
    cursorEl.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'lp-inventory-item-icon';
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    if (item.icon) {
      icon.classList.add('has-image');
      icon.style.backgroundImage = `url("${item.icon}")`;
      icon.textContent = '';
    } else {
      icon.textContent = item.short;
    }
    const qty = document.createElement('span');
    qty.className = 'lp-inventory-item-qty';
    if (item.magazineSize != null) {
      qty.textContent = `${stack.mag ?? 0}/${item.magazineSize}`;
    } else {
      qty.textContent = stack.qty > 1 ? String(stack.qty) : '';
    }
    cursorEl.append(icon, qty);
  }

  /** 更新光标跟随位置；桌面详情弹窗同步跟鼠标。 */
  function moveCursor(clientX, clientY) {
    if (heldGhostStack()) {
      cursorEl.style.transform = `translate(${clientX}px, ${clientY}px)`;
    }
    if (!isCoarse() && state.cursor && detailPanel && !detailPanel.hidden) {
      positionDetailPopup(clientX, clientY);
    }
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
        showDetail(stackBefore, {
          pinned: true,
          slotEl,
          clientX: event.clientX,
          clientY: event.clientY,
        });
        return;
      }
    }

    if (event.shiftKey) {
      const other = shiftTarget(inventory, index);
      if (other) {
        Core.quickTransfer(inventory, index, other);
        persistAndRender();
        if (stackBefore) {
          showDetail(stackBefore, {
            pinned: isCoarse(),
            clientX: event.clientX,
            clientY: event.clientY,
          });
        }
      }
      return;
    }

    if (!state.cursor) {
      const taken = inventory.takeSlot(index);
      if (taken) {
        state.cursor = taken;
        showDetail(taken, {
          pinned: isCoarse(),
          slotEl,
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }
      persistAndRender();
      return;
    }

    const returned = Core.placeOnSlot(inventory, index, state.cursor);
    state.cursor = returned;
    persistAndRender();
    if (returned) {
      showDetail(returned, {
        pinned: isCoarse(),
        clientX: event.clientX,
        clientY: event.clientY,
      });
    } else if (isCoarse()) clearDetail();
    else clearDetail();
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

  /** 拖拽过程中检测是否离开原槽；持物/拖拽时刷新占地预览与跟随幽灵。 */
  function onPointerMove(event) {
    if (state.dragSource) {
      const dx = event.clientX - state.dragSource.startX;
      const dy = event.clientY - state.dragSource.startY;
      if (!state.dragMoved && Math.hypot(dx, dy) > 8) {
        state.dragMoved = true;
        clearDetail();
        renderCursor();
        syncDragSourceVisual();
      }
    }
    if (state.cursor || (state.dragSource && state.dragMoved)) {
      moveCursor(event.clientX, event.clientY);
    }
    if (state.open && (state.cursor || (state.dragSource && state.dragMoved))) {
      refreshPlacePreviewFromPoint(event.clientX, event.clientY);
    }
  }

  /** 结束拖拽到目标槽。 */
  function finishDrag(event) {
    if (!state.dragSource) return;
    const source = state.dragSource;
    const didMove = state.dragMoved;
    state.dragSource = null;
    state.pointerId = null;
    syncDragSourceVisual();
    renderCursor();
    clearPlacePreview();

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

  /** 关闭时把手上物品退回背包，塞不下则掉地上。 */
  function returnCursorToPlayer() {
    if (!state.cursor) return;
    const stack = state.cursor;
    state.cursor = null;
    const leftoverQty = player.addItem(stack.itemId, stack.qty);
    if (leftoverQty < stack.qty && stack.mag != null) {
      for (let i = 0; i < player.size(); i += 1) {
        const raw = player.slots[i];
        if (raw && raw.itemId === stack.itemId && raw.mag == null) {
          raw.mag = stack.mag;
          break;
        }
      }
    }
    if (leftoverQty > 0) {
      const drop = { itemId: stack.itemId, qty: leftoverQty };
      if (stack.mag != null) drop.mag = stack.mag;
      window.LpGroundLoot?.dropStacks?.(state.openWorldX, [drop]);
    }
  }

  /** 打开物品栏。 */
  function open(worldX) {
    flushSeedOverflow(worldX);
    state.openWorldX = worldX;
    state.inStorageCar = isInStorageCar(worldX);
    state.open = true;
    syncGroundPanel(worldX);
    state.mobileTab = hasSideLoot() ? 'nearby' : 'bag';
    root.hidden = false;
    root.classList.toggle('is-side-loot', hasSideLoot());
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-inventory-open');
    window.LpTouchControls?.setEnabled(false);
    clearDetail();
    renderGrids();
    startEquipPreviewLoop();
    Bindings.renderBindings?.();
  }

  /** 关闭物品栏。 */
  function close() {
    returnCursorToPlayer();
    applyBagCapacity(state.openWorldX);
    Core.saveInventories(player, storage, hands, equip);
    window.LpGroundLoot?.pruneAndSave?.();
    state.open = false;
    state.inStorageCar = false;
    state.groundPile = null;
    state.groundInv = null;
    state.dragSource = null;
    state.dragMoved = false;
    state.hoverSlot = null;
    state.mobileTab = 'bag';
    stopEquipPreviewLoop();
    clearPlacePreview();
    root.hidden = true;
    root.classList.remove('is-dual', 'is-ground', 'is-side-loot', 'is-mobile-inv');
    root.dataset.lpInvTab = '';
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-inventory-open');
    settingsPanel.hidden = true;
    settingsToggle?.setAttribute('aria-expanded', 'false');
    settingsToggle?.classList.remove('is-active');
    sideLootPanel.hidden = true;
    groundSection.hidden = true;
    storageSection.hidden = true;
    sideLootDivider.hidden = true;
    clearDetail();
    renderCursor();
    window.LpHandsHud?.render?.();
    window.LpTouchControls?.setEnabled(true);
  }

  /** 首次把开局溢出丢到脚边。 */
  function flushSeedOverflow(worldX) {
    if (!pendingSeedOverflow?.length) return;
    window.LpGroundLoot?.seedIfEmpty?.(worldX, pendingSeedOverflow);
    pendingSeedOverflow = null;
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
    const nextHidden = !settingsPanel.hidden;
    settingsPanel.hidden = nextHidden;
    settingsToggle.setAttribute('aria-expanded', nextHidden ? 'false' : 'true');
    settingsToggle.classList.toggle('is-active', !nextHidden);
  });
  tabsNav?.addEventListener('click', (event) => {
    const btn = event.target.closest?.('[data-lp-inv-tab]');
    if (!btn || btn.hidden) return;
    setMobileTab(btn.dataset.lpInvTab);
  });
  coarsePointer.addEventListener('change', () => {
    if (state.open) syncMobileChrome();
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
    flushSeedOverflow,
  };

  renderGrids();
  window.LpInputBindings?.renderBindings?.();
})();
