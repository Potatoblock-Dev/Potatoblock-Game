/**
 * 小型月台地牢小地图（右上）：节点–连线侧视示意图。
 * 房间为色块矩形（安全屋绿 / 敌区红 / 仓库黄），走廊为房间间连线；
 * FoW 隐藏未探索；完整地图（M）复用 paintInto。
 */
(() => {
  const COLORS = {
    bg: '#141418',
    link: 'rgb(163 163 163 / 0.55)',
    linkDim: 'rgb(100 100 110 / 0.35)',
    roomStroke: 'rgb(20 20 24 / 0.65)',
    safe: '#34d399',
    safeFill: 'rgb(52 211 153 / 0.85)',
    enemy: '#f87171',
    enemyFill: 'rgb(248 113 113 / 0.82)',
    warehouse: '#fbbf24',
    warehouseFill: 'rgb(251 191 36 / 0.85)',
    unknownFill: '#25252e',
    player: '#e4e4e7',
    playerRing: '#38bdf8',
    teammate: '#a78bfa',
  };

  const root = document.getElementById('lpDungeonMinimap');
  const canvas = document.getElementById('lpDungeonMinimapCanvas');
  const floorEl = document.getElementById('lpDungeonMinimapFloor');
  const trainMini = document.getElementById('lpTrainMinimap');
  if (!root || !canvas) return;

  const ctx = canvas.getContext('2d');
  /** 当前绘图目标（主画布或静态离屏）。 */
  let g = ctx;
  let visible = false;

  /**
   * 每块目标 canvas 独立静态离屏缓存，避免 HUD 与全屏叠层互踩尺寸。
   * @typedef {{ staticCanvas: HTMLCanvasElement, staticCtx: CanvasRenderingContext2D, exploredGen: number, cssW: number, cssH: number, dpr: number, dungeon: object|null }} PaintCache
   */
  /** @type {WeakMap<HTMLCanvasElement, PaintCache>} */
  const paintCache = new WeakMap();

  /**
   * 取得或创建某 canvas 的静态层缓存。
   * @param {HTMLCanvasElement} target
   * @returns {PaintCache}
   */
  function getPaintCache(target) {
    let entry = paintCache.get(target);
    if (!entry) {
      const staticCanvas = document.createElement('canvas');
      const staticCtx = staticCanvas.getContext('2d');
      entry = {
        staticCanvas,
        staticCtx,
        exploredGen: -1,
        cssW: 0,
        cssH: 0,
        dpr: 0,
        dungeon: null,
      };
      paintCache.set(target, entry);
    }
    return entry;
  }

  /**
   * 侧视世界包围盒（优先 dungeon.mapBounds，否则由房间推算）。
   * @param {object} dungeon
   */
  function worldExtents(dungeon) {
    const mb = dungeon.mapBounds;
    if (
      mb &&
      Number.isFinite(mb.minX) &&
      Number.isFinite(mb.maxX) &&
      Number.isFinite(mb.minY) &&
      Number.isFinite(mb.maxY)
    ) {
      return mb;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const room of dungeon.rooms || []) {
      minX = Math.min(minX, room.left);
      maxX = Math.max(maxX, room.right);
      minY = Math.min(minY, room.ceilingY);
      maxY = Math.max(maxY, room.floorY);
    }
    if (!Number.isFinite(minX)) {
      return {
        minX: dungeon.bounds?.left ?? 0,
        maxX: dungeon.bounds?.right ?? 1000,
        minY: (dungeon.bounds?.floorY ?? 720) - 600,
        maxY: dungeon.bounds?.floorY ?? 720,
      };
    }
    return {
      minX: minX - 40,
      maxX: maxX + 40,
      minY: minY - 40,
      maxY: maxY + 40,
    };
  }

  /**
   * 世界坐标 → 小地图像素（连续侧视：X 横轴，floorY 纵轴向下）。
   * @param {object} dungeon
   * @param {number} worldX
   * @param {number} worldY
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function project(dungeon, worldX, worldY, view) {
    const ext = worldExtents(dungeon);
    const spanX = Math.max(1, ext.maxX - ext.minX);
    const spanY = Math.max(1, ext.maxY - ext.minY);
    const nx = (worldX - ext.minX) / spanX;
    const ny = (worldY - ext.minY) / spanY;
    const mx = view.pad + nx * (view.mapW - view.pad * 2);
    const my = view.pad + ny * (view.mapH - view.pad * 2);
    return { mx, my };
  }

  /**
   * 画圆角矩形路径（不 stroke/fill）。
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} r
   */
  function roundRectPath(x, y, w, h, r) {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  /**
   * 房间类型填充色。
   * @param {string} type
   */
  function roomFill(type) {
    if (type === 'safehouse') return COLORS.safeFill;
    if (type === 'warehouse') return COLORS.warehouseFill;
    return COLORS.enemyFill;
  }

  /**
   * 画房间类型图例图标（安全屋 / 敌人 / 仓库）。
   * @param {string} type
   * @param {number} cx
   * @param {number} cy
   * @param {number} size
   */
  function drawRoomIcon(type, cx, cy, size) {
    const s = Math.max(3, size);
    g.save();
    g.translate(cx, cy);
    if (type === 'safehouse') {
      g.fillStyle = COLORS.safe;
      g.strokeStyle = 'rgb(0 0 0 / 0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -s * 0.55);
      g.lineTo(s * 0.55, -s * 0.05);
      g.lineTo(s * 0.55, s * 0.5);
      g.lineTo(-s * 0.55, s * 0.5);
      g.lineTo(-s * 0.55, -s * 0.05);
      g.closePath();
      g.fill();
      g.stroke();
    } else if (type === 'warehouse') {
      g.fillStyle = COLORS.warehouse;
      g.strokeStyle = 'rgb(0 0 0 / 0.35)';
      g.lineWidth = 1;
      g.fillRect(-s * 0.45, -s * 0.4, s * 0.9, s * 0.8);
      g.strokeRect(-s * 0.45, -s * 0.4, s * 0.9, s * 0.8);
      g.strokeStyle = 'rgb(0 0 0 / 0.45)';
      g.beginPath();
      g.moveTo(-s * 0.2, -s * 0.15);
      g.lineTo(-s * 0.2, s * 0.25);
      g.moveTo(0, -s * 0.15);
      g.lineTo(0, s * 0.25);
      g.moveTo(s * 0.2, -s * 0.15);
      g.lineTo(s * 0.2, s * 0.25);
      g.stroke();
    } else {
      g.fillStyle = COLORS.enemy;
      g.strokeStyle = 'rgb(0 0 0 / 0.35)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, -s * 0.55);
      g.lineTo(s * 0.5, s * 0.45);
      g.lineTo(-s * 0.5, s * 0.45);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.restore();
  }

  /**
   * 画本机或队友位置点。
   * @param {number} x
   * @param {number} y
   * @param {string} fill
   * @param {string} [ring]
   * @param {number} [r]
   */
  function drawMarker(x, y, fill, ring, r = 4) {
    g.beginPath();
    g.arc(x, y, r + (ring ? 1.5 : 0), 0, Math.PI * 2);
    if (ring) {
      g.fillStyle = ring;
      g.fill();
    }
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
    g.strokeStyle = 'rgb(0 0 0 / 0.5)';
    g.lineWidth = 1;
    g.stroke();
  }

  /**
   * 计算房间在小地图上的连续侧视矩形。
   * @param {object} dungeon
   * @param {object} room
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function roomRect(dungeon, room, view) {
    const tl = project(dungeon, room.left, room.ceilingY, view);
    const br = project(dungeon, room.right, room.floorY, view);
    const x = Math.min(tl.mx, br.mx);
    const y = Math.min(tl.my, br.my);
    const w = Math.max(10, Math.abs(br.mx - tl.mx));
    const h = Math.max(8, Math.abs(br.my - tl.my));
    return {
      x,
      y,
      w,
      h,
      cx: x + w * 0.5,
      cy: y + h * 0.5,
    };
  }

  /**
   * 线段与矩形边界的交点（从中心指向外侧，用于廊线贴边）。
   * @param {{ x: number, y: number, w: number, h: number, cx: number, cy: number }} rect
   * @param {number} tx
   * @param {number} ty
   */
  function edgeToward(rect, tx, ty) {
    const dx = tx - rect.cx;
    const dy = ty - rect.cy;
    if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) {
      return { x: rect.cx, y: rect.cy };
    }
    const hx = rect.w * 0.5;
    const hy = rect.h * 0.5;
    const sx = dx !== 0 ? hx / Math.abs(dx) : Infinity;
    const sy = dy !== 0 ? hy / Math.abs(dy) : Infinity;
    const t = Math.min(sx, sy);
    return { x: rect.cx + dx * t, y: rect.cy + dy * t };
  }

  /**
   * 画两房间之间的连线（节点图走廊）。
   * @param {{ cx: number, cy: number, x: number, y: number, w: number, h: number }} a
   * @param {{ cx: number, cy: number, x: number, y: number, w: number, h: number }} b
   * @param {boolean} strong
   * @param {number} scale
   */
  function drawLink(a, b, strong, scale) {
    const p0 = edgeToward(a, b.cx, b.cy);
    const p1 = edgeToward(b, a.cx, a.cy);
    g.strokeStyle = strong ? COLORS.link : COLORS.linkDim;
    g.lineWidth = Math.max(1.5, 2.25 * scale);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(p0.x, p0.y);
    g.lineTo(p1.x, p1.y);
    g.stroke();
  }

  /** 是否应显示地牢小地图（小型月台且有地牢数据）。 */
  function shouldShow() {
    return (
      window.LpPlatform?.getScene?.() === 'platform' &&
      window.LpPlatform?.getPlatformKind?.() === 'small' &&
      Boolean(window.LpPlatform?.getDungeon?.())
    );
  }

  /** 同步显隐与编组小地图互斥。 */
  function syncVisibility() {
    const show = shouldShow();
    visible = show;
    root.hidden = !show;
    root.setAttribute('aria-hidden', show ? 'false' : 'true');
    if (show) {
      root.setAttribute('role', 'button');
      root.tabIndex = 0;
      root.title = '打开地牢地图 (M)';
    } else {
      root.removeAttribute('role');
      root.removeAttribute('tabindex');
      root.removeAttribute('title');
    }
    if (trainMini) {
      if (show) {
        trainMini.hidden = true;
        trainMini.setAttribute('aria-hidden', 'true');
      } else {
        trainMini.hidden = false;
        trainMini.removeAttribute('aria-hidden');
      }
    }
  }

  /**
   * 收集用于连线的边（优先 links；否则由走廊/楼梯 from–to 去重）。
   * @param {object} dungeon
   * @returns {Array<{ fromRoomId: string, toRoomId: string }>}
   */
  function collectEdges(dungeon) {
    /** @type {Map<string, { fromRoomId: string, toRoomId: string }>} */
    const edgeMap = new Map();
    /** 登记无向边。 */
    function add(a, b) {
      if (!a || !b || a === b) return;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { fromRoomId: a, toRoomId: b });
    }
    for (const link of dungeon.links || []) {
      add(link.fromRoomId, link.toRoomId);
    }
    for (const c of dungeon.corridors || []) {
      add(c.fromRoomId, c.toRoomId);
    }
    for (const s of dungeon.stairs || []) {
      add(s.fromRoomId, s.toRoomId);
    }
    return [...edgeMap.values()];
  }

  /**
   * 边是否因 FoW 可见（任一端已探索，或对应廊/梯可见）。
   * @param {object} dungeon
   * @param {{ fromRoomId: string, toRoomId: string }} edge
   */
  function isEdgeVisible(dungeon, edge) {
    const Fow = window.LpDungeonFow;
    if (!Fow) return true;
    if (Fow.isRoomExplored?.(edge.fromRoomId) || Fow.isRoomExplored?.(edge.toRoomId)) {
      return true;
    }
    for (const c of dungeon.corridors || []) {
      if (
        (c.fromRoomId === edge.fromRoomId && c.toRoomId === edge.toRoomId) ||
        (c.fromRoomId === edge.toRoomId && c.toRoomId === edge.fromRoomId)
      ) {
        if (Fow.isCorridorVisible?.(c)) return true;
      }
    }
    for (const s of dungeon.stairs || []) {
      if (
        (s.fromRoomId === edge.fromRoomId && s.toRoomId === edge.toRoomId) ||
        (s.fromRoomId === edge.toRoomId && s.toRoomId === edge.fromRoomId)
      ) {
        if (Fow.isStairVisible?.(s)) return true;
      }
    }
    return false;
  }

  /**
   * 将房间/连线绘入静态离屏层（FoW 或尺寸变化时调用）。
   * @param {PaintCache} cache
   * @param {object} dungeon
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} dpr
   * @param {{ pad: number, mapW: number, mapH: number }} view
   * @param {number} iconScale
   */
  function redrawStatic(cache, dungeon, cssW, cssH, dpr, view, iconScale) {
    const { staticCanvas, staticCtx } = cache;
    const pw = Math.round(cssW * dpr);
    const ph = Math.round(cssH * dpr);
    if (staticCanvas.width !== pw || staticCanvas.height !== ph) {
      staticCanvas.width = pw;
      staticCanvas.height = ph;
    }
    staticCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    staticCtx.imageSmoothingEnabled = true;
    g = staticCtx;

    const { mapW, mapH } = view;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, mapW, mapH);

    const Fow = window.LpDungeonFow;
    /** @type {Map<string, ReturnType<typeof roomRect>>} */
    const roomRects = new Map();
    for (const room of dungeon.rooms || []) {
      roomRects.set(String(room.id), roomRect(dungeon, room, view));
    }

    for (const edge of collectEdges(dungeon)) {
      if (!isEdgeVisible(dungeon, edge)) continue;
      const a = roomRects.get(String(edge.fromRoomId));
      const b = roomRects.get(String(edge.toRoomId));
      if (!a || !b) continue;
      const both =
        !Fow ||
        (Fow.isRoomExplored?.(edge.fromRoomId) && Fow.isRoomExplored?.(edge.toRoomId));
      drawLink(a, b, both, iconScale);
    }

    for (const room of dungeon.rooms || []) {
      const explored = !Fow || Fow.isRoomExplored?.(room.id);
      if (!explored) continue;
      const rect = roomRects.get(String(room.id));
      if (!rect) continue;
      roundRectPath(rect.x, rect.y, rect.w, rect.h, 3 * iconScale);
      g.fillStyle = roomFill(room.type);
      g.fill();
      g.strokeStyle = COLORS.roomStroke;
      g.lineWidth = 1.25 * iconScale;
      g.stroke();
      drawRoomIcon(room.type, rect.cx, rect.cy, Math.min(9 * iconScale, rect.h * 0.4));
    }

    cache.exploredGen = Fow?.getExploredGen?.() ?? 0;
    cache.cssW = cssW;
    cache.cssH = cssH;
    cache.dpr = dpr;
    cache.dungeon = dungeon;
  }

  /**
   * 将地牢结构（含 FoW）绘入任意 canvas；供 HUD 与完整地图叠层共用。
   * @param {HTMLCanvasElement} targetCanvas
   * @param {{ cssW?: number, cssH?: number, pad?: number, markerScale?: number, floorEl?: HTMLElement|null }} [opts]
   */
  function paintInto(targetCanvas, opts = {}) {
    const dungeon = window.LpPlatform?.getDungeon?.();
    if (!dungeon || !targetCanvas) return;
    const targetCtx = targetCanvas.getContext('2d');
    if (!targetCtx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.max(32, opts.cssW || targetCanvas.clientWidth || 168);
    const cssH = Math.max(32, opts.cssH || targetCanvas.clientHeight || Math.round(cssW * 0.78));
    const pad = opts.pad ?? Math.max(10, Math.round(Math.min(cssW, cssH) * 0.04));
    const markerScale = opts.markerScale ?? 1;
    const labelEl = opts.floorEl === undefined ? floorEl : opts.floorEl;

    if (
      targetCanvas.width !== Math.round(cssW * dpr) ||
      targetCanvas.height !== Math.round(cssH * dpr)
    ) {
      targetCanvas.width = Math.round(cssW * dpr);
      targetCanvas.height = Math.round(cssH * dpr);
      targetCanvas.style.width = `${cssW}px`;
      targetCanvas.style.height = `${cssH}px`;
    }
    targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    targetCtx.imageSmoothingEnabled = true;

    const view = { pad, mapW: cssW, mapH: cssH };
    const Fow = window.LpDungeonFow;
    const exploredGen = Fow?.getExploredGen?.() ?? 0;
    const cache = getPaintCache(targetCanvas);
    const needStatic =
      cache.dungeon !== dungeon ||
      cache.exploredGen !== exploredGen ||
      cache.cssW !== cssW ||
      cache.cssH !== cssH ||
      cache.dpr !== dpr;
    if (needStatic) {
      redrawStatic(cache, dungeon, cssW, cssH, dpr, view, markerScale);
    }

    targetCtx.setTransform(1, 0, 0, 1, 0, 0);
    targetCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
    targetCtx.drawImage(cache.staticCanvas, 0, 0);
    targetCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    g = targetCtx;

    const px = window.LpGame?.getLocalX?.();
    if (Number.isFinite(px)) {
      const floorY =
        window.LpPlatform?.platformFloorAt?.(px) ??
        dungeon.spawnFloorY ??
        dungeon.bounds.floorY;
      const p = project(dungeon, px, floorY, view);
      drawMarker(p.mx, p.my, COLORS.player, COLORS.playerRing, 4 * markerScale);
      if (labelEl) {
        const explored = Fow?.getExploredRoomIds?.()?.length ?? 0;
        const total = (dungeon.rooms || []).length;
        labelEl.textContent = `${explored}/${total}`;
      }
    }

    const remotes = window.LiminalSession?.remotes?.();
    if (remotes) {
      for (const remote of remotes.values()) {
        if (!remote || remote._lpDisconnected) continue;
        if (remote._lpScene !== 'platform') continue;
        const rx = Number(remote.x);
        if (!Number.isFinite(rx)) continue;
        const prefer =
          remote._lpFloorY != null && Number.isFinite(Number(remote._lpFloorY))
            ? Number(remote._lpFloorY)
            : undefined;
        const floorY =
          window.LpPlatform?.platformFloorAt?.(rx, {
            preferY: prefer,
            remember: false,
          }) ??
          dungeon.spawnFloorY ??
          dungeon.bounds.floorY;
        if (Fow?.isWorldPosVisible && !Fow.isWorldPosVisible(rx, floorY)) continue;
        const p = project(dungeon, rx, floorY, view);
        drawMarker(p.mx, p.my, COLORS.teammate, null, 3.5 * markerScale);
      }
    }
  }

  /** 绘制 HUD 小地图一帧（完整地图打开时跳过，避免与叠层抢缓存注意力）。 */
  function draw() {
    if (!visible) return;
    if (window.LpDungeonMap?.isOpen?.()) return;
    const cssW = root.clientWidth || 168;
    const cssH = Math.round(cssW * 0.78);
    paintInto(canvas, { cssW, cssH, floorEl });
  }

  /** 主循环挂钩：同步显隐并在可见时重绘。 */
  function tick() {
    syncVisibility();
    if (visible) draw();
  }

  /** 使该 canvas 的静态层在下次 paint 时强制重建。 */
  function invalidate(target = canvas) {
    const entry = paintCache.get(target);
    if (entry) entry.dungeon = null;
  }

  window.addEventListener('liminal:platform-scene', () => {
    invalidate(canvas);
    syncVisibility();
    if (visible) draw();
    if (!shouldShow()) window.LpDungeonMap?.close?.();
  });

  window.LpDungeonMinimap = {
    tick,
    redraw: draw,
    paintInto,
    shouldShow,
    syncVisibility,
    invalidate,
  };

  syncVisibility();
})();
