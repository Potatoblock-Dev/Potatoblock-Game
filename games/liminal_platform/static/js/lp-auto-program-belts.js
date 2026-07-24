/**
 * 枢机控制台：内联弹链槽位编辑器（复刻武装车厢弹药箱底栏 UX）。
 * 供 select_ammo 参数行挂载；编辑写入 action.params.slots，不依赖侧栏 beltsByCar。
 */
(() => {
  const Ammo = () => window.LpArmedAmmo;
  const Cat = () => window.LpAutoProgramCatalog;

  /** @type {HTMLElement | null} */
  let chooser = null;
  /** @type {{ host: HTMLElement, slotIndex: number, chip: HTMLElement } | null} */
  let openRef = null;
  let hideTimer = 0;

  /** 弱引用：host → 当前 slots 与回调，便于 chooser 写回。 */
  /** @type {WeakMap<HTMLElement, { carId: string, slots: string[], onChange: ((slots: string[]) => void) | null }>} */
  const hosts = new WeakMap();

  /** 是否粗指针（触控优先）。 */
  function isCoarsePointer() {
    return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches);
  }

  /** 确保弹种选择器挂在 body。 */
  function ensureChooser() {
    if (chooser) return;
    chooser = document.getElementById('lpAutoProgramBeltChooser');
    if (!chooser) {
      chooser = document.createElement('div');
      chooser.id = 'lpAutoProgramBeltChooser';
      chooser.className = 'lp-guard-belt-chooser lp-auto-program-belt-chooser';
      chooser.hidden = true;
      chooser.setAttribute('role', 'listbox');
      chooser.setAttribute('aria-label', '可选弹种');
      document.body.appendChild(chooser);
    }
    chooser.addEventListener('pointerenter', () => {
      if (hideTimer) {
        window.clearTimeout(hideTimer);
        hideTimer = 0;
      }
    });
    chooser.addEventListener('pointerleave', () => scheduleHide(180));
    if (document.documentElement.dataset.lpAutoBeltChooserDoc !== '1') {
      document.documentElement.dataset.lpAutoBeltChooserDoc = '1';
      document.addEventListener(
        'pointerdown',
        (event) => {
          if (!chooser || chooser.hidden) return;
          const t = event.target;
          if (!(t instanceof Node)) return;
          if (chooser.contains(t)) return;
          if (openRef?.chip?.contains(t)) return;
          hideChooser();
        },
        true
      );
    }
  }

  /** 延迟收起选择器。 */
  function scheduleHide(ms = 180) {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = 0;
      hideChooser();
    }, ms);
  }

  /** 关闭槽位弹种选择器。 */
  function hideChooser() {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (openRef?.chip) {
      openRef.chip.classList.remove('is-chooser-open');
      openRef.chip.setAttribute('aria-expanded', 'false');
    }
    openRef = null;
    if (!chooser) return;
    chooser.hidden = true;
    chooser.replaceChildren();
  }

  /** 将选择器定位到 chip 旁。 */
  function positionChooser(anchorEl) {
    if (!chooser || chooser.hidden || !anchorEl) return;
    const pad = 8;
    const gap = 4;
    const rect = anchorEl.getBoundingClientRect();
    const chooserRect = chooser.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - chooserRect.width / 2;
    left = Math.max(pad, Math.min(left, window.innerWidth - chooserRect.width - pad));
    let top = rect.top - chooserRect.height - gap;
    if (top < pad) top = rect.bottom + gap;
    if (top + chooserRect.height > window.innerHeight - pad) {
      top = Math.max(pad, window.innerHeight - chooserRect.height - pad);
    }
    chooser.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /**
   * 写回某一槽位弹种并通知 onChange。
   * @param {HTMLElement} host
   * @param {number} slotIndex
   * @param {string} ammoId
   */
  function setSlot(host, slotIndex, ammoId) {
    const state = hosts.get(host);
    if (!state) return false;
    const cfg = Ammo()?.getCarriage?.(state.carId);
    if (!cfg?.supportsBelts) return false;
    const id = String(ammoId || '').toLowerCase();
    if (!(cfg.allowedTypes || []).includes(id)) return false;
    if (slotIndex < 0 || slotIndex >= state.slots.length) return false;
    state.slots[slotIndex] = id;
    state.onChange?.(state.slots.slice());
    renderHost(host);
    return true;
  }

  /**
   * 展开槽位可选弹种（allowedTypes）。
   * @param {HTMLElement} host
   * @param {number} slotIndex
   * @param {HTMLElement} chip
   */
  function showChooser(host, slotIndex, chip) {
    const state = hosts.get(host);
    if (!state || !chip) return;
    const cfg = Ammo()?.getCarriage?.(state.carId);
    if (!cfg?.supportsBelts) return;
    ensureChooser();
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (openRef?.chip && openRef.chip !== chip) {
      openRef.chip.classList.remove('is-chooser-open');
      openRef.chip.setAttribute('aria-expanded', 'false');
    }
    openRef = { host, slotIndex, chip };
    chip.classList.add('is-chooser-open');
    chip.setAttribute('aria-expanded', 'true');

    const current = state.slots[slotIndex];
    const frag = document.createDocumentFragment();
    cfg.allowedTypes.forEach((id) => {
      const def = Ammo().getType(id);
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.className = 'lp-guard-belt-chooser-opt';
      opt.dataset.ammoId = def.id;
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', id === current ? 'true' : 'false');
      opt.classList.toggle('is-current', id === current);
      opt.innerHTML =
        `<span class="lp-guard-belt-chooser-tag">${def.tag}</span>` +
        `<span class="lp-guard-belt-chooser-name">${def.subtitle}</span>`;
      opt.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (setSlot(host, slotIndex, id)) {
          window.LiminalInteract?.showToast?.(
            `弹链槽 ${slotIndex + 1} → 「${def.tag} ${def.subtitle}」`
          );
          hideChooser();
        }
      });
      frag.appendChild(opt);
    });
    chooser.replaceChildren(frag);
    chooser.hidden = false;
    chooser.style.transform = 'translate(-9999px, -9999px)';
    requestAnimationFrame(() => positionChooser(chip));
  }

  /**
   * 绑定槽位 chip：悬停展开；粗指针点击展开；细指针点击循环。
   * @param {HTMLElement} host
   * @param {HTMLElement} chip
   * @param {number} slotIndex
   */
  function bindChip(host, chip, slotIndex) {
    chip.setAttribute('aria-haspopup', 'listbox');
    chip.setAttribute('aria-expanded', 'false');
    chip.addEventListener('pointerenter', (event) => {
      if (isCoarsePointer() || event.pointerType === 'touch') return;
      showChooser(host, slotIndex, chip);
    });
    chip.addEventListener('pointerleave', () => {
      if (isCoarsePointer()) return;
      scheduleHide();
    });
    chip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (isCoarsePointer()) {
        if (openRef?.chip === chip && chooser && !chooser.hidden) {
          hideChooser();
          return;
        }
        showChooser(host, slotIndex, chip);
        return;
      }
      const state = hosts.get(host);
      const cfg = Ammo()?.getCarriage?.(state?.carId);
      const cur = state?.slots?.[slotIndex];
      if (!cfg || !cur) return;
      const allowed = cfg.allowedTypes || [];
      const i = allowed.indexOf(cur);
      const next = allowed[(i + 1 + allowed.length) % allowed.length] || allowed[0];
      setSlot(host, slotIndex, next);
    });
  }

  /** 重绘单个内联弹链 host。 */
  function renderHost(host) {
    const state = hosts.get(host);
    if (!state) return;
    hideChooser();
    const cfg = Ammo()?.getCarriage?.(state.carId);
    host.replaceChildren();
    if (!cfg?.supportsBelts) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.classList.add('lp-auto-inline-belt', 'lp-guard-ammo-bottom', 'is-belt-mode');

    const slotsEl = document.createElement('div');
    slotsEl.className = 'lp-guard-belt-slots';
    state.slots.forEach((id, si) => {
      const def = Ammo().getType(id);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'lp-guard-belt-chip';
      chip.dataset.ammoId = def.id;
      chip.textContent = def.tag;
      chip.title = `悬停选择弹种 · 点击循环 · ${def.tag} ${def.subtitle}`;
      bindChip(host, chip, si);
      slotsEl.appendChild(chip);
      if (si < state.slots.length - 1) {
        const sep = document.createElement('span');
        sep.className = 'lp-guard-belt-sep';
        sep.textContent = '/';
        sep.setAttribute('aria-hidden', 'true');
        slotsEl.appendChild(sep);
      }
    });
    host.appendChild(slotsEl);
  }

  /**
   * 在参数行内挂载单组弹链槽位编辑器。
   * @param {HTMLElement | null} el
   * @param {string} carId
   * @param {string[]} slots
   * @param {{ onChange?: (slots: string[]) => void }} [opts]
   */
  function mountInline(el, carId, slots, opts) {
    if (!el || !carId) return;
    const normalized =
      Cat()?.normalizeAmmoSlots?.(carId, slots) ||
      (Array.isArray(slots) ? slots.slice() : ['ap', 'ap', 'ap']);
    hosts.set(el, {
      carId,
      slots: normalized.slice(),
      onChange: typeof opts?.onChange === 'function' ? opts.onChange : null,
    });
    renderHost(el);
  }

  /**
   * 卸下内联编辑器（可传单个 host；省略则仅关 chooser）。
   * @param {HTMLElement | null} [el]
   */
  function unmountInline(el) {
    hideChooser();
    if (el) {
      hosts.delete(el);
      el.replaceChildren();
    }
  }

  /** @deprecated 侧栏程序弹链已改为行为参数内联；保留空实现以免旧调用报错。 */
  function mount() {}

  /** 关闭选择器并清理（控制台关闭时调用）。 */
  function unmount() {
    hideChooser();
  }

  /** 无侧栏时为空操作。 */
  function render() {}

  window.LpAutoProgramBelts = {
    mountInline,
    unmountInline,
    mount,
    unmount,
    render,
  };
})();
