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

    const added = removed * FUEL_PER_COAL;
    fuel.level = Math.min(fuel.max, fuel.level + added);
    showToast(`消耗煤炭 ×${removed}（${fuel.level}/${fuel.max}）`);
    window.LiminalNetworkSession?.sendFuelAdd?.(added);
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: { level: fuel.level, coalSpent: removed },
      })
    );
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
    return true;
  }

  /** 应用联机共享燃料量（服务端权威）。 */
  function applyFuelLevel(level) {
    const next = Math.max(0, Math.min(fuel.max, Number(level) || 0));
    if (Math.abs(next - fuel.level) < 0.01) return;
    fuel.level = next;
    window.dispatchEvent(
      new CustomEvent('liminal:fuel-changed', {
        detail: { level: fuel.level, fromNetwork: true },
      })
    );
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
  }

  /** 打开引擎控制台。 */
  function openDrivePanel() {
    window.LpBoilerPanel?.open();
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(fuel.level)}/100`;
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
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const screenX = spot.worldX * view.zoom + view.offsetX;
    const screenY = spot.promptAnchorY * view.zoom + view.offsetY;
    const labelW = ctx.measureText(line).width + 22;
    const labelH = 34;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
    ctx.beginPath();
    ctx.roundRect(screenX - labelW / 2, screenY - labelH / 2, labelW, labelH, 8);
    ctx.fill();

    ctx.fillStyle = '#fef3c7';
    ctx.fillText(line, screenX, screenY);
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
    const { showPrompt = true } = options;
    const active = findActive(local);
    const panelOpen = window.LpBoilerPanel?.isOpen?.();
    if (active && showPrompt && !panelOpen) drawPrompt(ctx, active, view, dpr, keyLabel);
    drawHud(ctx, view, dpr);
  }

  window.LiminalInteract = {
    findActive,
    findAllActive,
    tryInteract,
    drawActivePrompt,
    getFuelLevel: () => fuel.level,
    applyFuelLevel,
    addFuel,
    addFuelFromPanel: addFuel,
    showToast,
    INTERACTABLES,
  };
})();
