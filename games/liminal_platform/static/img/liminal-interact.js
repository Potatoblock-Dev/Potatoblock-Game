/**
 * 阈限月台可交互物体：支持同车厢多节点（燃烧室 / 控制台等）。
 */
(() => {
  const InteractSpec = window.LiminalInteractSpec;

  const INTERACTABLES = InteractSpec.buildInteractables();
  const Catalog = window.LpItemCatalog;
  const fuel = { level: 35, max: 100 };
  let toastText = '';
  let toastUntil = 0;

  /** 显示短暂提示。 */
  function showToast(text, ms = 1800) {
    toastText = text;
    toastUntil = performance.now() + ms;
  }

  /** 玩家是否满足交互条件（站地且靠近）。 */
  function canInteract(spot, local) {
    if (!local.onGround || local.y > 0.5) return false;
    return Math.abs(local.x - spot.worldX) <= spot.interactRadiusX;
  }

  /**
   * 返回当前最近的可交互节点。
   * 同车厢多节点时按水平距离选最近。
   */
  function findActive(local) {
    let best = null;
    let bestDist = Infinity;
    for (const spot of INTERACTABLES) {
      if (!canInteract(spot, local)) continue;
      const dist = Math.abs(local.x - spot.worldX);
      if (dist < bestDist) {
        best = spot;
        bestDist = dist;
      }
    }
    return best;
  }

  /** 列出当前范围内全部节点（调试 / 扩展用）。 */
  function findAllActive(local) {
    return INTERACTABLES.filter((spot) => canInteract(spot, local));
  }

  /**
   * 从背包扣除指定燃料并加锅炉能量。
   * @param {string} [itemId='coal'] 燃料物品 id（须在目录中声明 boilerFuel）
   */
  function addFuel(itemId = 'coal') {
    if (fuel.level >= fuel.max) {
      showToast('锅炉燃料已满');
      return false;
    }

    const energyPer = Catalog?.getBoilerFuelValue?.(itemId) ?? 0;
    const item = Catalog?.getItem?.(itemId);
    if (!energyPer || !item) {
      showToast('无法作为锅炉燃料');
      return false;
    }

    const inventory = window.LpInventory;
    const playerInv = inventory?.getPlayerInventory?.();
    if (!playerInv) {
      showToast('无法读取背包');
      return false;
    }

    const have = playerInv.countItem(itemId);
    if (have <= 0) {
      showToast(`背包没有${item.name}`);
      return false;
    }

    const room = fuel.max - fuel.level;
    const needUnits = Math.max(1, Math.ceil(room / energyPer));
    const spend = Math.min(1, have, needUnits);
    const removed = inventory.consumeItem(itemId, spend);
    if (removed <= 0) {
      showToast(`背包没有${item.name}`);
      return false;
    }

    const gained = removed * energyPer;
    fuel.level = Math.min(fuel.max, fuel.level + gained);
    showToast(`消耗${item.name} ×${removed}（${fuel.level}/${fuel.max}）`);
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: {
          level: fuel.level,
          itemId,
          spent: removed,
          energy: gained,
          /** @deprecated 兼容旧监听；仅煤炭时有值 */
          coalSpent: itemId === 'coal' ? removed : 0,
        },
      })
    );
    window.LiminalSession?.notifyFuelAdd?.(gained);
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
    return true;
  }

  /** 应用服务端燃料权威值。 */
  function setFuelLevel(level) {
    fuel.level = Math.max(0, Math.min(fuel.max, Number(level) || 0));
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: { level: fuel.level, coalSpent: 0 },
      })
    );
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
  }

  /** 打开引擎控制台。 */
  function openDrivePanel() {
    window.LpBoilerPanel?.open();
    window.LpBoilerPanel?.syncFromState?.();
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    const fill = document.getElementById('lpFuelGaugeFill');
    if (fill) fill.style.height = `${Math.max(0, Math.min(100, fuel.level))}%`;
  }

  /** 按节点 action 分发。 */
  function runAction(spot) {
    switch (spot.action) {
      case 'addFuel':
        window.LpFuelFeed?.open();
        return true;
      case 'openDrivePanel':
        openDrivePanel();
        return true;
      case 'enterTurretLeft':
        return window.LpGuardTurret?.interactTurret?.('left') ?? false;
      case 'enterTurretRight':
        return window.LpGuardTurret?.interactTurret?.('right') ?? false;
      case 'guardAmmo':
        return window.LpGuardTurret?.interactAmmoBox?.() ?? false;
      case 'guardRecycle':
        return window.LpGuardTurret?.interactRecycleBox?.() ?? false;
      default:
        console.warn('[liminal] unknown interact action', spot.action, spot.id);
        return false;
    }
  }

  /** 尝试对最近可交互节点执行交互。 */
  function tryInteract(local) {
    if (window.LpGuardTurret?.isManned?.()) {
      window.LpGuardTurret.exitTurret();
      return true;
    }
    const spot = findActive(local);
    if (!spot) return false;
    return runAction(spot);
  }

  /** 绘制靠近提示（屏幕空间）。 */
  function drawPrompt(ctx, spot, view, dpr, keyLabel) {
    const line = `按 ${keyLabel} ${spot.actionLabel}`;
    drawFloatingLabel(
      ctx,
      dpr,
      spot.worldX * view.zoom + view.offsetX,
      spot.promptAnchorY * view.zoom + view.offsetY,
      line
    );
  }

  /** 在屏幕坐标绘制浮动提示条。 */
  function drawFloatingLabel(ctx, dpr, screenX, screenY, line) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const labelW = ctx.measureText(line).width + 22;
    const labelH = 34;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
    ctx.beginPath();
    ctx.roundRect(screenX - labelW / 2, screenY - labelH / 2, labelW, labelH, 8);
    ctx.fill();

    ctx.fillStyle = '#fef3c7';
    ctx.fillText(line, screenX, screenY);
  }

  /**
   * 整节车厢通用操作：提示钉在该车厢水平中心、车顶上方。
   */
  function drawCarriageWidePrompt(ctx, car, view, dpr, line) {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec || !car) return;
    const midX = car.worldX + (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    /** 贴图顶部附近，落在车厢屋顶上方。 */
    const promptY = Spec.scaleArt ? Spec.scaleArt(168) : 168;
    drawFloatingLabel(
      ctx,
      dpr,
      midX * view.zoom + view.offsetX,
      promptY * view.zoom + view.offsetY,
      line
    );
  }

  /** 仓储车厢：整节可用，提示钉在车厢上方。 */
  function drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, options = {}) {
    const { mobile = false } = options;
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageAt?.(local.x);
    if (car?.id !== 'storage') return;
    if (!local.onGround || local.y > 0.5) return;
    if (window.LpInventory?.isOpen?.()) return;
    if (window.LpBoilerPanel?.isOpen?.() || window.LpFuelFeed?.isOpen?.()) return;

    const line = mobile
      ? '点「物品」打开物品栏以管理仓库'
      : `按 ${inventoryKeyLabel} 打开物品栏以管理仓库`;
    drawCarriageWidePrompt(ctx, car, view, dpr, line);
  }

  /** 绘制燃料条与操作反馈。 */
  function drawHud(ctx, view, dpr) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const barX = 14;
    const barY = 56;
    const barW = 120;
    const barH = 8;
    const ratio = fuel.level / fuel.max;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fillRect(barX - 2, barY - 18, barW + 4, 30);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('锅炉燃料', barX, barY - 16);
    ctx.fillStyle = 'rgba(51, 65, 85, 0.9)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = ratio > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(barX, barY, barW * ratio, barH);

    const drive = window.LpTrainDrive?.getState?.();
    if (drive) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.fillRect(barX - 2, barY + 16, barW + 4, 34);
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('列车', barX, barY + 18);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '600 12px system-ui, sans-serif';
      const speedText =
        Math.abs(drive.speed) < 0.08
          ? '静止'
          : `${drive.speed > 0 ? '→' : '←'}${Math.abs(drive.speed).toFixed(1)} · ${drive.throttleLabel}`;
      ctx.fillText(speedText, barX, barY + 32);
    }

    if (performance.now() < toastUntil && toastText) {
      ctx.font = '600 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      const tw = ctx.measureText(toastText).width + 24;
      const cx = (window.innerWidth || 800) / 2;
      const cy = (window.innerHeight || 600) * 0.38;
      ctx.beginPath();
      ctx.roundRect(cx - tw / 2, cy - 16, tw, 32, 8);
      ctx.fill();
      ctx.fillStyle = '#fde68a';
      ctx.fillText(toastText, cx, cy);
    }
  }

  /** 绘制最近激活节点的提示。 */
  function drawActivePrompt(ctx, local, view, dpr, keyLabel, options = {}) {
    const { showPrompt = true, inventoryKeyLabel = 'Tab', mobile = false } = options;
    if (window.LpGuardTurret?.isManned?.()) {
      if (showPrompt) {
        const ammo = window.LpGuardTurret.ammoCount?.() ?? 0;
        drawFloatingLabel(
          ctx,
          dpr,
          viewWCenter(),
          (window.innerHeight || 600) * 0.12,
          `炮塔中 · 弹药 ${ammo} · 按 ${keyLabel} 离席 · 左键开火`
        );
      }
      drawHud(ctx, view, dpr);
      return;
    }
    const active = findActive(local);
    const panelOpen = window.LpBoilerPanel?.isOpen?.();
    if (active && showPrompt && !panelOpen) {
      let label = spotActionLabel(active, keyLabel);
      drawFloatingLabel(
        ctx,
        dpr,
        active.worldX * view.zoom + view.offsetX,
        active.promptAnchorY * view.zoom + view.offsetY,
        label
      );
    } else if (!active && !panelOpen) {
      drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, { mobile });
    }
    drawHud(ctx, view, dpr);
  }

  /** 交互提示文案（弹药箱附带库存）。 */
  function spotActionLabel(spot, keyLabel) {
    if (spot.action === 'guardAmmo') {
      const n = window.LpGuardTurret?.ammoCount?.() ?? 0;
      return `按 ${keyLabel} ${spot.actionLabel}（箱内 ${n}）`;
    }
    if (spot.action === 'guardRecycle') {
      const n = window.LpGuardTurret?.casingCount?.() ?? 0;
      return `按 ${keyLabel} ${spot.actionLabel}（${n}）`;
    }
    return `按 ${keyLabel} ${spot.actionLabel}`;
  }

  /** 屏幕水平中心。 */
  function viewWCenter() {
    return (window.innerWidth || 800) / 2;
  }

  window.LiminalInteract = {
    findActive,
    findAllActive,
    tryInteract,
    drawActivePrompt,
    getFuelLevel: () => fuel.level,
    setFuelLevel,
    addFuel,
    addFuelFromPanel: addFuel,
    showToast,
    INTERACTABLES,
  };
})();
