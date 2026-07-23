/**
 * 阈限月台物品栏 UI：主背包弹窗 + 左侧地面/仓库独立弹窗、拖拽与 Shift 快速转移。
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
  const sideLootFloats = document.getElementById('lpSideLootFloats');
  const groundSection = document.getElementById('lpGroundSection');
  const storageSection = document.getElementById('lpStorageSection');
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
  const inventoryShell = root?.querySelector('.lp-inventory-shell') || null;
  const inventoryFooter = inventoryShell?.querySelector('.lp-inventory-footer') || null;

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
    !sideLootFloats ||
    !groundSection ||
    !storageSection ||
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
  /** 联机时记录拾起源，关闭时原位退回（服务端尚未得知 take）。 */
  let cursorSource = null;
  /** 移动端双击旋转：记录上一次点按的槽。 */
  let lastTap = null;

  const previewEntity = Entity?.createAvatarEntity
    ? Entity.createAvatarEntity({ nickname: '' })
    : null;

  /** 给图标节点打上/去掉 90° 旋转样式。 */
  function applyIconRotation(iconEl, stack) {
    if (!iconEl) return;
    iconEl.classList.toggle('is-rotated', Core.stackRot(stack) === 90);
  }

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

  /** 在装备栏中间画玩家皮套；缓冲尺寸跟 CSS 盒走，禁止用位图属性撑高布局。 */
  function paintEquipPreview(dt) {
    if (!equipPreview || !Entity?.drawAvatar || !previewEntity) return;
    const source = window.LpGame?.getLocalAvatar?.();
    if (!source) return;

    syncEquipPreviewEntity(source);
    if (typeof dt === 'number' && dt > 0) {
      Entity.updateEntityMotion(previewEntity, dt);
    }

    const rect = equipPreview.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width) || equipPreview.clientWidth || 120);
    // 上限防止 DPR 反馈环：未约束的 canvas.height 会每帧把布局拉高
    const cssH = Math.max(
      1,
      Math.min(280, Math.round(rect.height) || equipPreview.clientHeight || 220),
    );
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

  /** 生成发给服务端的 bag 引用。 */
  function bagRef(inventory, index) {
    if (!inventory) return null;
    if (inventory === player || inventory.id === 'player') {
      return { bag: 'player', index };
    }
    if (inventory === storage || inventory.id === 'storage') {
      return { bag: 'storage', index };
    }
    if (inventory === hands || inventory.id === 'hands') {
      return { bag: 'hands', index };
    }
    if (inventory === equip || inventory.id === 'equip') {
      return { bag: 'equip', index };
    }
    if (inventory === state.groundInv || inventory?.id?.startsWith?.('ground')) {
      return {
        bag: 'ground',
        index,
        pileId: state.groundPile?.id || null,
      };
    }
    return null;
  }

  /** 联机时把本地变更同步为服务端意图。 */
  function netSend(payload) {
    if (!window.LpInventoryNet?.isActive?.()) return;
    window.LpInventoryNet.sendOp(payload);
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

  /** 是否显示左侧附近弹窗（地面或仓库）。 */
  function hasSideLoot() {
    return Boolean(state.groundInv) || state.inStorageCar;
  }

  /** 同步左侧地面 / 仓库独立弹窗显隐（可同时开）。 */
  function syncSideLootPanel(worldX = state.openWorldX) {
    const pile = window.LpGroundLoot?.getNearbyPile?.(worldX) || null;
    state.groundPile = pile;
    state.groundInv = pile?.inv || null;
    const showGround = Boolean(state.groundInv);
    const showStorage = state.inStorageCar;
    const showSide = showGround || showStorage;

    groundSection.hidden = !showGround;
    storageSection.hidden = !showStorage;
    sideLootFloats.hidden = !showSide;
    root.classList.toggle('is-side-loot', showSide);
    root.classList.toggle('is-ground-loot', showGround);
    root.classList.toggle('is-storage-loot', showStorage);

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
    if (window.LpInventoryNet?.isActive?.()) {
      syncGroundPanel(worldX);
      return;
    }
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

  /** 持久化并刷新界面（联机时跳过 localStorage，等服务端快照）。 */
  function persistAndRender() {
    applyBagCapacity();
    if (!window.LpInventoryNet?.isActive?.()) {
      // TEST_ONLY：单机取仓后补满种子物资
      Core.restoreTestInfiniteStorage?.(storage);
      Core.saveInventories(player, storage, hands, equip);
      window.LpGroundLoot?.pruneAndSave?.();
    }
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

  /** 权威快照到达后仅刷新 UI（不写盘、不改容量）。 */
  function renderAfterAuthority() {
    if (state.open) {
      syncGroundPanel(state.openWorldX);
    }
    renderGrids();
    renderCursor();
    window.LpHandsHud?.render?.();
    updateInventoryHint();
  }

  /** 快照覆盖后清空本地光标，避免与权威状态叠放。 */
  function clearCursorAfterAuthority() {
    state.cursor = null;
    cursorSource = null;
    renderCursor();
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
        detailIcon.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
        detailIcon.style.backgroundImage = '';
        detailIcon.textContent = '';
      } else {
        detailIcon.classList.remove('has-image');
        detailIcon.style.removeProperty('--lp-item-icon');
        detailIcon.style.backgroundImage = '';
        detailIcon.textContent = item.short;
      }
      applyIconRotation(detailIcon, stack);
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
      const size = Core.orientedSize(item.id, Core.stackRot(stack));
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

  /**
   * 拖拽已提起时，源足迹格是否应画成空位（数据仍留在 inventory，仅视觉腾空）。
   * 避免多格物品的 is-span 在提起后仍盖住原点格。
   */
  function isDragVacatedCell(inventory, index) {
    if (!state.dragSource || !state.dragMoved) return false;
    if (state.dragSource.inventory !== inventory) return false;
    const origin = state.dragSource.index;
    const stack = inventory.getSlot(origin);
    if (!stack) return false;
    const cells = inventory.footprint(origin, stack.itemId, Core.stackRot(stack));
    return Boolean(cells && cells.includes(index));
  }

  /** 绘制槽位内容；多格物品用 grid 真实占格，图标铺满当前格子尺寸。 */
  function paintSlot(button, inventory, index) {
    const vacated = isDragVacatedCell(inventory, index);
    const covered = !vacated && inventory.isCovered(index);
    const { col, row } = inventory.coordsOf(index);
    button.classList.toggle('is-covered', covered);
    button.classList.remove(
      'is-span',
      'has-item',
      'is-dragging',
      'place-ok',
      'place-bad',
      'place-merge',
      'reload-ok',
      'reload-bad'
    );
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
    // 提起拖拽时足迹按空位画，避免原点仍显示占用高亮。
    const stack = vacated ? null : inventory.getSlot(index);
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
      icon.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
      icon.style.backgroundImage = '';
      icon.textContent = '';
    } else {
      icon.textContent = item.short;
    }
    applyIconRotation(icon, stack);

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
    root
      .querySelectorAll(
        '.lp-inventory-slot.place-ok, .lp-inventory-slot.place-bad, .lp-inventory-slot.place-merge, .lp-inventory-slot.reload-ok, .lp-inventory-slot.reload-bad'
      )
      .forEach((el) => {
        el.classList.remove('place-ok', 'place-bad', 'place-merge', 'reload-ok', 'reload-bad');
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

  /**
   * 若手持弹药悬停在带弹匣武器上，绘制绿/红装填预览并返回 true。
   * 匹配规则：Catalog.weaponAcceptsAmmo（weapon.ammoId === ammo.id）。
   */
  function tryPaintAmmoReloadPreview(inventory, hoverIndex, held) {
    if (!held || !inventory || hoverIndex == null || hoverIndex < 0) return false;
    const heldItem = Catalog.getItem(held.itemId);
    if (!heldItem || heldItem.type !== 'ammo') return false;

    const origin = inventory.originIndex(hoverIndex);
    const ignoreOrigin = ignoreOriginFor(inventory);
    if (ignoreOrigin === origin) return false;

    const existing = inventory.getSlot(origin);
    if (!Core.isAmmoOntoWeaponIntent(held, existing)) return false;

    const cells = inventory.footprint(origin, existing.itemId, Core.stackRot(existing)) || [
      origin,
    ];
    const ok = Catalog.weaponAcceptsAmmo(existing.itemId, held.itemId);
    paintPreviewCells(inventory, cells, ok ? 'reload-ok' : 'reload-bad');
    return true;
  }

  /** 根据当前手持物与悬停格绘制占地预览。 */
  function applyPlacePreview(inventory, hoverIndex) {
    clearPlacePreview();
    const held = heldStackForPreview();
    if (!held || !inventory || hoverIndex == null || hoverIndex < 0) return;

    if (tryPaintAmmoReloadPreview(inventory, hoverIndex, held)) return;

    const heldRot = Core.stackRot(held);
    const size = inventory.sizeFor(held.itemId, heldRot);
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
      const cells = inventory.footprint(
        originOfHover,
        existing.itemId,
        Core.stackRot(existing)
      );
      if (existing.itemId === held.itemId && existing.qty < item.stack) {
        paintPreviewCells(inventory, cells, 'place-merge');
        return;
      }
      const canSwap = inventory.canPlaceAt(
        originOfHover,
        held.itemId,
        originOfHover,
        heldRot
      );
      paintPreviewCells(inventory, cells, canSwap ? 'place-merge' : 'place-bad');
      return;
    }

    const cells = inventory.footprint(hoverIndex, held.itemId, heldRot);
    const ok =
      Boolean(cells) && inventory.canPlaceAt(hoverIndex, held.itemId, ignoreOrigin, heldRot);
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
    playerPanel.classList.add('is-compact');
    syncMobileChrome();
  }

  /** 按端与当前分区更新底栏操作提示。 */
  function updateInventoryHint() {
    if (!hintEl) return;
    if (!isCoarse()) {
      hintEl.textContent = '拖拽移动 · R 旋转 · Shift+点击快速转移 · Tab 关闭';
      return;
    }
    if (state.cursor) {
      hintEl.textContent = hasSideLoot()
        ? '持物中：双击物品旋转 · 点空位放置 · 或切换「背包 / 附近」转移'
        : '持物中：双击物品旋转 · 点空位放置 · 切到「人物」可装装备/手部';
      return;
    }
    if (state.mobileTab === 'gear') {
      hintEl.textContent = '点选查看 · 双击旋转 · 再点拾起 · 点格子穿戴或到手部';
      return;
    }
    if (state.mobileTab === 'nearby') {
      hintEl.textContent = '点选拾起 · 双击旋转 · 切到「背包」放入随身或仓库';
      return;
    }
    hintEl.textContent = '点选查看 · 双击旋转 · 再点拾起 · 拖到其他格移动';
  }

  /**
   * 桌面：详情挂在 inventory root（避开 shell 层叠/overflow）；
   * 移动端：挂回 shell（footer 前）以保持底部停靠布局。
   */
  function mountDetailHost() {
    if (!detailPanel || !root) return;
    if (isCoarse() && inventoryShell) {
      if (inventoryFooter) {
        inventoryShell.insertBefore(detailPanel, inventoryFooter);
      } else {
        inventoryShell.appendChild(detailPanel);
      }
      return;
    }
    if (cursorEl) {
      root.insertBefore(detailPanel, cursorEl);
    } else {
      root.appendChild(detailPanel);
    }
  }

  /** 同步移动端顶栏分区与当前面板。 */
  function syncMobileChrome() {
    const mobile = isCoarse();
    root.classList.toggle('is-mobile-inv', mobile);
    mountDetailHost();
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

  /**
   * 拖拽/持物幽灵边长：固定紧凑方块（约装备格 78%），不随足迹 w×h 放大。
   * 网格上的占位预览仍由 place-* 高亮负责，与幽灵尺寸无关。
   */
  function cursorGhostPx() {
    const probe =
      root?.querySelector('.lp-equip-slot-host .lp-inventory-slot') ||
      playerGrid?.querySelector('.lp-inventory-slot:not([hidden])');
    const w = probe?.getBoundingClientRect?.().width;
    const equip = w > 8 ? w : 48;
    return Math.max(28, Math.round(equip * 0.78));
  }

  /** 光标幽灵用的堆叠：点击持物或拖拽中。 */
  function heldGhostStack() {
    if (state.cursor) return state.cursor;
    if (state.dragSource && state.dragMoved) {
      return state.dragSource.inventory.getSlot(state.dragSource.index);
    }
    return null;
  }

  /** 拖拽提起/结束后重绘网格，使源足迹显示为空或恢复占用。 */
  function syncDragSourceVisual() {
    renderGrids();
  }

  /** 渲染鼠标持物 / 拖拽幽灵（统一紧凑方块，多格仅用 is-span 边框提示）。 */
  function renderCursor() {
    const stack = heldGhostStack();
    if (!stack) {
      cursorEl.hidden = true;
      cursorEl.replaceChildren();
      cursorEl.style.width = '';
      cursorEl.style.height = '';
      cursorEl.style.margin = '';
      cursorEl.classList.remove('is-span');
      cursorEl.style.pointerEvents = 'none';
      return;
    }
    const item = Catalog.getItem(stack.itemId);
    if (!item) {
      cursorEl.hidden = true;
      cursorEl.style.pointerEvents = 'none';
      return;
    }
    const size = Core.orientedSize(item.id, Core.stackRot(stack));
    const ghost = cursorGhostPx();
    cursorEl.hidden = false;
    // 移动端持物时可点幽灵双击旋转
    cursorEl.style.pointerEvents = isCoarse() && state.cursor ? 'auto' : 'none';
    cursorEl.classList.toggle('is-span', size.w > 1 || size.h > 1);
    cursorEl.style.width = `${ghost}px`;
    cursorEl.style.height = `${ghost}px`;
    cursorEl.style.margin = `${-ghost / 2}px 0 0 ${-ghost / 2}px`;
    cursorEl.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'lp-inventory-item-icon';
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    if (item.icon) {
      icon.classList.add('has-image');
      icon.style.setProperty('--lp-item-icon', `url("${item.icon}")`);
      icon.style.backgroundImage = '';
      icon.textContent = '';
    } else {
      icon.textContent = item.short;
    }
    applyIconRotation(icon, stack);
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

  /** 左键点击槽位：拾起 / 放置 / 合并；触屏单击优先查看信息，快速再点旋转。 */
  function handleSlotClick(event, inventory, index) {
    if (state.suppressClick || state.dragMoved) {
      state.suppressClick = false;
      state.dragMoved = false;
      return;
    }

    const origin = inventory.originIndex(index);
    const now = performance.now();
    const tapKey = `${inventory.id}:${origin}`;
    const isDoubleTap =
      lastTap && lastTap.key === tapKey && now - lastTap.time < 320;
    lastTap = { key: tapKey, time: now };

    const stackBefore = inventory.getSlot(index);
    const slotEl = event.currentTarget;

    // 触屏：空手单击有物品 → 查看信息；快速再点同一格 → 旋转；较慢再点 → 拾起
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
      if (isDoubleTap) {
        rotateStackInPlace(inventory, origin);
        return;
      }
    }

    if (event.shiftKey) {
      const other = shiftTarget(inventory, index);
      if (other) {
        const from = bagRef(inventory, index);
        const toBag =
          other === player
            ? 'player'
            : other === storage
              ? 'storage'
              : other === hands
                ? 'hands'
                : other === equip
                  ? 'equip'
                  : other === state.groundInv
                    ? 'ground'
                    : null;
        Core.quickTransfer(inventory, index, other);
        persistAndRender();
        if (from && toBag) {
          netSend({
            action: 'quick_transfer',
            from,
            toBag,
            pileId: state.groundPile?.id || from.pileId || null,
          });
        }
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
      const origin = inventory.originIndex(index);
      const taken = inventory.takeSlot(index);
      if (taken) {
        state.cursor = taken;
        cursorSource = bagRef(inventory, origin);
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

    const placeIndex = inventory.originIndex(index);
    const to = bagRef(inventory, placeIndex);
    const from = cursorSource;

    if (state.cursor && Core.isAmmoOntoWeaponIntent(state.cursor, inventory.getSlot(placeIndex))) {
      const outcome = applyAmmoReloadOntoWeapon({
        ammoInv: null,
        ammoIndex: -1,
        ammoRef: cursorSource,
        weaponInv: inventory,
        weaponIndex: placeIndex,
        ammoStack: state.cursor,
      });
      if (outcome.status === 'rejected') {
        persistAndRender();
        return;
      }
      if (outcome.status === 'loaded') {
        state.cursor = outcome.leftover;
        if (!outcome.leftover) cursorSource = null;
        persistAndRender();
        if (outcome.leftover) {
          showDetail(outcome.leftover, {
            pinned: isCoarse(),
            clientX: event.clientX,
            clientY: event.clientY,
          });
        } else if (isCoarse()) clearDetail();
        else clearDetail();
        return;
      }
    }

    const returned = Core.placeOnSlot(inventory, index, state.cursor);
    state.cursor = returned;
    persistAndRender();
    if (from && to) {
      netSend({ action: 'transfer', from, to });
      cursorSource = returned ? { ...to } : null;
    }
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
        const halfStack = { itemId: stack.itemId, qty: half };
        if (stack.mag != null) halfStack.mag = stack.mag;
        if (Core.stackRot(stack) === 90) halfStack.rot = 90;
        state.cursor = halfStack;
      }
      persistAndRender();
      return;
    }

    const current = inventory.getSlot(origin);
    if (current && current.itemId !== state.cursor.itemId) return;

    const returned = Core.placeOnSlot(inventory, origin, {
      itemId: state.cursor.itemId,
      qty: 1,
      mag: state.cursor.mag,
      rot: state.cursor.rot,
    });
    if (returned === null) {
      state.cursor = {
        itemId: state.cursor.itemId,
        qty: state.cursor.qty - 1,
        mag: state.cursor.mag,
        rot: state.cursor.rot,
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

  /**
   * 弹药拖/放到带弹匣武器：匹配则装填，不匹配则原位退回（不交换）。
   * @returns {{ status: 'none'|'rejected'|'loaded', leftover: object|null }}
   */
  function applyAmmoReloadOntoWeapon(options) {
    const {
      ammoInv = null,
      ammoIndex = -1,
      ammoRef = null,
      weaponInv,
      weaponIndex,
      ammoStack,
    } = options || {};
    const weaponOrigin = weaponInv.originIndex(weaponIndex);
    const weaponStack = weaponInv.getSlot(weaponOrigin);
    if (!Core.isAmmoOntoWeaponIntent(ammoStack, weaponStack)) {
      return { status: 'none', leftover: ammoStack || null };
    }

    if (!Catalog.weaponAcceptsAmmo(weaponStack.itemId, ammoStack.itemId)) {
      window.LiminalInteract?.showToast?.('弹药不匹配');
      return { status: 'rejected', leftover: ammoStack };
    }

    const result = Core.tryLoadAmmoOntoWeapon(weaponInv, weaponOrigin, ammoStack);
    if (!result.ok) {
      window.LiminalInteract?.showToast?.('弹药不匹配');
      return { status: 'rejected', leftover: ammoStack };
    }

    if (ammoInv && result.leftover) {
      ammoInv.placeStack(ammoIndex, result.leftover);
    }

    const weaponItem = Catalog.getItem(weaponStack.itemId);
    const next = weaponInv.getSlot(weaponOrigin);
    if (result.loaded > 0) {
      window.LiminalInteract?.showToast?.(
        `装填 ${result.loaded} 发（${next?.mag ?? 0}/${weaponItem?.magazineSize ?? '?'}）`
      );
    } else {
      window.LiminalInteract?.showToast?.('弹匣已满');
    }

    const from = ammoRef || (ammoInv ? bagRef(ammoInv, ammoIndex) : null);
    const to = bagRef(weaponInv, weaponOrigin);
    if (from && to) {
      netSend({ action: 'reload', ammo: from, weapon: to });
    }
    return { status: 'loaded', leftover: result.leftover };
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

    const ammoPeek = source.inventory.getSlot(source.index);
    const weaponPeek = targetInventory.getSlot(targetInventory.originIndex(targetIndex));
    if (Core.isAmmoOntoWeaponIntent(ammoPeek, weaponPeek)) {
      const moving = source.inventory.takeSlot(source.index);
      if (!moving) return;
      const outcome = applyAmmoReloadOntoWeapon({
        ammoInv: source.inventory,
        ammoIndex: source.index,
        ammoRef: bagRef(source.inventory, source.index),
        weaponInv: targetInventory,
        weaponIndex: targetIndex,
        ammoStack: moving,
      });
      if (outcome.status === 'rejected') {
        source.inventory.placeStack(source.index, moving);
      }
      persistAndRender();
      return;
    }

    const moving = source.inventory.takeSlot(source.index);
    if (!moving) return;
    const from = bagRef(source.inventory, source.index);
    const to = bagRef(targetInventory, targetInventory.originIndex(targetIndex));
    const returned = Core.placeOnSlot(targetInventory, targetIndex, moving);
    if (returned) {
      source.inventory.placeStack(source.index, returned);
    }
    persistAndRender();
    if (from && to) {
      netSend({ action: 'transfer', from, to });
    }
  }

  /** 关闭时把手上物品退回背包，塞不下则掉地上。 */
  function returnCursorToPlayer() {
    if (!state.cursor) return;
    const stack = state.cursor;
    state.cursor = null;
    if (cursorSource && window.LpInventoryNet?.isActive?.()) {
      const inv =
        cursorSource.bag === 'ground'
          ? state.groundInv
          : inventoryById(cursorSource.bag);
      if (inv?.placeStack?.(cursorSource.index, stack)) {
        cursorSource = null;
        return;
      }
    }
    cursorSource = null;
    const leftoverQty = player.addItem(stack.itemId, stack.qty);
    if (leftoverQty < stack.qty && (stack.mag != null || Core.stackRot(stack) === 90)) {
      for (let i = 0; i < player.size(); i += 1) {
        const raw = player.slots[i];
        if (raw && raw.itemId === stack.itemId && raw.mag == null && raw.rot == null) {
          if (stack.mag != null) raw.mag = stack.mag;
          if (Core.stackRot(stack) === 90) raw.rot = 90;
          break;
        }
      }
    }
    if (leftoverQty > 0) {
      const drop = { itemId: stack.itemId, qty: leftoverQty };
      if (stack.mag != null) drop.mag = stack.mag;
      if (Core.stackRot(stack) === 90) drop.rot = 90;
      window.LpGroundLoot?.dropStacks?.(state.openWorldX, [drop]);
    }
  }

  /**
   * 原地切换堆叠朝向；失败则保持原状。
   * 联机时向权威发送 rotate。
   */
  function rotateStackInPlace(inventory, origin) {
    if (!inventory?.toggleRotation?.(origin)) return false;
    const ref = bagRef(inventory, origin);
    if (ref) netSend({ action: 'rotate', bag: ref });
    persistAndRender();
    const stack = inventory.getSlot(origin);
    if (stack) {
      const slotEl = slotButtonsFor(inventory)[origin];
      showDetail(stack, {
        pinned: isCoarse() || state.inspectPinned,
        slotEl: slotEl || null,
      });
    }
    return true;
  }

  /** 切换光标持物朝向（联机同步源格，因服务端尚未 take）。 */
  function rotateCursorStack() {
    if (!state.cursor) return false;
    const next = Core.toggledRot(Core.stackRot(state.cursor));
    if (next === 90) state.cursor.rot = 90;
    else delete state.cursor.rot;
    if (cursorSource && window.LpInventoryNet?.isActive?.()) {
      netSend({ action: 'rotate', bag: cursorSource });
    }
    persistAndRender();
    showDetail(state.cursor, { pinned: isCoarse() });
    return true;
  }

  /** 拖拽中切换源堆叠朝向，并刷新幽灵足迹。 */
  function rotateDragStack() {
    if (!state.dragSource) return false;
    const { inventory, index } = state.dragSource;
    if (!inventory.toggleRotation(index)) return false;
    const ref = bagRef(inventory, index);
    if (ref) netSend({ action: 'rotate', bag: ref });
    persistAndRender();
    if (state.hoverSlot) {
      applyPlacePreview(state.hoverSlot.inventory, state.hoverSlot.index);
    }
    return true;
  }

  /** 解析当前应旋转的目标：持物 > 拖拽 > 详情选中格。 */
  function rotateHeldOrSelected() {
    if (state.cursor) return rotateCursorStack();
    if (state.dragSource) return rotateDragStack();
    const inspecting = root.querySelector('.lp-inventory-slot.is-inspecting');
    if (!inspecting) return false;
    const inv = inventoryById(inspecting.dataset.inventoryId);
    const index = Number(inspecting.dataset.slotIndex);
    if (!inv || Number.isNaN(index)) return false;
    return rotateStackInPlace(inv, inv.originIndex(index));
  }

  /** 桌面：物品栏打开时 R 优先旋转（盖过世界装填）。 */
  function onInventoryKeyDown(event) {
    if (!state.open || event.repeat) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    const isRotateKey =
      Bindings?.matchesKeyEvent?.('reload', event) ||
      event.code === 'KeyR' ||
      event.key === 'r' ||
      event.key === 'R';
    if (!isRotateKey) return;
    if (!state.cursor && !state.dragSource) {
      const inspecting = root.querySelector('.lp-inventory-slot.is-inspecting');
      if (!inspecting && !heldStackForPreview()) return;
    }
    if (rotateHeldOrSelected()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /** 移动端：双击持物幽灵以旋转。 */
  function onCursorGhostClick(event) {
    if (!isCoarse() || !state.cursor) return;
    const now = performance.now();
    const isDouble =
      lastTap && lastTap.key === 'cursor-ghost' && now - lastTap.time < 320;
    lastTap = { key: 'cursor-ghost', time: now };
    if (!isDouble) return;
    event.preventDefault();
    event.stopPropagation();
    rotateCursorStack();
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
    if (!window.LpInventoryNet?.isActive?.()) {
      Core.restoreTestInfiniteStorage?.(storage);
      Core.saveInventories(player, storage, hands, equip);
      window.LpGroundLoot?.pruneAndSave?.();
    }
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
    root.classList.remove(
      'is-dual',
      'is-ground',
      'is-side-loot',
      'is-ground-loot',
      'is-storage-loot',
      'is-mobile-inv'
    );
    root.dataset.lpInvTab = '';
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-inventory-open');
    settingsPanel.hidden = true;
    settingsToggle?.setAttribute('aria-expanded', 'false');
    settingsToggle?.classList.remove('is-active');
    sideLootFloats.hidden = true;
    groundSection.hidden = true;
    storageSection.hidden = true;
    clearDetail();
    renderCursor();
    window.LpHandsHud?.render?.();
    window.LpTouchControls?.setEnabled(true);
  }

  /** 首次把开局溢出丢到脚边（联机由服务端种子负责，跳过本地种子）。 */
  function flushSeedOverflow(worldX) {
    if (window.LpInventoryNet?.isActive?.()) {
      pendingSeedOverflow = null;
      return;
    }
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
    const infinite = window.LpItemCatalog?.TEST_AUTO_REFILL_CONSUMABLES
      && window.LpItemCatalog?.isConsumableItem?.(itemId);
    if (window.LpInventoryNet?.isActive?.()) {
      netSend({ action: 'consume', itemId, qty });
      if (infinite) return qty;
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
    if (infinite) {
      const have = (hands.countItem?.(itemId) || 0) + (player.countItem?.(itemId) || 0);
      if (have <= 0) {
        const item = window.LpItemCatalog?.getItem?.(itemId);
        player.addItem?.(itemId, item?.maxStack || qty);
        persistAndRender();
      }
      return qty;
    }
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
  window.addEventListener('keydown', onInventoryKeyDown, true);
  cursorEl.addEventListener('click', onCursorGhostClick);
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
    renderAfterAuthority,
    clearCursorAfterAuthority,
    bagRef,
  };

  renderGrids();
  mountDetailHost();
  window.LpInputBindings?.renderBindings?.();
})();
