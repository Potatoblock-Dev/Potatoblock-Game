/**
 * 完整列车地图叠层（M 键 / 编组条点击）。
 * 展示全编组并高亮所在车厢；预留敌袭方向扇区 API（setRaidDirections）。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const root = document.getElementById('lpTrainMapRoot');
  const listEl = document.getElementById('lpTrainMapCars');
  const activeEl = document.getElementById('lpTrainMapActive');
  const raidEl = document.getElementById('lpTrainMapRaid');
  const closeBtn = document.getElementById('lpTrainMapClose');
  const hintEl = document.getElementById('lpTrainMapHint');
  if (!root || !listEl) return;

  /** 敌袭方向扇区标签（顺时针；0 = 列车前进 / 右）。占位，待实装敌袭逻辑。 */
  const RAID_SECTORS = [
    { id: 'fwd', label: '前', deg: 0 },
    { id: 'fwd-starboard', label: '前右', deg: 45 },
    { id: 'starboard', label: '右舷', deg: 90 },
    { id: 'aft-starboard', label: '后右', deg: 135 },
    { id: 'aft', label: '后', deg: 180 },
    { id: 'aft-port', label: '后左', deg: 225 },
    { id: 'port', label: '左舷', deg: 270 },
    { id: 'fwd-port', label: '前左', deg: 315 },
  ];

  /** @type {Map<string, { className: string }>} */
  const kindRegistry = new Map([
    ['engine', { className: 'lp-map-car--engine' }],
    ['cargo', { className: 'lp-map-car--cargo' }],
    ['defense', { className: 'lp-map-car--defense' }],
    ['sensor', { className: 'lp-map-car--sensor' }],
    ['compute', { className: 'lp-map-car--compute' }],
    ['default', { className: 'lp-map-car--default' }],
  ]);

  let open = false;
  let builtKey = '';
  let activeId = null;
  /** @type {Array<{ id?: string, sector: string, label?: string, intensity?: number }>} */
  let raidDirections = [];

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 编组签名：增减车厢时触发重建。 */
  function compositionKey(entries) {
    return entries.map((e) => `${e.id}:${e.kind}:${e.shortLabel}:${e.icon || ''}`).join('|');
  }

  /** 根据 Spec 重建车厢节点。 */
  function rebuildCars() {
    const entries = Spec?.listMapEntries?.() || [];
    const key = compositionKey(entries);
    if (key === builtKey) return;
    builtKey = key;
    listEl.replaceChildren();

    entries.forEach((entry, index) => {
      if (index > 0) {
        const coupler = document.createElement('li');
        coupler.className = 'lp-train-map-coupler';
        coupler.setAttribute('aria-hidden', 'true');
        listEl.appendChild(coupler);
      }

      const kind = kindRegistry.get(entry.kind) || kindRegistry.get('default');
      const item = document.createElement('li');
      item.className = `lp-train-map-car ${kind.className}`;
      item.dataset.carId = entry.id;
      item.dataset.kind = entry.kind;
      item.title = entry.label;
      if (entry.tone) item.style.setProperty('--lp-map-tone', entry.tone);

      const body = document.createElement('span');
      body.className = 'lp-train-map-car-body';
      if (entry.icon) {
        const img = document.createElement('img');
        img.className = 'lp-train-map-car-icon';
        img.src = entry.icon;
        img.alt = '';
        img.draggable = false;
        body.appendChild(img);
        body.classList.add('has-icon');
      }
      const label = document.createElement('span');
      label.className = 'lp-train-map-car-label';
      label.textContent = entry.shortLabel;
      body.appendChild(label);
      const name = document.createElement('span');
      name.className = 'lp-train-map-car-name';
      name.textContent = entry.label;
      body.appendChild(name);
      item.appendChild(body);

      const pip = document.createElement('span');
      pip.className = 'lp-train-map-pip';
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
    listEl.querySelectorAll('.lp-train-map-car').forEach((node) => {
      const on = node.dataset.carId === next;
      node.classList.toggle('is-active', on);
      node.setAttribute('aria-current', on ? 'location' : 'false');
    });
    if (activeEl) {
      const entry = Spec?.CARRIAGES?.find((c) => c.id === next);
      activeEl.textContent = entry
        ? Spec.mapEntryFor?.(entry)?.shortLabel || entry.label
        : '连廊 / 车外';
    }
  }

  /** 按世界 X 更新所在车厢高亮。 */
  function syncFromWorldX(worldX) {
    if (!open) return;
    rebuildCars();
    const car = Spec?.carriageAt?.(worldX);
    syncActive(car?.id ?? null);
  }

  /**
   * 渲染敌袭方向扇区（空占位；有数据时点亮）。
   * 条目字段：sector（RAID_SECTORS.id）、可选 label / intensity(0–1)。
   */
  function renderRaidSectors() {
    if (!raidEl) return;
    const byId = new Map(
      raidDirections
        .filter((d) => d && typeof d.sector === 'string')
        .map((d) => [d.sector, d])
    );
    raidEl.replaceChildren();
    for (const sector of RAID_SECTORS) {
      const hit = byId.get(sector.id);
      const node = document.createElement('li');
      node.className = 'lp-train-map-raid-sector';
      node.dataset.sector = sector.id;
      node.style.setProperty('--lp-raid-deg', `${sector.deg}deg`);
      if (hit) {
        node.classList.add('is-active');
        const intensity = Math.max(0, Math.min(1, Number(hit.intensity) || 0.7));
        node.style.setProperty('--lp-raid-intensity', String(intensity));
      }
      const mark = document.createElement('span');
      mark.className = 'lp-train-map-raid-mark';
      mark.setAttribute('aria-hidden', 'true');
      node.appendChild(mark);
      const text = document.createElement('span');
      text.className = 'lp-train-map-raid-label';
      text.textContent = hit?.label || sector.label;
      node.appendChild(text);
      raidEl.appendChild(node);
    }
  }

  /**
   * 设置敌袭方向（未来敌袭逻辑入口；当前仅驱动 UI 占位）。
   * @param {Array<{ id?: string, sector: string, label?: string, intensity?: number }>} list
   */
  function setRaidDirections(list) {
    raidDirections = Array.isArray(list) ? list.slice() : [];
    renderRaidSectors();
  }

  /** 读取当前敌袭方向占位数据。 */
  function getRaidDirections() {
    return raidDirections.slice();
  }

  /** 同步关闭提示文案。 */
  function syncHint() {
    if (!hintEl) return;
    const key = window.LpInputBindings?.formatAction?.('trainMap') || 'M';
    hintEl.textContent = `${key} / Esc 关闭 · 点空白处关闭 · 右 = 列车前进 · 敌袭方向扇区（预留）`;
  }

  /** 打开完整地图。 */
  function openMap(worldX) {
    if (open) return;
    open = true;
    rebuildCars();
    if (typeof worldX === 'number') {
      syncActive(Spec?.carriageAt?.(worldX)?.id ?? null);
    } else {
      syncActive(window.LpTrainMinimap?.getActiveId?.() ?? activeId);
    }
    renderRaidSectors();
    syncHint();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-train-map-open');
  }

  /** 关闭完整地图。 */
  function closeMap() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-train-map-open');
  }

  /** 切换完整地图；传入 worldX 时打开并按位置高亮。 */
  function toggle(worldX) {
    if (open) closeMap();
    else openMap(worldX);
  }

  /** 强制按当前 Spec 重建。 */
  function refresh() {
    builtKey = '';
    rebuildCars();
    renderRaidSectors();
  }

  closeBtn?.addEventListener('click', () => closeMap());
  root.querySelector('.lp-train-map-backdrop')?.addEventListener('click', () => closeMap());

  /* 编组小地图：点击 / Enter / Space 打开完整地图（桌面 + 触控） */
  const minimap = document.getElementById('lpTrainMinimap');
  /** 打开或关闭完整地图（编组条入口；物品栏打开时忽略）。 */
  function toggleFromMinimap() {
    if (open) {
      closeMap();
      return;
    }
    if (window.LpInventory?.isOpen?.()) return;
    openMap();
  }
  minimap?.addEventListener('click', () => toggleFromMinimap());
  minimap?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleFromMinimap();
  });

  /* 移动端地图钮 */
  document.getElementById('lpMobileMapButton')?.addEventListener('click', () => {
    if (window.LpInventory?.isOpen?.()) return;
    toggle();
  });

  window.addEventListener('lp:bindings-changed', () => {
    if (open) syncHint();
  });

  renderRaidSectors();

  window.LpTrainMap = {
    isOpen,
    open: openMap,
    close: closeMap,
    toggle,
    refresh,
    syncActive,
    syncFromWorldX,
    setRaidDirections,
    getRaidDirections,
    /** 合法 sector id 列表（敌袭 UI 契约）。 */
    RAID_SECTOR_IDS: RAID_SECTORS.map((s) => s.id),
  };
})();
