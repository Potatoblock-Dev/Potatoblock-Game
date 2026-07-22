/**
 * Avatar 大厅可交互物体：入口传送门等。
 */
(() => {
  const PORTALS = [
    {
      id: 'liminal-platform',
      title: '阈限月台',
      subtitle: 'Liminal Platform',
      url: '/liminal-platform',
      nx: 0.78,
      width: 56,
      height: 96,
      color: '#6366f1',
      stroke: '#4338ca',
      interactRadius: 80,
    },
  ];

  /** 地面线 y（与 avatar-lobby 绘制一致）。 */
  function groundLineY(groundY, avatarSize) {
    return groundY + avatarSize / 2;
  }

  /** 传送门在世界坐标中的中心 x。 */
  function portalCenterX(portal, nxToX) {
    return nxToX(portal.nx);
  }

  /** 玩家是否靠近且可交互（需站在地面）。 */
  function canInteract(portal, local, nxToX) {
    if (!local.onGround || local.y > 0.5) return false;
    const centerX = portalCenterX(portal, nxToX);
    return Math.abs(local.x - centerX) <= portal.interactRadius;
  }

  /** 查找当前可交互的传送门。 */
  function findActivePortal(local, nxToX) {
    for (const portal of PORTALS) {
      if (canInteract(portal, local, nxToX)) return portal;
    }
    return null;
  }

  /** 绘制色块入口与靠近时的名称/按键提示。 */
  function drawPortals(ctx, { groundY, avatarSize, nxToX, local, formatInteractKey, view, dpr }) {
    const ground = groundLineY(groundY, avatarSize);
    const active = findActivePortal(local, nxToX);

    for (const portal of PORTALS) {
      const cx = portalCenterX(portal, nxToX);
      const left = cx - portal.width / 2;
      const top = ground - portal.height;

      ctx.fillStyle = portal.color;
      ctx.fillRect(left, top, portal.width, portal.height);
      ctx.strokeStyle = portal.stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(left + 1, top + 1, portal.width - 2, portal.height - 2);

      if (active?.id === portal.id) {
        drawPrompt(ctx, portal, cx, top, formatInteractKey, view, dpr);
      }
    }
  }

  function drawPrompt(ctx, portal, centerX, blockTop, formatInteractKey, view, dpr) {
    const keyLabel = formatInteractKey();
    const title = portal.title;
    const line2 = `按 ${keyLabel} 进入`;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const screenX = centerX * view.zoom + view.offsetX;
    const screenY = (blockTop - 14) * view.zoom + view.offsetY;
    const w1 = ctx.measureText(title).width;
    const w2 = ctx.measureText(line2).width;
    const labelW = Math.max(w1, w2) + 18;
    const labelH = 44;

    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.beginPath();
    ctx.roundRect(screenX - labelW / 2, screenY - labelH / 2, labelW, labelH, 8);
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.fillText(title, screenX, screenY - 8);
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '500 12px system-ui, sans-serif';
    ctx.fillText(line2, screenX, screenY + 10);
  }

  window.WorldObjects = {
    PORTALS,
    findActivePortal,
    drawPortals,
  };
})();
