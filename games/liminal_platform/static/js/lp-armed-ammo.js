/**
 * 武装车厢弹种 / 弹链：共享目录、车厢能力、循环开火游标、底部 HUD、弹药箱弹链编辑、详情浮层。
 *
 * 开火规则（连发 + supportsBelts）：当前激活弹链按 slots 顺序循环打出；每组弹链自有 cursor，
 * 切组后再切回从该组上次位置继续。火炮类（supportsBelts:false）仅单选弹种，无弹链。
 */
(() => {
  const STORAGE_KEY = 'lp-armed-belts-v1';

  /**
   * 弹种目录（AP=穿甲，T=曳光）。trail / bodyTint 供 LpCombat；penetrates 留给后续玩法。
   */
  const AMMO_TYPES = {
    ap: {
      id: 'ap',
      tag: 'AP',
      subtitle: '穿甲',
      color: '#3a404c',
      accent: '#555e6c',
      role: '穿甲',
      use: '低对比不透明穿甲弹：缩小弹体、无拖尾，便于隐蔽射击。',
      body: '#3a404c',
      band: '#262b35',
      tip: '#555e6c',
      trail: null,
      bodyScale: 0.62,
      bodyHScale: 0.42,
      tipHighlight: 0.12,
      flashScale: 0.55,
      penetrates: true,
    },
    t: {
      id: 't',
      tag: 'T',
      subtitle: '曳光',
      color: '#86efac',
      accent: '#166534',
      role: '曳光',
      use: '亮绿曳光弹：弹道拖尾，弹体消失后尾迹短暂滞空，便于校射。',
      body: '#86efac',
      band: '#166534',
      tip: '#ecfdf5',
      trail: {
        color: 'rgba(34, 197, 94, 0.92)',
        glow: 'rgba(74, 222, 128, 0.55)',
        length: 14,
        width: 3.2,
        linger: 0.35,
      },
      penetrates: false,
    },
  };

  /**
   * 车厢能力。supportsBelts=true 仅连发/机枪类可编辑弹链；火炮类只选单弹种。
   * 新武装车：registerCarriage(id, cfg) 或在此表追加。
   */
  const CARRIAGES = {
    guard: {
      id: 'guard',
      label: '卫士',
      /** 可用弹种顺序（单弹种模式 HUD；亦为弹链槽位可选集合）。 */
      allowedTypes: ['ap', 't'],
      supportsBelts: true,
      maxBelts: 2,
      slotsPerBelt: 3,
      defaultSlots: ['ap', 'ap', 'ap'],
    },
    /* 示例（未启用）：火炮类仅选弹种
    artillery: {
      id: 'artillery',
      label: '火炮',
      allowedTypes: ['ap', 't'],
      supportsBelts: false,
    },
    */
  };

  /** @deprecated 兼容旧调用；等同 allowedTypes。 */
  const LOADOUTS = Object.fromEntries(
    Object.entries(CARRIAGES).map(([id, c]) => [id, c.allowedTypes.slice()])
  );

  const state = {
    /** @type {string | null} */
    carriageId: null,
    /** 单弹种模式：allowedTypes 下标。 */
    typeIndex: 0,
    /** 弹链模式：激活组下标。 */
    activeBeltIndex: 0,
    /**
     * 各车厢弹链存档：{ belts: string[][], cursors: number[], activeBeltIndex: number }
     * @type {Record<string, { belts: string[][], cursors: number[], activeBeltIndex: number }>}
     */
    byCarriage: {},
  };

  let root = null;
  let listEl = null;
  let detailPanel = null;
  let detailBody = null;
  let detailIcon = null;
  let detailName = null;
  let detailMeta = null;
  let detailUse = null;
  /** @type {HTMLElement | null} */
  let crateBottomHost = null;
  let hideDetailTimer = 0;

  /** 取弹种定义；未知 id 回退 AP。 */
  function getType(id) {
    return AMMO_TYPES[id] || AMMO_TYPES.ap;
  }

  /** 车厢能力配置。 */
  function getCarriage(carriageId) {
    const id = carriageId || state.carriageId;
    return id ? CARRIAGES[id] || null : null;
  }

  /** 当前车厢是否支持弹链编辑/循环开火。 */
  function supportsBelts(carriageId) {
    return Boolean(getCarriage(carriageId)?.supportsBelts);
  }

  /** 当前车厢可用弹种 id 列表。 */
  function getLoadout() {
    const cfg = getCarriage();
    return cfg ? cfg.allowedTypes.slice() : [];
  }

  /** 规范化槽位：长度固定、仅 allowed 内类型。 */
  function normalizeSlots(raw, cfg) {
    const allowed = cfg.allowedTypes;
    const n = cfg.slotsPerBelt || 3;
    const fallback = cfg.defaultSlots || allowed.map(() => allowed[0]);
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const id = String(raw?.[i] || fallback[i] || allowed[0]).toLowerCase();
      out.push(allowed.includes(id) ? id : allowed[0]);
    }
    return out;
  }

  /** 读取或初始化某车厢弹链存档（无弹链能力时返回 null）。 */
  function beltStore(carriageId) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts) return null;
    const id = cfg.id;
    if (!state.byCarriage[id]) {
      state.byCarriage[id] = {
        belts: [normalizeSlots(cfg.defaultSlots, cfg)],
        cursors: [0],
        activeBeltIndex: 0,
      };
    }
    const store = state.byCarriage[id];
    store.belts = store.belts
      .slice(0, cfg.maxBelts)
      .map((slots) => normalizeSlots(slots, cfg));
    if (store.belts.length === 0) {
      store.belts = [normalizeSlots(cfg.defaultSlots, cfg)];
    }
    while (store.cursors.length < store.belts.length) store.cursors.push(0);
    store.cursors = store.cursors.slice(0, store.belts.length).map((c, i) => {
      const n = store.belts[i].length;
      return ((Number(c) || 0) % n + n) % n;
    });
    if (store.activeBeltIndex < 0 || store.activeBeltIndex >= store.belts.length) {
      store.activeBeltIndex = 0;
    }
    return store;
  }

  /** 从 localStorage 加载弹链。 */
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      for (const [id, data] of Object.entries(parsed)) {
        if (!CARRIAGES[id]?.supportsBelts || !data) continue;
        state.byCarriage[id] = {
          belts: Array.isArray(data.belts) ? data.belts : [],
          cursors: Array.isArray(data.cursors) ? data.cursors : [],
          activeBeltIndex: Number(data.activeBeltIndex) || 0,
        };
        beltStore(id);
      }
    } catch (_) {
      /* ignore corrupt */
    }
  }

  /** 持久化弹链（离线）；联机权威后续可接同一 toJSON。 */
  function savePersisted() {
    if (window.LpInventoryNet?.isActive?.()) return;
    const out = {};
    for (const id of Object.keys(CARRIAGES)) {
      if (!CARRIAGES[id].supportsBelts) continue;
      const store = beltStore(id);
      if (!store) continue;
      out[id] = {
        belts: store.belts.map((s) => s.slice()),
        cursors: store.cursors.slice(),
        activeBeltIndex: store.activeBeltIndex,
      };
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  }

  /** 导出弹链 JSON（供弹药箱快照 / 联机后续）。 */
  function beltsToJSON(carriageId) {
    const store = beltStore(carriageId || state.carriageId);
    if (!store) return null;
    return {
      belts: store.belts.map((s) => s.slice()),
      cursors: store.cursors.slice(),
      activeBeltIndex: store.activeBeltIndex,
    };
  }

  /** 用快照覆盖弹链。 */
  function applyBeltsFromSnapshot(carriageId, data) {
    const cfg = getCarriage(carriageId);
    if (!cfg?.supportsBelts || !data) return;
    state.byCarriage[cfg.id] = {
      belts: Array.isArray(data.belts) ? data.belts : [],
      cursors: Array.isArray(data.cursors) ? data.cursors : [],
      activeBeltIndex: Number(data.activeBeltIndex) || 0,
    };
    beltStore(cfg.id);
    if (state.carriageId === cfg.id) {
      state.activeBeltIndex = state.byCarriage[cfg.id].activeBeltIndex;
    }
    render();
    renderBeltEditor();
  }

  /** 弹链槽位文案：T/AP/AP。 */
  function formatBeltPattern(slots) {
    return (slots || []).map((id) => getType(id).tag).join('/');
  }

  /** 当前激活弹链 slots；无弹链能力时 null。 */
  function getActiveBeltSlots() {
    const store = beltStore();
    if (!store) return null;
    return store.belts[store.activeBeltIndex] || null;
  }

  /**
   * 窥视下一发弹种 id（不推进游标）。
   * 弹链模式：该组 cursor 指向的槽；单弹种模式：当前选中类型。
   */
  function peekFireTypeId() {
    const cfg = getCarriage();
    if (!cfg) return 'ap';
    if (cfg.supportsBelts) {
      const store = beltStore();
      const slots = store?.belts[store.activeBeltIndex];
      if (!slots?.length) return cfg.allowedTypes[0] || 'ap';
      const cursor = store.cursors[store.activeBeltIndex] || 0;
      return slots[cursor % slots.length];
    }
    return cfg.allowedTypes[state.typeIndex] || cfg.allowedTypes[0] || 'ap';
  }

  /**
   * 成功开火后推进：弹链组内 cursor+1 取模；单弹种模式无操作。
   * 须在确认本触发已耗弹并发射后调用一次（双联同发仍只推进 1 次）。
   */
  function advanceFireCursor() {
    const cfg = getCarriage();
    if (!cfg?.supportsBelts) return;
    const store = beltStore();
    if (!store) return;
    const i = store.activeBeltIndex;
    const n = store.belts[i]?.length || 1;
    store.cursors[i] = ((store.cursors[i] || 0) + 1) % n;
    savePersisted();
    render();
  }

  /** 当前选中弹种定义（窥视下一发）。 */
  function getSelected() {
    if (!state.carriageId) return null;
    return getType(peekFireTypeId());
  }

  /** 当前选中弹种 id。 */
  function getSelectedId() {
    if (!state.carriageId) return null;
    return peekFireTypeId();
  }

  /** 武装 HUD 是否应对玩家可见。 */
  function isActive() {
    return Boolean(state.carriageId && getLoadout().length > 0);
  }

  /** 确保底部 HUD DOM。 */
  function ensureDom() {
    if (root) return;
    root = document.getElementById('lpArmedAmmoHud');
    if (!root) {
      root = document.createElement('div');
      root.id = 'lpArmedAmmoHud';
      root.className = 'lp-armed-ammo-hud';
      root.setAttribute('aria-label', '弹种');
      root.hidden = true;
      const stage = document.querySelector('.lp-stage') || document.body;
      stage.appendChild(root);
    }
    listEl = root.querySelector('.lp-armed-ammo-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'lp-armed-ammo-list';
      listEl.setAttribute('role', 'listbox');
      listEl.setAttribute('aria-label', '弹种列表');
      root.appendChild(listEl);
    }
    ensureDetailDom();
  }

  /** 确保详情浮层（复用物品栏 .lp-inventory-detail 样式类）。 */
  function ensureDetailDom() {
    if (detailPanel) return;
    detailPanel = document.getElementById('lpArmedAmmoDetail');
    if (!detailPanel) {
      detailPanel = document.createElement('aside');
      detailPanel.id = 'lpArmedAmmoDetail';
      detailPanel.className = 'lp-inventory-detail lp-armed-ammo-detail';
      detailPanel.hidden = true;
      detailPanel.setAttribute('aria-live', 'polite');
      detailPanel.innerHTML =
        '<div class="lp-inventory-detail-body">' +
        '<div class="lp-inventory-detail-icon-wrap">' +
        '<span class="lp-inventory-item-icon lp-armed-ammo-detail-icon"></span>' +
        '</div>' +
        '<h3 class="lp-inventory-detail-name"></h3>' +
        '<dl class="lp-inventory-detail-meta"></dl>' +
        '<p class="lp-inventory-detail-use-label">作用</p>' +
        '<p class="lp-inventory-detail-use"></p>' +
        '</div>';
      document.body.appendChild(detailPanel);
    }
    detailBody = detailPanel.querySelector('.lp-inventory-detail-body');
    detailIcon = detailPanel.querySelector('.lp-inventory-item-icon');
    detailName = detailPanel.querySelector('.lp-inventory-detail-name');
    detailMeta = detailPanel.querySelector('.lp-inventory-detail-meta');
    detailUse = detailPanel.querySelector('.lp-inventory-detail-use');
  }

  /** 定位详情浮层到指针旁（与物品栏同策略）。 */
  function positionDetail(clientX, clientY) {
    if (!detailPanel || detailPanel.hidden) return;
    const pad = 12;
    const rect = detailPanel.getBoundingClientRect();
    let left = clientX + 16;
    let top = clientY + 16;
    if (left + rect.width > window.innerWidth - pad) {
      left = clientX - rect.width - 12;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    left = Math.max(pad, left);
    top = Math.max(pad, top);
    detailPanel.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** 隐藏详情浮层。 */
  function hideDetail() {
    if (hideDetailTimer) {
      window.clearTimeout(hideDetailTimer);
      hideDetailTimer = 0;
    }
    if (!detailPanel) return;
    detailPanel.hidden = true;
    detailPanel.style.transform = '';
  }

  /**
   * 显示弹种详情（物品栏同款布局：图标/名/元数据格/作用）。
   * @param {string} ammoId
   * @param {{ clientX?: number, clientY?: number }} [opts]
   */
  function showTypeDetail(ammoId, opts = {}) {
    ensureDetailDom();
    const def = getType(ammoId);
    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', def.color || def.body);
      detailIcon.style.setProperty('--item-accent', def.accent || def.band);
      detailIcon.classList.remove('has-image');
      detailIcon.style.removeProperty('--lp-item-icon');
      detailIcon.textContent = def.tag;
    }
    if (detailName) detailName.textContent = `${def.tag} ${def.subtitle}`;
    if (detailMeta) {
      detailMeta.innerHTML =
        `<div><dt>标记</dt><dd>${def.tag}</dd></div>` +
        `<div><dt>类型</dt><dd>${def.role || def.subtitle}</dd></div>` +
        `<div><dt>拖尾</dt><dd>${def.trail ? '有' : '无'}</dd></div>` +
        `<div><dt>穿甲</dt><dd>${def.penetrates ? '是' : '否'}</dd></div>`;
    }
    if (detailUse) detailUse.textContent = def.use || '暂无说明';
    detailPanel.hidden = false;
    if (opts.clientX != null && opts.clientY != null) {
      detailPanel.style.transform = 'translate(-9999px, -9999px)';
      requestAnimationFrame(() => positionDetail(opts.clientX, opts.clientY));
    }
  }

  /**
   * 显示弹链详情。
   * @param {number} beltIndex
   * @param {{ clientX?: number, clientY?: number, carriageId?: string }} [opts]
   */
  function showBeltDetail(beltIndex, opts = {}) {
    ensureDetailDom();
    const cfg = getCarriage(opts.carriageId);
    const store = beltStore(opts.carriageId || state.carriageId);
    if (!cfg || !store || beltIndex < 0 || beltIndex >= store.belts.length) {
      hideDetail();
      return;
    }
    const slots = store.belts[beltIndex];
    const pattern = formatBeltPattern(slots);
    const cursor = store.cursors[beltIndex] || 0;
    const next = getType(slots[cursor % slots.length]);
    const active = beltIndex === store.activeBeltIndex;
    if (detailIcon) {
      detailIcon.style.setProperty('--item-color', '#a16207');
      detailIcon.style.setProperty('--item-accent', '#fbbf24');
      detailIcon.classList.remove('has-image');
      detailIcon.style.removeProperty('--lp-item-icon');
      detailIcon.textContent = String(beltIndex + 1);
    }
    if (detailName) detailName.textContent = `弹链 ${beltIndex + 1}`;
    if (detailMeta) {
      detailMeta.innerHTML =
        `<div><dt>序列</dt><dd>${pattern}</dd></div>` +
        `<div><dt>状态</dt><dd>${active ? '使用中' : '待命'}</dd></div>` +
        `<div><dt>下一发</dt><dd>${next.tag}</dd></div>` +
        `<div><dt>游标</dt><dd>${cursor + 1}/${slots.length}</dd></div>`;
    }
    if (detailUse) {
      detailUse.textContent =
        `连发按顺序循环：${pattern}，打完一轮后回到首位。切换弹链保留各组游标。`;
    }
    detailPanel.hidden = false;
    if (opts.clientX != null && opts.clientY != null) {
      detailPanel.style.transform = 'translate(-9999px, -9999px)';
      requestAnimationFrame(() => positionDetail(opts.clientX, opts.clientY));
    }
  }

  /** 绑定悬停详情（粗指针跳过，与物品栏一致）。 */
  function bindHoverDetail(el, showFn) {
    if (!el) return;
    el.addEventListener('pointerenter', (event) => {
      if (window.matchMedia?.('(pointer: coarse)')?.matches) return;
      if (hideDetailTimer) {
        window.clearTimeout(hideDetailTimer);
        hideDetailTimer = 0;
      }
      showFn(event);
    });
    el.addEventListener('pointermove', (event) => {
      if (detailPanel?.hidden) return;
      if (window.matchMedia?.('(pointer: coarse)')?.matches) return;
      positionDetail(event.clientX, event.clientY);
    });
    el.addEventListener('pointerleave', () => {
      hideDetailTimer = window.setTimeout(hideDetail, 80);
    });
  }

  /** 刷新底部 HUD（弹链模式列组；单弹种模式列类型）。 */
  function render() {
    ensureDom();
    const cfg = getCarriage();
    const active = isActive();
    const uiBlocked =
      document.body.classList.contains('lp-inventory-open') ||
      document.body.classList.contains('lp-fuel-feed-open') ||
      document.body.classList.contains('lp-crate-feed-open') ||
      document.body.classList.contains('lp-boiler-panel-open') ||
      document.body.classList.contains('lp-radar-panel-open') ||
      document.body.classList.contains('lp-auto-console-open') ||
      document.body.classList.contains('lp-train-map-open');
    root.hidden = !active || uiBlocked;
    root.setAttribute('aria-hidden', root.hidden ? 'true' : 'false');
    root.setAttribute('aria-label', cfg?.supportsBelts ? '弹链' : '弹种');
    if (!active || !cfg) {
      listEl.replaceChildren();
      return;
    }

    const frag = document.createDocumentFragment();
    if (cfg.supportsBelts) {
      const store = beltStore();
      store.belts.forEach((slots, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-armed-ammo-slot lp-armed-ammo-belt';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', i === store.activeBeltIndex ? 'true' : 'false');
        btn.classList.toggle('is-active', i === store.activeBeltIndex);
        btn.dataset.beltIndex = String(i);
        const cursor = store.cursors[i] || 0;
        const chips = slots
          .map((id, si) => {
            const def = getType(id);
            const next = si === cursor % slots.length;
            return (
              `<span class="lp-armed-ammo-chip${next ? ' is-next' : ''}" data-ammo-id="${def.id}">` +
              `${def.tag}</span>`
            );
          })
          .join('<span class="lp-armed-ammo-chip-sep">/</span>');
        btn.innerHTML =
          `<span class="lp-armed-ammo-tag">组 ${i + 1}</span>` +
          `<span class="lp-armed-ammo-sub lp-armed-ammo-belt-pattern">${chips}</span>` +
          `<span class="lp-armed-ammo-key">${i + 1}</span>`;
        btn.addEventListener('click', () => selectBeltIndex(i, { toast: true }));
        bindHoverDetail(btn, (e) =>
          showBeltDetail(i, { clientX: e.clientX, clientY: e.clientY })
        );
        frag.appendChild(btn);
      });
    } else {
      cfg.allowedTypes.forEach((id, i) => {
        const def = getType(id);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-armed-ammo-slot';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', i === state.typeIndex ? 'true' : 'false');
        btn.classList.toggle('is-active', i === state.typeIndex);
        btn.dataset.ammoId = def.id;
        btn.dataset.index = String(i);
        btn.innerHTML =
          `<span class="lp-armed-ammo-tag">${def.tag}</span>` +
          `<span class="lp-armed-ammo-sub">${def.subtitle}</span>` +
          `<span class="lp-armed-ammo-key">${i + 1}</span>`;
        btn.addEventListener('click', () => selectTypeIndex(i, { toast: true }));
        bindHoverDetail(btn, (e) =>
          showTypeDetail(def.id, { clientX: e.clientX, clientY: e.clientY })
        );
        frag.appendChild(btn);
      });
    }
    listEl.replaceChildren(frag);
  }

  /**
   * 进入武装操控：启用该车厢能力并显示底栏。
   * @param {string} carriageId
   */
  function activate(carriageId) {
    const id = String(carriageId || '').trim();
    if (!CARRIAGES[id]) return;
    state.carriageId = id;
    const cfg = CARRIAGES[id];
    if (cfg.supportsBelts) {
      const store = beltStore(id);
      state.activeBeltIndex = store.activeBeltIndex;
    } else if (state.typeIndex < 0 || state.typeIndex >= cfg.allowedTypes.length) {
      state.typeIndex = 0;
    }
    render();
  }

  /** 离席：隐藏底栏。 */
  function deactivate() {
    state.carriageId = null;
    hideDetail();
    render();
  }

  /** 选中弹链组（0-based）；保留各组 cursor。 */
  function selectBeltIndex(index, opts = {}) {
    const cid = opts.carriageId || state.carriageId;
    const store = beltStore(cid);
    if (!store || index < 0 || index >= store.belts.length) return false;
    store.activeBeltIndex = index;
    if (!state.carriageId || state.carriageId === (getCarriage(cid)?.id || cid)) {
      state.activeBeltIndex = index;
    }
    savePersisted();
    render();
    renderBeltEditor();
    if (opts.toast) {
      const pattern = formatBeltPattern(store.belts[index]);
      window.LiminalInteract?.showToast?.(`选中 「弹链 ${index + 1} · ${pattern}」`);
    }
    return true;
  }

  /** 单弹种模式：按 allowedTypes 下标选中。 */
  function selectTypeIndex(index, opts = {}) {
    const loadout = getLoadout();
    if (!loadout.length || index < 0 || index >= loadout.length) return false;
    state.typeIndex = index;
    render();
    if (opts.toast) {
      const def = getType(loadout[index]);
      window.LiminalInteract?.showToast?.(`选中 「${def.tag} ${def.subtitle}」`);
    }
    return true;
  }

  /**
   * 兼容旧 API：弹链模式选组；单弹种模式选类型。
   * @param {number} index
   * @param {{ toast?: boolean }} [opts]
   */
  function selectIndex(index, opts = {}) {
    if (supportsBelts()) return selectBeltIndex(index, opts);
    return selectTypeIndex(index, opts);
  }

  /** 循环切换下一弹链/弹种（与 handsHud 共用键）。 */
  function cycle(opts = {}) {
    if (!isActive()) return false;
    if (supportsBelts()) {
      const store = beltStore();
      if (!store?.belts.length) return false;
      const next = (store.activeBeltIndex + 1) % store.belts.length;
      return selectBeltIndex(next, { toast: opts.toast !== false });
    }
    const loadout = getLoadout();
    if (!loadout.length) return false;
    return selectTypeIndex((state.typeIndex + 1) % loadout.length, {
      toast: opts.toast !== false,
    });
  }

  /** 数字键 1…N → 选中对应组/弹种。 */
  function selectByNumber(oneBased) {
    return selectIndex(oneBased - 1, { toast: true });
  }

  /** 循环某槽位弹种（编辑器用）。 */
  function cycleSlotType(currentId, cfg) {
    const allowed = cfg.allowedTypes;
    const i = allowed.indexOf(currentId);
    return allowed[(i + 1 + allowed.length) % allowed.length] || allowed[0];
  }

  /** 添加一组弹链（不超过 maxBelts）。 */
  function addBelt(carriageId) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store || store.belts.length >= cfg.maxBelts) return false;
    store.belts.push(normalizeSlots(cfg.defaultSlots, cfg));
    store.cursors.push(0);
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 删除一组弹链（至少保留 1 组）。 */
  function removeBelt(carriageId, beltIndex) {
    const store = beltStore(carriageId);
    if (!store || store.belts.length <= 1) return false;
    if (beltIndex < 0 || beltIndex >= store.belts.length) return false;
    store.belts.splice(beltIndex, 1);
    store.cursors.splice(beltIndex, 1);
    if (store.activeBeltIndex >= store.belts.length) {
      store.activeBeltIndex = store.belts.length - 1;
    }
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 设置某组某槽弹种。 */
  function setBeltSlot(carriageId, beltIndex, slotIndex, ammoId) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store) return false;
    if (beltIndex < 0 || beltIndex >= store.belts.length) return false;
    if (slotIndex < 0 || slotIndex >= cfg.slotsPerBelt) return false;
    const id = String(ammoId || '').toLowerCase();
    if (!cfg.allowedTypes.includes(id)) return false;
    store.belts[beltIndex][slotIndex] = id;
    savePersisted();
    render();
    renderBeltEditor();
    return true;
  }

  /** 点击槽位：在 allowedTypes 间循环。 */
  function cycleBeltSlot(carriageId, beltIndex, slotIndex) {
    const cfg = getCarriage(carriageId);
    const store = beltStore(carriageId);
    if (!cfg || !store) return false;
    const cur = store.belts[beltIndex]?.[slotIndex];
    if (!cur) return false;
    return setBeltSlot(carriageId, beltIndex, slotIndex, cycleSlotType(cur, cfg));
  }

  /** 渲染弹药箱底栏：弹链编辑 或 弹种介绍（按 supportsBelts）。 */
  function renderCrateBottom() {
    if (!crateBottomHost) return;
    const carriageId = crateBottomHost.dataset.carriageId || 'guard';
    const cfg = getCarriage(carriageId);
    crateBottomHost.replaceChildren();
    if (!cfg) {
      crateBottomHost.hidden = true;
      return;
    }
    crateBottomHost.hidden = false;
    crateBottomHost.classList.toggle('is-belt-mode', Boolean(cfg.supportsBelts));
    crateBottomHost.classList.toggle('is-type-mode', !cfg.supportsBelts);
    if (cfg.supportsBelts) {
      renderBeltEditorInto(crateBottomHost, carriageId, cfg);
    } else {
      renderTypeIntroInto(crateBottomHost, carriageId, cfg);
    }
  }

  /** 兼容旧名：刷新底栏。 */
  function renderBeltEditor() {
    renderCrateBottom();
  }

  /**
   * 火炮类底栏：弹种介绍 + 单选（不可建弹链）。
   * @param {HTMLElement} host
   * @param {string} carriageId
   * @param {object} cfg
   */
  function renderTypeIntroInto(host, carriageId, cfg) {
    const header = document.createElement('div');
    header.className = 'lp-guard-belt-header';
    const title = document.createElement('span');
    title.className = 'lp-guard-belt-title';
    title.textContent = '弹种';
    const note = document.createElement('span');
    note.className = 'lp-guard-type-note';
    note.textContent = '火炮仅可选弹种';
    header.append(title, note);
    host.appendChild(header);

    const list = document.createElement('div');
    list.className = 'lp-guard-type-list';
    cfg.allowedTypes.forEach((id, i) => {
      const def = getType(id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'lp-guard-type-card';
      card.dataset.ammoId = def.id;
      const active =
        state.carriageId === carriageId
          ? state.typeIndex === i
          : i === 0;
      card.classList.toggle('is-active', active);
      card.innerHTML =
        `<span class="lp-guard-type-tag">${def.tag}</span>` +
        `<span class="lp-guard-type-name">${def.subtitle}</span>` +
        `<span class="lp-guard-type-use">${def.use || ''}</span>`;
      card.addEventListener('click', () => {
        if (state.carriageId !== carriageId) activate(carriageId);
        selectTypeIndex(i, { toast: true });
        renderCrateBottom();
      });
      bindHoverDetail(card, (e) =>
        showTypeDetail(def.id, { clientX: e.clientX, clientY: e.clientY })
      );
      list.appendChild(card);
    });
    host.appendChild(list);

    const hint = document.createElement('p');
    hint.className = 'lp-guard-belt-hint';
    hint.textContent = '本车厢不支持自定义弹链；入座后用底栏或数字键切换弹种。';
    host.appendChild(hint);
  }

  /**
   * 连发类底栏：弹链创建/编辑。
   * @param {HTMLElement} host
   * @param {string} carriageId
   * @param {object} cfg
   */
  function renderBeltEditorInto(host, carriageId, cfg) {
    const store = beltStore(carriageId);

    const header = document.createElement('div');
    header.className = 'lp-guard-belt-header';
    const title = document.createElement('span');
    title.className = 'lp-guard-belt-title';
    title.textContent = '弹链';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'lp-guard-belt-add';
    addBtn.textContent = '添加弹链';
    addBtn.disabled = store.belts.length >= cfg.maxBelts;
    addBtn.title =
      store.belts.length >= cfg.maxBelts
        ? `最多 ${cfg.maxBelts} 组`
        : `还可添加 ${cfg.maxBelts - store.belts.length} 组`;
    addBtn.addEventListener('click', () => {
      if (addBelt(carriageId)) {
        window.LiminalInteract?.showToast?.(
          `已添加弹链 ${store.belts.length}`
        );
      }
    });
    header.append(title, addBtn);
    host.appendChild(header);

    const list = document.createElement('div');
    list.className = 'lp-guard-belt-list';
    store.belts.forEach((slots, bi) => {
      const row = document.createElement('div');
      row.className = 'lp-guard-belt-row';
      row.classList.toggle('is-active', bi === store.activeBeltIndex);
      row.dataset.beltIndex = String(bi);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'lp-guard-belt-label';
      label.textContent = `组 ${bi + 1}`;
      label.setAttribute('aria-pressed', bi === store.activeBeltIndex ? 'true' : 'false');
      label.addEventListener('click', () =>
        selectBeltIndex(bi, { toast: true, carriageId })
      );
      bindHoverDetail(label, (e) =>
        showBeltDetail(bi, {
          clientX: e.clientX,
          clientY: e.clientY,
          carriageId,
        })
      );

      const slotsEl = document.createElement('div');
      slotsEl.className = 'lp-guard-belt-slots';
      slots.forEach((id, si) => {
        const def = getType(id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'lp-guard-belt-chip';
        chip.dataset.ammoId = def.id;
        chip.textContent = def.tag;
        chip.title = `切换 · ${def.tag} ${def.subtitle}`;
        chip.addEventListener('click', () => {
          cycleBeltSlot(carriageId, bi, si);
          const next = getType(store.belts[bi][si]);
          window.LiminalInteract?.showToast?.(
            `弹链 ${bi + 1} 槽 ${si + 1} → 「${next.tag} ${next.subtitle}」`
          );
        });
        bindHoverDetail(chip, (e) =>
          showTypeDetail(def.id, { clientX: e.clientX, clientY: e.clientY })
        );
        slotsEl.appendChild(chip);
        if (si < slots.length - 1) {
          const sep = document.createElement('span');
          sep.className = 'lp-guard-belt-sep';
          sep.textContent = '/';
          sep.setAttribute('aria-hidden', 'true');
          slotsEl.appendChild(sep);
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'lp-guard-belt-remove';
      removeBtn.textContent = '删除';
      removeBtn.disabled = store.belts.length <= 1;
      removeBtn.addEventListener('click', () => {
        if (removeBelt(carriageId, bi)) {
          window.LiminalInteract?.showToast?.('已删除弹链');
        }
      });

      row.append(label, slotsEl, removeBtn);
      list.appendChild(row);
    });
    host.appendChild(list);

    const hint = document.createElement('p');
    hint.className = 'lp-guard-belt-hint';
    hint.textContent = `连发按组内顺序循环（如 T/AP/AP）。最多 ${cfg.maxBelts} 组 · 每组 ${cfg.slotsPerBelt} 槽。`;
    host.appendChild(hint);
  }

  /**
   * 将弹药箱底栏挂到容器：supportsBelts → 弹链编辑，否则弹种介绍。
   * @param {HTMLElement | null} host
   * @param {string} [carriageId='guard']
   */
  function mountCrateBottom(host, carriageId = 'guard') {
    crateBottomHost = host || null;
    if (!crateBottomHost) return;
    crateBottomHost.dataset.carriageId = carriageId;
    crateBottomHost.classList.add('lp-guard-ammo-bottom');
    renderCrateBottom();
  }

  /** @deprecated 同 mountCrateBottom */
  function mountBeltEditor(host, carriageId = 'guard') {
    mountCrateBottom(host, carriageId);
  }

  /** 卸下弹药箱底栏。 */
  function unmountCrateBottom() {
    if (crateBottomHost) {
      crateBottomHost.replaceChildren();
      crateBottomHost.hidden = true;
      crateBottomHost.classList.remove('is-belt-mode', 'is-type-mode');
    }
    crateBottomHost = null;
    hideDetail();
  }

  /** @deprecated 同 unmountCrateBottom */
  function unmountBeltEditor() {
    unmountCrateBottom();
  }

  /**
   * 注册 / 覆盖武装车厢能力（未来火炮等）。
   * @param {string} id
   * @param {object} cfg
   */
  function registerCarriage(id, cfg) {
    const key = String(id || '').trim();
    if (!key || !cfg) return;
    CARRIAGES[key] = {
      id: key,
      label: cfg.label || key,
      allowedTypes: (cfg.allowedTypes || cfg.loadout || ['ap']).slice(),
      supportsBelts: Boolean(cfg.supportsBelts),
      maxBelts: cfg.maxBelts ?? 2,
      slotsPerBelt: cfg.slotsPerBelt ?? 3,
      defaultSlots: cfg.defaultSlots || null,
    };
    LOADOUTS[key] = CARRIAGES[key].allowedTypes.slice();
    if (!CARRIAGES[key].defaultSlots) {
      const t0 = CARRIAGES[key].allowedTypes[0];
      CARRIAGES[key].defaultSlots = Array(CARRIAGES[key].slotsPerBelt).fill(t0);
    }
  }

  loadPersisted();
  ensureDom();
  render();

  window.addEventListener('lp:turret-enter', () => {
    activate('guard');
  });
  window.addEventListener('lp:turret-exit', () => {
    deactivate();
  });
  const obs = new MutationObserver(render);
  obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.LpArmedAmmo = {
    AMMO_TYPES,
    CARRIAGES,
    LOADOUTS,
    getType,
    getCarriage,
    supportsBelts,
    getLoadout,
    getSelected,
    getSelectedId,
    peekFireTypeId,
    advanceFireCursor,
    formatBeltPattern,
    getActiveBeltSlots,
    beltsToJSON,
    applyBeltsFromSnapshot,
    isActive,
    activate,
    deactivate,
    selectIndex,
    selectBeltIndex,
    selectTypeIndex,
    selectByNumber,
    cycle,
    addBelt,
    removeBelt,
    setBeltSlot,
    cycleBeltSlot,
    mountBeltEditor,
    unmountBeltEditor,
    mountCrateBottom,
    unmountCrateBottom,
    renderBeltEditor,
    renderCrateBottom,
    showTypeDetail,
    showBeltDetail,
    hideDetail,
    registerCarriage,
    render,
  };
})();
