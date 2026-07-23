/**
 * 右上角列车编组小地图。
 * 数据来自 LiminalCarriageSpec.listMapEntries()；新车厢在 CARRIAGES.map 配置即可。
 * 自定义外观：registerKind(kind, { className })。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const root = document.getElementById('lpTrainMinimap');
  const listEl = document.getElementById('lpTrainMinimapCars');
  const activeEl = document.getElementById('lpTrainMinimapActive');
  if (!root || !listEl) return;

  /** @type {Map<string, { className: string }>} */
  const kindRegistry = new Map([
    ['engine', { className: 'lp-map-car--engine' }],
    ['cargo', { className: 'lp-map-car--cargo' }],
    ['defense', { className: 'lp-map-car--defense' }],
    ['default', { className: 'lp-map-car--default' }],
  ]);

  let builtKey = '';
  let activeId = null;

  /** 注册或覆盖某类车厢的小地图样式。 */
  function registerKind(kind, style) {
    if (!kind) return;
    const prev = kindRegistry.get(kind) || { className: 'lp-map-car--default' };
    kindRegistry.set(kind, {
      className: style?.className || prev.className,
    });
  }

  /** 当前编组签名：增减车厢时触发重建。 */
  function compositionKey(entries) {
    return entries.map((e) => `${e.id}:${e.kind}:${e.shortLabel}:${e.icon || ''}`).join('|');
  }

  /** 根据 Spec 重建车厢节点。 */
  function rebuild() {
    const entries = Spec?.listMapEntries?.() || [];
    const key = compositionKey(entries);
    if (key === builtKey) return;
    builtKey = key;
    listEl.replaceChildren();

    entries.forEach((entry, index) => {
      if (index > 0) {
        const coupler = document.createElement('li');
        coupler.className = 'lp-train-minimap-coupler';
        coupler.setAttribute('aria-hidden', 'true');
        listEl.appendChild(coupler);
      }

      const kind = kindRegistry.get(entry.kind) || kindRegistry.get('default');
      const item = document.createElement('li');
      item.className = `lp-train-minimap-car ${kind.className}`;
      item.dataset.carId = entry.id;
      item.dataset.kind = entry.kind;
      item.title = entry.label;
      if (entry.tone) item.style.setProperty('--lp-map-tone', entry.tone);

      const body = document.createElement('span');
      body.className = 'lp-train-minimap-car-body';
      if (entry.icon) {
        const img = document.createElement('img');
        img.className = 'lp-train-minimap-car-icon';
        img.src = entry.icon;
        img.alt = '';
        img.draggable = false;
        body.appendChild(img);
        body.classList.add('has-icon');
      }
      const label = document.createElement('span');
      label.className = 'lp-train-minimap-car-label';
      label.textContent = entry.shortLabel;
      body.appendChild(label);
      item.appendChild(body);

      const pip = document.createElement('span');
      pip.className = 'lp-train-minimap-pip';
      pip.setAttribute('aria-hidden', 'true');
      item.appendChild(pip);

      listEl.appendChild(item);
    });

    /* DOM 换新后需重上高亮；强制居中以免左端车厢被裁切。 */
    syncActive(activeId, { forceCenter: true });
  }

  let centerRaf = 0;

  /** 将指定车厢图标滚到编组条可视区水平中心。 */
  function scrollCarIntoCenter(carId) {
    if (!carId) return;
    const node = listEl.querySelector(
      `.lp-train-minimap-car[data-car-id="${CSS.escape(String(carId))}"]`,
    );
    if (!node) return;
    const listRect = listEl.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    if (listRect.width <= 0) return;
    const delta =
      nodeRect.left + nodeRect.width / 2 - (listRect.left + listRect.width / 2);
    const maxScroll = Math.max(0, listEl.scrollWidth - listEl.clientWidth);
    const nextLeft = Math.min(maxScroll, Math.max(0, listEl.scrollLeft + delta));
    if (Math.abs(nextLeft - listEl.scrollLeft) < 1) return;
    listEl.scrollTo({ left: nextLeft, behavior: 'smooth' });
  }

  /** 下一帧再居中，避开重建后尚未完成的布局。 */
  function scheduleCenterActive() {
    if (!activeId) return;
    cancelAnimationFrame(centerRaf);
    centerRaf = requestAnimationFrame(() => {
      centerRaf = 0;
      scrollCarIntoCenter(activeId);
    });
  }

  /**
   * 高亮玩家所在车厢；车厢切换时横向滚到该图标居中。
   * @param {string|null|undefined} carId
   * @param {{ forceCenter?: boolean }} [opts]
   */
  function syncActive(carId, opts) {
    const next = carId || null;
    const changed = next !== activeId;
    activeId = next;
    listEl.querySelectorAll('.lp-train-minimap-car').forEach((node) => {
      const on = node.dataset.carId === next;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-current', on ? 'location' : 'false');
    });
    if (activeEl) {
      const entry = Spec?.CARRIAGES?.find((c) => c.id === next);
      activeEl.textContent = entry
        ? Spec.mapEntryFor?.(entry)?.shortLabel || entry.label
        : '连廊';
    }
    if (changed || opts?.forceCenter) scheduleCenterActive();
  }

  /** 按世界 X 更新所在车厢高亮（每帧调用；仅换厢时滚动）。 */
  function syncFromWorldX(worldX) {
    rebuild();
    const car = Spec?.carriageAt?.(worldX);
    syncActive(car?.id ?? null);
  }

  /** 强制按当前 Spec 重建（外部改编组后调用）。 */
  function refresh() {
    builtKey = '';
    rebuild();
    syncActive(activeId, { forceCenter: true });
  }

  /**
   * 桌面端：指针在编组条上时，将滚轮纵向位移映射为横向 scrollLeft。
   * 有可滚余量时 preventDefault，避免带动页面滚动；触控横滑与点击开图不受影响。
   */
  function onCarsWheel(event) {
    const maxScroll = Math.max(0, listEl.scrollWidth - listEl.clientWidth);
    if (maxScroll <= 0) return;
    const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY;
    if (delta === 0) return;
    const next = Math.min(maxScroll, Math.max(0, listEl.scrollLeft + delta));
    if (next === listEl.scrollLeft) return;
    event.preventDefault();
    listEl.scrollLeft = next;
  }

  root.addEventListener('wheel', onCarsWheel, { passive: false });

  rebuild();
  syncActive(activeId, { forceCenter: true });

  window.LpTrainMinimap = {
    rebuild,
    refresh,
    syncActive,
    syncFromWorldX,
    scrollCarIntoCenter,
    registerKind,
    getActiveId: () => activeId,
  };
})();
