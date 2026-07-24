/**
 * 地面掉落堆：世界坐标上的小型库存，靠近时物品栏左侧可拖取。
 */
(() => {
  const Core = window.LpInventoryCore;
  const Catalog = window.LpItemCatalog;
  const Spec = window.LiminalCarriageSpec;
  const STORAGE_KEY = 'liminal-platform-ground-v1';
  const PILE_COLS = 5;
  const PILE_ROWS = 4;
  const NEAR_RADIUS = 110;
  const MERGE_RADIUS = 48;
  /** 地面图标最大宽高（像素），接近原「物」标记 footprint。 */
  const ICON_MAX_W = 20;
  const ICON_MAX_H = 16;
  /** 白色描边偏移（像素）。 */
  const ICON_OUTLINE = 1.25;

  /** @type {{ id: string, x: number, y: number, inv: object }[]} */
  let piles = [];
  let idSeq = 1;

  /** @type {Map<string, { img: HTMLImageElement, ok: boolean, failed: boolean }>} */
  const iconCache = new Map();

  /** 新建空地面堆库存。 */
  function createPileInventory(seed = []) {
    return new Core.Inventory(`ground-${idSeq}`, PILE_COLS, PILE_ROWS, seed);
  }

  /** 从存档恢复。 */
  function load() {
    const raw = localStorage.getItem(STORAGE_KEY);
    piles = [];
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      for (const entry of parsed.piles || []) {
        const inv = Core.Inventory.fromJSON(entry.inv);
        inv.id = `ground-${idSeq}`;
        piles.push({
          id: `pile-${idSeq}`,
          x: Number(entry.x) || 0,
          y: Number(entry.y) || Spec?.FLOOR_Y || 0,
          inv,
        });
        idSeq += 1;
      }
    } catch {
      piles = [];
    }
  }

  /** 写入本地（联机时跳过，改由服务端快照）。 */
  function save() {
    if (window.LpInventoryNet?.isActive?.()) return;
    const payload = {
      piles: piles
        .filter((p) => Core.collectStacks(p.inv).length > 0)
        .map((p) => ({
          x: p.x,
          y: p.y,
          inv: p.inv.toJSON(),
        })),
    };
    piles = piles.filter((p) => Core.collectStacks(p.inv).length > 0);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  /** 用服务端地面堆列表整体替换本地 piles。 */
  function applyFromSnapshot(groundList) {
    const next = [];
    let maxSeq = 0;
    for (const entry of groundList || []) {
      const inv = Core.Inventory.fromJSON(entry.inv || entry);
      const id = String(entry.id || `pile-${idSeq}`);
      const m = /^pile-(\d+)$/.exec(id);
      if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      inv.id = String(entry.inv?.id || `ground-${id.replace(/^pile-/, '')}`);
      next.push({
        id,
        x: Number(entry.x) || 0,
        y: Number(entry.y) || Spec?.FLOOR_Y || 0,
        inv,
      });
    }
    piles = next.filter((p) => !isEmpty(p));
    if (maxSeq >= idSeq) idSeq = maxSeq + 1;
    warmPileIcons();
  }

  /** 堆是否为空。 */
  function isEmpty(pile) {
    return Core.collectStacks(pile.inv).length === 0;
  }

  /** 找半径内最近堆。 */
  function findNearest(worldX, radius = NEAR_RADIUS) {
    let best = null;
    let bestDist = radius;
    for (const pile of piles) {
      if (isEmpty(pile)) continue;
      const d = Math.abs(pile.x - worldX);
      if (d <= bestDist) {
        bestDist = d;
        best = pile;
      }
    }
    return best;
  }

  /** 找可合并的近堆（可含空堆）。 */
  function findMergeTarget(worldX) {
    let best = null;
    let bestDist = MERGE_RADIUS;
    for (const pile of piles) {
      const d = Math.abs(pile.x - worldX);
      if (d <= bestDist) {
        bestDist = d;
        best = pile;
      }
    }
    return best;
  }

  /** 在脚下创建堆。 */
  function createPile(worldX, worldY) {
    const inv = createPileInventory();
    const pile = {
      id: `pile-${idSeq}`,
      x: worldX,
      y: worldY ?? Spec?.FLOOR_Y ?? 0,
      inv,
    };
    idSeq += 1;
    piles.push(pile);
    return pile;
  }

  /**
   * 将完整堆叠（含 mag/dur/rot）放入地面；足迹放不下则另开新堆。
   * @returns {boolean} 是否放入成功
   */
  function dropFullStack(worldX, rawStack, worldY) {
    const stack = Core.normalizeStack(rawStack);
    if (!stack) return false;
    let pile = findMergeTarget(worldX) || createPile(worldX, worldY);
    const tryPlace = (target) => {
      for (let i = 0; i < target.inv.size(); i += 1) {
        if (target.inv.isCovered?.(i)) continue;
        if (target.inv.placeStack(i, stack)) return true;
      }
      return false;
    };
    if (!tryPlace(pile)) {
      pile = createPile(worldX + piles.length * 14, worldY);
      if (!tryPlace(pile)) return false;
    }
    piles = piles.filter((p) => !isEmpty(p));
    save();
    warmPileIcons();
    return true;
  }

  /** 把堆叠放入地面（满则另开新堆）。 */
  function dropStacks(worldX, stacks, worldY) {
    if (!stacks?.length) return;
    if (window.LpInventoryNet?.isActive?.()) {
      // 联机掉落应由 inventory UI / 服务端 drop 意图处理；此处仅作本地预览时不写盘
    }
    for (const raw of stacks) {
      const stack = Core.normalizeStack(raw);
      if (!stack) continue;
      if (stack.mag != null || stack.dur != null || Core.stackRot?.(stack) === 90) {
        dropFullStack(worldX, stack, worldY);
        continue;
      }
      let pile = findMergeTarget(worldX) || createPile(worldX, worldY);
      let leftover = pile.inv.addItem(stack.itemId, stack.qty);
      while (leftover > 0) {
        pile = createPile(worldX + piles.length * 12, worldY);
        leftover = pile.inv.addItem(stack.itemId, leftover);
      }
    }
    piles = piles.filter((p) => !isEmpty(p));
    save();
    warmPileIcons();
  }

  /** 附近是否有可搜刮物。 */
  function hasNearby(worldX) {
    return Boolean(findNearest(worldX));
  }

  /** 取附近堆（供物品栏绑定）。 */
  function getNearbyPile(worldX) {
    return findNearest(worldX);
  }

  /** 清理空堆并保存。 */
  function pruneAndSave() {
    piles = piles.filter((p) => !isEmpty(p));
    save();
  }

  /**
   * 按 URL 缓存加载物品图标；未就绪或失败返回 null（不每帧新建 Image）。
   * @param {string} url
   * @returns {HTMLImageElement | null}
   */
  function getCachedIcon(url) {
    if (!url) return null;
    let entry = iconCache.get(url);
    if (!entry) {
      const img = new Image();
      entry = { img, ok: false, failed: false };
      iconCache.set(url, entry);
      img.onload = () => {
        entry.ok = img.naturalWidth > 0;
        entry.failed = !entry.ok;
      };
      img.onerror = () => {
        entry.ok = false;
        entry.failed = true;
      };
      img.src = url;
    }
    if (entry.failed || !entry.ok) return null;
    return entry.img;
  }

  /** 预热当前各堆首堆叠图标，避免首帧绘制才开始加载。 */
  function warmPileIcons() {
    for (const pile of piles) {
      if (isEmpty(pile)) continue;
      const url = primaryIconUrl(pile);
      if (url) getCachedIcon(url);
    }
  }

  /**
   * 取堆内首个非空堆叠的图鉴 icon URL（无贴图则返回空串）。
   * @param {{ inv: object }} pile
   * @returns {string}
   */
  function primaryIconUrl(pile) {
    const stacks = Core.collectStacks(pile.inv);
    for (const stack of stacks) {
      if (!stack?.itemId || !(Number(stack.qty) > 0)) continue;
      const item = Catalog?.getItem?.(stack.itemId);
      const url = item?.icon;
      if (typeof url === 'string' && url) return url;
      return '';
    }
    return '';
  }

  /**
   * 将图标等比缩入地面 footprint。
   * @param {HTMLImageElement} img
   * @returns {{ w: number, h: number }}
   */
  function fitIconSize(img) {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const scale = Math.min(ICON_MAX_W / nw, ICON_MAX_H / nh);
    return { w: nw * scale, h: nh * scale };
  }

  /**
   * 在 (cx, cy) 绘制带白色描边的物品图标（八向白色剪影 + 原图）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {HTMLImageElement} img
   * @param {number} cx
   * @param {number} cy
   */
  function drawIconWithOutline(ctx, img, cx, cy) {
    const { w, h } = fitIconSize(img);
    const x = cx - w / 2;
    const y = cy - h / 2;
    const o = ICON_OUTLINE;
    const offsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0], [1, 0],
      [-1, 1], [0, 1], [1, 1],
    ];
    ctx.save();
    ctx.filter = 'brightness(0) invert(1)';
    for (const [dx, dy] of offsets) {
      ctx.drawImage(img, x + dx * o, y + dy * o, w, h);
    }
    ctx.filter = 'none';
    ctx.drawImage(img, x, y, w, h);
    ctx.restore();
  }

  /**
   * 无可用图标时画原金色「物」标记。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   */
  function drawFallbackMarker(ctx, x, y) {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - 10, y - 8, 20, 12, 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('物', x, y - 2);
    ctx.restore();
  }

  /** 世界层绘制地面标记（优先首堆叠图鉴 icon + 白描边）。 */
  function draw(ctx) {
    const floor = Spec?.FLOOR_Y ?? 0;
    for (const pile of piles) {
      if (isEmpty(pile)) continue;
      const x = pile.x;
      const y = (pile.y || floor) - 6;
      const url = primaryIconUrl(pile);
      const img = url ? getCachedIcon(url) : null;
      if (img) {
        drawIconWithOutline(ctx, img, x, y - 2);
      } else {
        drawFallbackMarker(ctx, x, y);
      }
    }
  }

  /**
   * 轨下/轨面掉落堆随列车卷动平移（与 LpTrack 轨枕同相）；走道地板堆不动。
   */
  function tickTrackScroll() {
    const groundY = window.LpTrack?.getGroundTopY?.();
    if (groundY == null) return;
    const apply = window.LpTrack?.applyTrackScroll;
    if (!apply) return;
    for (const pile of piles) {
      if (isEmpty(pile)) continue;
      const y = Number(pile.y);
      if (!(y >= groundY - 8)) continue;
      apply(pile);
    }
  }

  /** 开局溢出种子（仅当尚无地面存档）。 */
  function seedIfEmpty(worldX, stacks) {
    if (piles.length > 0 || !stacks?.length) return;
    dropStacks(worldX, stacks);
  }

  load();
  warmPileIcons();

  window.LpGroundLoot = {
    load,
    save,
    dropStacks,
    dropFullStack,
    hasNearby,
    getNearbyPile,
    findNearest,
    pruneAndSave,
    draw,
    tickTrackScroll,
    seedIfEmpty,
    applyFromSnapshot,
    NEAR_RADIUS,
    PILE_COLS,
    PILE_ROWS,
    getPiles: () => piles,
  };
})();
