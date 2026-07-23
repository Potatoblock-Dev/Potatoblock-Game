/**
 * 添加燃料：炉口与燃料架并排；按目录 listBoilerFuels 动态生成燃料格，拖入炉口燃烧。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const root = document.getElementById('lpFuelFeedRoot');
  const closeButton = document.getElementById('lpFuelFeedClose');
  const dropZone = document.getElementById('lpFuelDropZone');
  const sourceGrid = document.getElementById('lpFuelSourceGrid');
  const ghost = document.getElementById('lpFuelDragGhost');
  const flameCanvas = document.getElementById('lpFuelFlameCanvas');
  const hintDesktop = document.getElementById('lpFuelFeedHintDesktop');

  if (!root || !dropZone || !sourceGrid || !ghost) return;

  let open = false;
  /** @type {{ pointerId: number, itemId: string, slotEl: HTMLElement } | null} */
  let drag = null;
  /** @type {{ x:number, y:number, vx:number, vy:number, life:number, age:number, size:number, hue:number, alpha:number }[]} */
  let particles = [];
  let flameRaf = 0;
  let flameLastTs = 0;
  let burnUntil = 0;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 背包中某燃料数量。 */
  function countFuel(itemId) {
    return window.LpInventory?.getPlayerInventory?.()?.countItem?.(itemId) ?? 0;
  }

  /** 是否持有任意可燃燃料。 */
  function hasAnyFuel() {
    const fuels = Catalog?.listBoilerFuels?.() || [];
    return fuels.some((item) => countFuel(item.id) > 0);
  }

  /** 构建 / 刷新燃料架（每种 boilerFuel 物品一格）。 */
  function renderFuelRack() {
    const fuels = Catalog?.listBoilerFuels?.() || [];
    if (sourceGrid.childElementCount !== fuels.length) {
      sourceGrid.replaceChildren();
      for (const item of fuels) {
        const wrap = document.createElement('div');
        wrap.className = 'lp-fuel-source-wrap';
        wrap.dataset.itemId = item.id;

        const caption = document.createElement('span');
        caption.className = 'lp-fuel-source-caption';
        caption.textContent = item.name;

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lp-fuel-item-slot';
        button.dataset.itemId = item.id;
        button.setAttribute('aria-label', `拖动${item.name}`);

        const icon = document.createElement('span');
        icon.className = 'lp-fuel-item-icon';
        icon.style.setProperty('--item-color', item.color);
        icon.style.setProperty('--item-accent', item.accent);
        if (item.icon) {
          icon.classList.add('has-image');
          icon.style.backgroundImage = `url("${item.icon}")`;
          icon.textContent = '';
        } else {
          icon.textContent = item.short;
        }
        icon.setAttribute('aria-hidden', 'true');

        const qty = document.createElement('span');
        qty.className = 'lp-fuel-item-qty';

        button.append(icon, qty);
        wrap.append(caption, button);
        sourceGrid.appendChild(wrap);

        button.addEventListener('pointerdown', (event) => {
          if (event.button != null && event.button !== 0) return;
          beginDrag(event, item.id, button);
        });
      }
    }

    for (const wrap of sourceGrid.querySelectorAll('.lp-fuel-source-wrap')) {
      const itemId = wrap.dataset.itemId;
      const item = Catalog?.getItem?.(itemId);
      const button = wrap.querySelector('.lp-fuel-item-slot');
      const qty = wrap.querySelector('.lp-fuel-item-qty');
      const icon = wrap.querySelector('.lp-fuel-item-icon');
      if (!item || !button) continue;
      const count = countFuel(itemId);
      if (qty) qty.textContent = String(count);
      if (icon) {
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
      button.classList.toggle('is-empty', count <= 0);
      button.disabled = count <= 0;
      const caption = wrap.querySelector('.lp-fuel-source-caption');
      if (caption) caption.textContent = item.name;
    }
  }

  /** 同步桌面离席提示。 */
  function syncLeaveHint() {
    if (!hintDesktop) return;
    const key = window.LpInputBindings?.formatAction('interact') || 'F';
    hintDesktop.textContent = `将燃料拖入炉口 · ${key} 离席`;
  }

  /** 同步火焰 canvas 像素尺寸。 */
  function resizeFlameCanvas() {
    if (!flameCanvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, dropZone.clientWidth);
    const h = Math.max(1, dropZone.clientHeight);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (flameCanvas.width !== pw || flameCanvas.height !== ph) {
      flameCanvas.width = pw;
      flameCanvas.height = ph;
    }
    return { w, h, dpr };
  }

  /** 在炉口底部喷出若干火焰粒子。 */
  function spawnFlames(count, burst) {
    const size = resizeFlameCanvas();
    if (!size) return;
    const { w, h } = size;
    for (let i = 0; i < count; i += 1) {
      const spread = burst ? 0.42 : 0.22;
      particles.push({
        x: w * (0.5 + (Math.random() - 0.5) * spread),
        y: h * (0.78 + Math.random() * 0.1),
        vx: (Math.random() - 0.5) * (burst ? 70 : 28),
        vy: -(burst ? 55 : 30) - Math.random() * (burst ? 110 : 55),
        life: (burst ? 0.55 : 0.35) + Math.random() * (burst ? 0.75 : 0.45),
        age: 0,
        size: (burst ? 6 : 3) + Math.random() * (burst ? 12 : 7),
        hue: 18 + Math.random() * 42,
        alpha: 0.55 + Math.random() * 0.4,
      });
    }
  }

  /** 投入燃料后的爆发，并维持一段时间余烬。 */
  function igniteMouth() {
    burnUntil = performance.now() + 5200;
    dropZone.classList.add('is-burning');
    spawnFlames(36, true);
    startFlameLoop();
  }

  /** 停止火焰循环并清空粒子。 */
  function stopFlames() {
    if (flameRaf) {
      cancelAnimationFrame(flameRaf);
      flameRaf = 0;
    }
    flameLastTs = 0;
    particles = [];
    burnUntil = 0;
    dropZone.classList.remove('is-burning');
    if (flameCanvas) {
      const ctx = flameCanvas.getContext('2d');
      ctx?.clearRect(0, 0, flameCanvas.width, flameCanvas.height);
    }
  }

  /** 驱动火焰粒子动画。 */
  function startFlameLoop() {
    if (!flameCanvas || flameRaf) return;
    const tick = (ts) => {
      if (!open) {
        flameRaf = 0;
        return;
      }
      if (!flameLastTs) flameLastTs = ts;
      const dt = Math.min((ts - flameLastTs) / 1000, 0.05);
      flameLastTs = ts;

      const now = performance.now();
      const burning = now < burnUntil;
      if (burning && Math.random() < 0.55) {
        spawnFlames(1 + Math.floor(Math.random() * 2), false);
      }

      const size = resizeFlameCanvas();
      const ctx = flameCanvas.getContext('2d');
      if (!size || !ctx) {
        flameRaf = requestAnimationFrame(tick);
        return;
      }
      const { w, h, dpr } = size;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      const next = [];
      for (const p of particles) {
        p.age += dt;
        if (p.age >= p.life) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.96;
        p.vy -= 35 * dt;
        p.size *= 0.985;
        const t = p.age / p.life;
        const alpha = p.alpha * (1 - t) * (t < 0.12 ? t / 0.12 : 1);
        const r = Math.max(0.5, p.size * (1 - t * 0.35));
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, `hsla(${p.hue + 20}, 100%, 78%, ${alpha})`);
        grad.addColorStop(0.45, `hsla(${p.hue}, 100%, 52%, ${alpha * 0.85})`);
        grad.addColorStop(1, `hsla(${p.hue - 8}, 95%, 28%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        next.push(p);
      }
      particles = next;
      ctx.globalCompositeOperation = 'source-over';

      if (!burning && particles.length === 0) {
        dropZone.classList.remove('is-burning');
        flameRaf = 0;
        flameLastTs = 0;
        return;
      }
      flameRaf = requestAnimationFrame(tick);
    };
    flameRaf = requestAnimationFrame(tick);
  }

  /** 打开加燃料模式。 */
  function openPanel() {
    if (open) return;
    if (window.LpInventory?.isOpen()) window.LpInventory.close();
    if (window.LpBoilerPanel?.isOpen()) window.LpBoilerPanel.close();
    if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-fuel-feed-open');
    window.LpTouchControls?.setEnabled(false);
    syncLeaveHint();
    window.LpGame?.faceTrainForward?.();
    renderFuelRack();
    resizeFlameCanvas();
    if (!hasAnyFuel()) {
      window.LiminalInteract?.showToast?.('背包没有可用燃料');
    }
  }

  /** 关闭加燃料模式。 */
  function closePanel() {
    if (!open) return;
    endDrag(false);
    stopFlames();
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

  /** 放置拖拽幽灵并套用当前燃料外观。 */
  function placeGhost(clientX, clientY, itemId) {
    const item = Catalog?.getItem?.(itemId);
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
  function endDrag(_committed) {
    if (drag?.slotEl) drag.slotEl.classList.remove('is-dragging');
    drag = null;
    ghost.hidden = true;
    dropZone.classList.remove('is-hot');
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

  /** 开始拖出一格燃料。 */
  function beginDrag(event, itemId, slotEl) {
    if (!open || countFuel(itemId) <= 0) return;
    drag = { pointerId: event.pointerId, itemId, slotEl };
    slotEl.classList.add('is-dragging');
    placeGhost(event.clientX, event.clientY, itemId);
    slotEl.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    placeGhost(event.clientX, event.clientY, drag.itemId);
    dropZone.classList.toggle('is-hot', overDropZone(event.clientX, event.clientY));
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const itemId = drag.itemId;
    const hit = overDropZone(event.clientX, event.clientY);
    endDrag(hit);
    if (hit) {
      const ok = window.LiminalInteract?.addFuel?.(itemId);
      renderFuelRack();
      if (ok) igniteMouth();
    }
  });

  window.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    endDrag(false);
  });

  closeButton?.addEventListener('click', closePanel);
  window.addEventListener('resize', () => {
    if (open) resizeFlameCanvas();
  });

  window.addEventListener('liminal:fuel-changed', () => {
    if (open) renderFuelRack();
  });
  window.addEventListener('lp:bindings-changed', syncLeaveHint);

  window.LpFuelFeed = {
    open: openPanel,
    close: closePanel,
    toggle,
    isOpen,
    syncSlot: renderFuelRack,
  };
})();
