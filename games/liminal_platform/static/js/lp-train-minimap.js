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
    return entries.map((e) => `${e.id}:${e.kind}:${e.shortLabel}`).join('|');
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
      body.textContent = entry.shortLabel;
      item.appendChild(body);

      const pip = document.createElement('span');
      pip.className = 'lp-train-minimap-pip';
      pip.setAttribute('aria-hidden', 'true');
      item.appendChild(pip);

      listEl.appendChild(item);
    });

    syncActive(activeId);
  }

  /** 高亮玩家所在车厢。 */
  function syncActive(carId) {
    const next = carId || null;
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
  }

  /** 按世界 X 更新所在车厢高亮。 */
  function syncFromWorldX(worldX) {
    rebuild();
    const car = Spec?.carriageAt?.(worldX);
    syncActive(car?.id ?? null);
  }

  /** 强制按当前 Spec 重建（外部改编组后调用）。 */
  function refresh() {
    builtKey = '';
    rebuild();
  }

  rebuild();

  window.LpTrainMinimap = {
    rebuild,
    refresh,
    syncActive,
    syncFromWorldX,
    registerKind,
    getActiveId: () => activeId,
  };
})();
