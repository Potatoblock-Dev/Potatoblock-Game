/**
 * 卫兵车厢弹药箱 / 回收箱：拖放取放 UI（布局对齐燃烧室燃料架）。
 * 从背包拖到箱体=存入；从箱体拖到背包架=取出。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const root = document.getElementById('lpGuardCrateRoot');
  const closeButton = document.getElementById('lpGuardCrateClose');
  const hintDesktop = document.getElementById('lpGuardCrateHintDesktop');
  const crateZone = document.getElementById('lpGuardCrateZone');
  const crateSlot = document.getElementById('lpGuardCrateSlot');
  const bagSlot = document.getElementById('lpGuardCrateBagSlot');
  const crateLabel = document.getElementById('lpGuardCrateLabel');
  const crateSub = document.getElementById('lpGuardCrateSub');
  const bagTitle = document.getElementById('lpGuardCrateBagTitle');
  const ghost = document.getElementById('lpGuardCrateDragGhost');
  const dock = document.getElementById('lpGuardCrateDock');

  if (!root || !crateZone || !crateSlot || !bagSlot || !ghost) return;

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

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 当前模式配置。 */
  function cfg() {
    return mode ? MODES[mode] : null;
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

  /** 把图标套到槽位。 */
  function paintIcon(slotEl, item, qty) {
    if (!slotEl || !item) return;
    let icon = slotEl.querySelector('.lp-fuel-item-icon');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'lp-fuel-item-icon';
      slotEl.prepend(icon);
    }
    icon.style.setProperty('--item-color', item.color);
    icon.style.setProperty('--item-accent', item.accent);
    if (item.icon) {
      icon.classList.add('has-image');
      icon.style.backgroundImage = `url("${item.icon}")`;
      icon.textContent = '';
    } else {
      icon.classList.remove('has-image');
      icon.style.backgroundImage = '';
      icon.textContent = item.short;
    }
    let qtyEl = slotEl.querySelector('.lp-fuel-item-qty');
    if (!qtyEl) {
      qtyEl = document.createElement('span');
      qtyEl.className = 'lp-fuel-item-qty';
      slotEl.append(qtyEl);
    }
    qtyEl.textContent = String(qty);
    slotEl.classList.toggle('is-empty', qty <= 0);
    slotEl.disabled = qty <= 0;
  }

  /** 刷新两侧数量与外观。 */
  function render() {
    const c = cfg();
    if (!c) return;
    const item = Catalog?.getItem?.(c.itemId);
    if (!item) return;
    if (crateLabel) crateLabel.textContent = c.crateTitle;
    if (crateSub) crateSub.textContent = c.crateSub;
    if (bagTitle) bagTitle.textContent = c.bagTitle;
    dock?.classList.toggle('is-ammo', c.theme === 'ammo');
    dock?.classList.toggle('is-recycle', c.theme === 'recycle');
    crateZone.classList.toggle('is-ammo', c.theme === 'ammo');
    crateZone.classList.toggle('is-recycle', c.theme === 'recycle');
    paintIcon(crateSlot, item, countCrate());
    paintIcon(bagSlot, item, countPlayer(c.itemId));
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
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-crate-feed-open');
    window.LpTouchControls?.setEnabled(true);
  }

  /** 放置拖拽幽灵。 */
  function placeGhost(clientX, clientY) {
    const c = cfg();
    const item = Catalog?.getItem?.(c?.itemId);
    const icon = ghost.querySelector('.lp-fuel-item-icon');
    if (icon && item) {
      icon.style.setProperty('--item-color', item.color);
      icon.style.setProperty('--item-accent', item.accent);
      if (item.icon) {
        icon.classList.add('has-image');
        icon.style.backgroundImage = `url("${item.icon}")`;
        icon.textContent = '';
      } else {
        icon.classList.remove('has-image');
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
    bagSlot.classList.remove('is-hot');
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
      bagSlot.classList.remove('is-hot');
    } else {
      bagSlot.classList.toggle('is-hot', overEl(bagSlot, event.clientX, event.clientY));
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
    } else if (from === 'crate' && overEl(bagSlot, event.clientX, event.clientY)) {
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

  crateSlot.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    beginDrag(event, 'crate', crateSlot);
  });
  bagSlot.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    beginDrag(event, 'bag', bagSlot);
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
  };
})();
