/**
 * 小型月台地牢小地图（右上）：自绘 canvas HUD（暗色描边矩形 + 简单图标）。
 * 仅在 scene=platform 且 kind=small 时显示；编组小地图同时隐藏。
 * FoW：未探索房间隐藏；与已探索房间相连的走廊/楼梯可见。
 * 性能：房间/廊/梯进静态离屏层，仅 FoW/尺寸变化时重绘；每帧只叠玩家/队友标记。
 * 完整地图叠层（M）通过 paintInto 复用同一绘制路径。
 */
(() => {
  const COLORS = {
    bg: '#141418',
    grid: 'rgb(255 255 255 / 0.04)',
    roomFill: '#25252e',
    roomStroke: 'rgb(163 163 163 / 0.55)',
    corridor: '#3a3a48',
    corridorStroke: 'rgb(163 163 163 / 0.35)',
    stair: '#4a4a5c',
    stairStroke: 'rgb(180 180 200 / 0.4)',
    safe: '#6ee7b7',
    enemy: '#f87171',
    warehouse: '#fbbf24',
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
   * 世界坐标 → 小地图像素（楼层为纵轴，0 层在下）。
   * @param {object} dungeon
   * @param {number} worldX
   * @param {number} floorY
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function project(dungeon, worldX, floorY, view) {
    const minX = dungeon.bounds.left;
    const maxX = Math.max(minX + 1, dungeon.bounds.right);
    const floors = dungeon.floors || [dungeon.bounds.floorY];
    let fi = 0;
    let best = Infinity;
    for (let i = 0; i < floors.length; i += 1) {
      const d = Math.abs(floors[i] - floorY);
      if (d < best) {
        best = d;
        fi = i;
      }
    }
    const nx = (worldX - minX) / (maxX - minX);
    const mx = view.pad + nx * (view.mapW - view.pad * 2);
    const rowH = (view.mapH - view.pad * 2) / Math.max(1, floors.length);
    const my = view.mapH - view.pad - (fi + 0.5) * rowH;
    return { mx, my, fi, rowH };
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
   * 计算房间在小地图上的连续矩形（与走廊同高衔接）。
   * @param {object} dungeon
   * @param {object} room
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function roomRect(dungeon, room, view) {
    const tl = project(dungeon, room.left, room.floorY, view);
    const br = project(dungeon, room.right, room.floorY, view);
    const h = Math.max(14, tl.rowH * 0.58);
    const x = Math.min(tl.mx, br.mx);
    const w = Math.max(16, Math.abs(br.mx - tl.mx));
    return {
      x,
      y: tl.my - h * 0.5,
      w,
      h,
      cx: x + w * 0.5,
      cy: tl.my,
      my: tl.my,
    };
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
   * 画走廊：按世界 left/right 投影成水平条，并短距贴齐同层房间边。
   * @param {object} dungeon
   * @param {object} corridor
   * @param {Map<string, ReturnType<typeof roomRect>>} roomRects
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function drawCorridor(dungeon, corridor, roomRects, view) {
    const a = project(dungeon, corridor.left, corridor.y, view);
    const b = project(dungeon, corridor.right, corridor.y, view);
    let x0 = Math.min(a.mx, b.mx);
    let x1 = Math.max(a.mx, b.mx);
    const midY = a.my;
    const snapPad = 10;

    const fromRect = corridor.fromRoomId ? roomRects.get(String(corridor.fromRoomId)) : null;
    const toRect = corridor.toRoomId ? roomRects.get(String(corridor.toRoomId)) : null;

    /**
     * 仅当房间与走廊同层且边距很近时贴齐，避免跨层楼梯廊被拉成超长横条。
     * @param {ReturnType<typeof roomRect>|null|undefined} rect
     * @param {'left'|'right'} side
     */
    function maybeSnap(rect, side) {
      if (!rect || Math.abs(rect.my - midY) > 4) return;
      if (side === 'left') {
        const edge = rect.x + rect.w;
        if (Math.abs(edge - x0) <= snapPad) x0 = edge;
      } else {
        if (Math.abs(rect.x - x1) <= snapPad) x1 = rect.x;
      }
    }

    if (fromRect && toRect && fromRect.x <= toRect.x) {
      maybeSnap(fromRect, 'left');
      maybeSnap(toRect, 'right');
    } else if (fromRect && toRect) {
      maybeSnap(toRect, 'left');
      maybeSnap(fromRect, 'right');
    } else {
      maybeSnap(fromRect, 'left');
      maybeSnap(fromRect, 'right');
      maybeSnap(toRect, 'left');
      maybeSnap(toRect, 'right');
    }

    /* 保证隧道在小地图上至少可见（房间框贴死时仍画短廊） */
    if (x1 - x0 < 8) {
      const mid = (x0 + x1) * 0.5;
      x0 = mid - 4;
      x1 = mid + 4;
      if (fromRect && toRect && fromRect.x <= toRect.x) {
        x0 = Math.max(x0, fromRect.x + fromRect.w);
        x1 = Math.min(x1, toRect.x);
        if (x1 - x0 < 6) {
          x0 = fromRect.x + fromRect.w;
          x1 = x0 + 6;
        }
      }
    }
    if (x1 - x0 < 1) return;
    const thickness = Math.max(5, (fromRect?.h || toRect?.h || a.rowH * 0.35) * 0.42);
    const y = midY - thickness * 0.5;
    g.fillStyle = COLORS.corridor;
    g.fillRect(x0, y, x1 - x0, thickness);
    g.strokeStyle = COLORS.corridorStroke;
    g.lineWidth = 1;
    g.strokeRect(x0 + 0.5, y + 0.5, x1 - x0 - 1, thickness - 1);
  }

  /**
   * 画楼梯：竖条按楼梯中点 X 投影，贴齐上下层已绘房间边。
   * @param {object} dungeon
   * @param {object} stair
   * @param {Map<string, ReturnType<typeof roomRect>>} roomRects
   * @param {{ pad: number, mapW: number, mapH: number }} view
   */
  function drawStair(dungeon, stair, roomRects, view) {
    const midX = (stair.x0 + stair.x1) * 0.5;
    const lo = project(dungeon, midX, stair.lowerY, view);
    const hi = project(dungeon, midX, stair.upperY, view);
    const fromRect = stair.fromRoomId ? roomRects.get(String(stair.fromRoomId)) : null;
    const toRect = stair.toRoomId ? roomRects.get(String(stair.toRoomId)) : null;
    const cx = lo.mx;

    let y0 = Math.min(lo.my, hi.my);
    let y1 = Math.max(lo.my, hi.my);
    if (toRect) y0 = toRect.y + toRect.h;
    if (fromRect) y1 = fromRect.y;
    if (y1 - y0 < 1) return;

    const thickness = 6;
    const x = cx - thickness * 0.5;
    g.fillStyle = COLORS.stair;
    g.fillRect(x, y0, thickness, y1 - y0);
    g.strokeStyle = COLORS.stairStroke;
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y0 + 0.5, thickness - 1, y1 - y0 - 1);
    g.strokeStyle = 'rgb(212 212 220 / 0.35)';
    g.beginPath();
    for (let y = y0 + 3; y < y1 - 2; y += 4) {
      g.moveTo(x + 1, y);
      g.lineTo(x + thickness - 1, y);
    }
    g.stroke();
  }

  /**
   * 将房间/廊/梯绘入静态离屏层（FoW 或尺寸变化时调用）。
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

    const { pad, mapW, mapH } = view;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, mapW, mapH);
    const floors = dungeon.floors || [dungeon.bounds.floorY];
    const rowH = (mapH - pad * 2) / Math.max(1, floors.length);
    g.strokeStyle = COLORS.grid;
    g.lineWidth = 1;
    for (let i = 0; i < floors.length; i += 1) {
      const y = mapH - pad - (i + 0.5) * rowH;
      g.beginPath();
      g.moveTo(pad, y);
      g.lineTo(mapW - pad, y);
      g.stroke();
    }

    const Fow = window.LpDungeonFow;
    /** @type {Map<string, ReturnType<typeof roomRect>>} */
    const roomRects = new Map();
    for (const room of dungeon.rooms || []) {
      if (Fow && !Fow.isRoomExplored?.(room.id)) continue;
      roomRects.set(String(room.id), roomRect(dungeon, room, view));
    }
    for (const c of dungeon.corridors || []) {
      if (Fow && !Fow.isCorridorVisible?.(c)) continue;
      drawCorridor(dungeon, c, roomRects, view);
    }
    for (const s of dungeon.stairs || []) {
      if (Fow && !Fow.isStairVisible?.(s)) continue;
      drawStair(dungeon, s, roomRects, view);
    }
    for (const room of dungeon.rooms || []) {
      if (Fow && !Fow.isRoomExplored?.(room.id)) continue;
      const rect = roomRects.get(String(room.id));
      if (!rect) continue;
      roundRectPath(rect.x, rect.y, rect.w, rect.h, 3 * iconScale);
      g.fillStyle = COLORS.roomFill;
      g.fill();
      g.strokeStyle = COLORS.roomStroke;
      g.lineWidth = 1.25 * iconScale;
      g.stroke();
      drawRoomIcon(room.type, rect.cx, rect.cy, Math.min(9 * iconScale, rect.h * 0.45));
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
        labelEl.textContent = `F${p.fi + 1}/${(dungeon.floors || []).length || 1}`;
      }
    }

    const remotes = window.LiminalSession?.remotes?.();
    if (remotes) {
      for (const remote of remotes.values()) {
        if (!remote || remote._lpDisconnected) continue;
        if (remote._lpScene !== 'platform') continue;
        const rx = Number(remote.x);
        if (!Number.isFinite(rx)) continue;
        const floorY =
          window.LpPlatform?.platformFloorAt?.(rx) ??
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
