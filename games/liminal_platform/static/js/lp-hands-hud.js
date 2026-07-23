/**
 * 左下角手部三槽预览：常显；按绑定键循环切换选中槽。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const root = document.getElementById('lpHandsHud');
  if (!root) return;

  const slots = [0, 1, 2].map((i) => root.querySelector(`[data-lp-hand-hud="${i}"]`));
  const LABELS = ['', '', '工具'];
  const TOAST_LABELS = ['1', '2', '工具'];

  let visible = true;
  /** 当前选中槽（开火优先用此槽上的枪）。 */
  let activeIndex = 1;

  /** 预览是否显示。 */
  function isVisible() {
    return visible;
  }

  /** 当前选中下标。 */
  function getActiveIndex() {
    return activeIndex;
  }

  /** 设置选中槽。 */
  function setActiveIndex(index) {
    if (index < 0 || index > 2) return;
    activeIndex = index;
    render();
  }

  /** 显示 / 隐藏预览。 */
  function setVisible(next) {
    visible = Boolean(next);
    document.body.classList.toggle('lp-hands-hud-hidden', !visible);
    render();
  }

  /** 切换预览显隐。 */
  function toggleVisible() {
    setVisible(!visible);
    window.LiminalInteract?.showToast?.(visible ? '手部栏显示' : '手部栏隐藏');
  }

  /** 在 0→1→2→0 间切换选中。 */
  function cycleActive() {
    activeIndex = (activeIndex + 1) % 3;
    render();
    const hands = window.LpInventory?.getHandsInventory?.();
    const stack = hands?.getSlot?.(activeIndex);
    const name = stack ? Catalog.getItem(stack.itemId)?.name : null;
    window.LiminalInteract?.showToast?.(
      name
        ? `手部 · ${TOAST_LABELS[activeIndex]}（${name}）`
        : `手部 · ${TOAST_LABELS[activeIndex]}`
    );
  }

  /** 绘制单槽内容。 */
  function paintSlot(el, index, stack, isActive) {
    if (!el) return;
    el.classList.toggle('is-active', isActive);
    el.classList.toggle('is-empty', !stack);
    el.classList.toggle('is-utility', index === 2);
    let icon = el.querySelector('.lp-hands-hud-icon');
    let qty = el.querySelector('.lp-hands-hud-qty');
    let label = el.querySelector('.lp-hands-hud-label');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'lp-hands-hud-icon';
      el.append(icon);
    }
    if (!qty) {
      qty = document.createElement('span');
      qty.className = 'lp-hands-hud-qty';
      el.append(qty);
    }
    if (!label) {
      label = document.createElement('span');
      label.className = 'lp-hands-hud-label';
      el.append(label);
    }
    label.textContent = LABELS[index];
    label.hidden = !LABELS[index];
    if (!stack) {
      icon.classList.remove('has-image');
      icon.style.backgroundImage = '';
      icon.textContent = '';
      qty.textContent = '';
      return;
    }
    const item = Catalog.getItem(stack.itemId);
    if (!item) return;
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
    if (item.magazineSize != null) {
      qty.textContent = `${stack.mag ?? 0}/${item.magazineSize}`;
    } else {
      qty.textContent = stack.qty > 1 ? String(stack.qty) : '';
    }
  }

  /** 刷新三槽。 */
  function render() {
    const hands = window.LpInventory?.getHandsInventory?.();
    const uiOpen =
      document.body.classList.contains('lp-inventory-open') ||
      document.body.classList.contains('lp-fuel-feed-open') ||
      document.body.classList.contains('lp-crate-feed-open') ||
      document.body.classList.contains('lp-boiler-panel-open');
    root.hidden = !visible || uiOpen;
    root.setAttribute('aria-hidden', root.hidden ? 'true' : 'false');
    for (let i = 0; i < 3; i += 1) {
      paintSlot(slots[i], i, hands?.getSlot?.(i) || null, i === activeIndex);
    }
  }

  slots.forEach((el, index) => {
    el?.addEventListener('click', () => {
      setActiveIndex(index);
    });
  });

  window.addEventListener('lp:bindings-changed', render);
  const obs = new MutationObserver(render);
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.LpHandsHud = {
    render,
    cycleActive,
    toggleVisible,
    setVisible,
    isVisible,
    getActiveIndex,
    setActiveIndex,
  };

  setVisible(true);
  render();
})();
