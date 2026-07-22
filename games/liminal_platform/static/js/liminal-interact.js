/**
 * 阈限月台可交互物体：支持同车厢多节点（燃烧室 / 控制台等）。
 */
(() => {
  const InteractSpec = window.LiminalInteractSpec;

  const INTERACTABLES = InteractSpec.buildInteractables();
  const FUEL_PER_COAL = 18;
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

  /** 从背包扣煤并加燃料。 */
  function addFuel() {
    if (fuel.level >= fuel.max) {
      showToast('锅炉燃料已满');
      return false;
    }

    const inventory = window.LpInventory;
    const playerInv = inventory?.getPlayerInventory?.();
    if (!playerInv) {
      showToast('无法读取背包');
      return false;
    }

    const coalCount = playerInv.countItem('coal');
    if (coalCount <= 0) {
      showToast('背包没有煤炭');
      return false;
    }

    const room = fuel.max - fuel.level;
    const needCoal = Math.max(1, Math.ceil(room / FUEL_PER_COAL));
    const spend = Math.min(1, coalCount, needCoal);
    const removed = inventory.consumeItem('coal', spend);
    if (removed <= 0) {
      showToast('背包没有煤炭');
      return false;
    }

    fuel.level = Math.min(fuel.max, fuel.level + removed * FUEL_PER_COAL);
    showToast(`消耗煤炭 ×${removed}（${fuel.level}/${fuel.max}）`);
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: { level: fuel.level, coalSpent: removed },
      })
    );
    window.LiminalSession?.notifyFuelAdd?.(removed * FUEL_PER_COAL);
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
      default:
        console.warn('[liminal] unknown interact action', spot.action, spot.id);
        return false;
    }
  }

  /** 尝试对最近可交互节点执行交互。 */
  function tryInteract(local) {
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

  /** 仓储车厢：提示打开物品栏管理仓库。 */
  function drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, options = {}) {
    const { mobile = false } = options;
    const Spec = window.LiminalCarriageSpec;
    if (Spec?.carriageAt?.(local.x)?.id !== 'storage') return;
    if (!local.onGround || local.y > 0.5) return;
    if (window.LpInventory?.isOpen?.()) return;
    if (window.LpBoilerPanel?.isOpen?.() || window.LpFuelFeed?.isOpen?.()) return;

    const line = mobile
      ? '点「物品」打开物品栏以管理仓库'
      : `按 ${inventoryKeyLabel} 打开物品栏以管理仓库`;
    const screenX = local.x * view.zoom + view.offsetX;
    const screenY = (Spec.FLOOR_Y - 110) * view.zoom + view.offsetY;
    drawFloatingLabel(ctx, dpr, screenX, screenY, line);
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
          : `${drive.speed > 0 ? '↑' : '↓'}${Math.abs(drive.speed).toFixed(1)} · ${drive.throttleLabel}`;
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
    const active = findActive(local);
    const panelOpen = window.LpBoilerPanel?.isOpen?.();
    if (active && showPrompt && !panelOpen) {
      drawPrompt(ctx, active, view, dpr, keyLabel);
    } else if (!active && !panelOpen) {
      drawStoragePrompt(ctx, local, view, dpr, inventoryKeyLabel, { mobile });
    }
    drawHud(ctx, view, dpr);
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
