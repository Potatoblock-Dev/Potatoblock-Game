/**
 * 添加燃料：镜头拉近角色后，将右侧一格煤炭拖到左侧炉口。
 */
(() => {
  const root = document.getElementById('lpFuelFeedRoot');
  const closeButton = document.getElementById('lpFuelFeedClose');
  const dropZone = document.getElementById('lpFuelDropZone');
  const coalSlot = document.getElementById('lpFuelCoalSlot');
  const coalQty = document.getElementById('lpFuelCoalQty');
  const ghost = document.getElementById('lpFuelDragGhost');

  if (!root || !dropZone || !coalSlot || !ghost) return;

  let open = false;
  let drag = null;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 当前可用煤炭数量。 */
  function availableCoal() {
    return window.LpInventory?.getPlayerInventory?.()?.countItem?.('coal') ?? 0;
  }

  /** 刷新右侧煤格显示。 */
  function syncSlot() {
    const count = availableCoal();
    if (coalQty) coalQty.textContent = String(count);
    coalSlot.classList.toggle('is-empty', count <= 0);
    coalSlot.disabled = count <= 0;
  }

  /** 打开加燃料模式（先关其他全屏 UI）。 */
  function openPanel() {
    if (open) return;
    if (window.LpInventory?.isOpen()) window.LpInventory.close();
    if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-fuel-feed-open');
    window.LpTouchControls?.setEnabled(false);
    syncSlot();
    if (availableCoal() <= 0) {
      window.LiminalInteract?.showToast?.('背包没有煤炭');
    }
  }

  /** 关闭加燃料模式。 */
  function closePanel() {
    if (!open) return;
    endDrag(false);
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-fuel-feed-open');
    window.LpTouchControls?.setEnabled(true);
  }

  /** 切换。 */
  function toggle() {
    if (open) closePanel();
    else openPanel();
  }

  /** 放置幽灵煤炭位置。 */
  function placeGhost(clientX, clientY) {
    ghost.hidden = false;
    ghost.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  }

  /** 结束拖拽；success 为是否已成功投入。 */
  function endDrag(_committed) {
    drag = null;
    ghost.hidden = true;
    dropZone.classList.remove('is-hot');
    coalSlot.classList.remove('is-dragging');
  }

  /** 指针是否落在炉口投放区。 */
  function overDropZone(clientX, clientY) {
    const rect = dropZone.getBoundingClientRect();
    return (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    );
  }

  /** 开始从右侧拖出一格煤。 */
  function beginDrag(event) {
    if (!open || availableCoal() <= 0) return;
    drag = { pointerId: event.pointerId };
    coalSlot.classList.add('is-dragging');
    placeGhost(event.clientX, event.clientY);
    coalSlot.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  coalSlot.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    beginDrag(event);
  });

  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    placeGhost(event.clientX, event.clientY);
    dropZone.classList.toggle('is-hot', overDropZone(event.clientX, event.clientY));
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const hit = overDropZone(event.clientX, event.clientY);
    endDrag(hit);
    if (hit) {
      const ok = window.LiminalInteract?.addFuel?.();
      syncSlot();
      if (ok && availableCoal() <= 0) {
        /* 煤用完可继续看炉口，自行关闭 */
      }
    }
  });

  window.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(false);
  });

  closeButton?.addEventListener('click', closePanel);

  window.addEventListener('liminal:fuel-changed', syncSlot);

  window.LpFuelFeed = {
    open: openPanel,
    close: closePanel,
    toggle,
    isOpen,
    syncSlot,
  };
})();
