/**
 * 地面掉落堆：世界坐标上的小型库存，靠近时物品栏左侧可拖取。
 */
(() => {
  const Core = window.LpInventoryCore;
  const Spec = window.LiminalCarriageSpec;
  const STORAGE_KEY = 'liminal-platform-ground-v1';
  const PILE_COLS = 5;
  const PILE_ROWS = 4;
  const NEAR_RADIUS = 110;
  const MERGE_RADIUS = 48;

  /** @type {{ id: string, x: number, y: number, inv: object }[]} */
  let piles = [];
  let idSeq = 1;

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

  /** 把堆叠放入地面（满则另开新堆）。 */
  function dropStacks(worldX, stacks, worldY) {
    if (!stacks?.length) return;
    if (window.LpInventoryNet?.isActive?.()) {
      // 联机掉落应由 inventory UI / 服务端 drop 意图处理；此处仅作本地预览时不写盘
    }
    let pile = findMergeTarget(worldX) || createPile(worldX, worldY);
    for (const raw of stacks) {
      const stack = Core.normalizeStack(raw);
      if (!stack) continue;
      let leftover = pile.inv.addItem(stack.itemId, stack.qty);
      if (stack.mag != null && leftover < stack.qty) {
        for (let i = 0; i < pile.inv.size(); i += 1) {
          const slot = pile.inv.slots[i];
          if (slot && slot.itemId === stack.itemId && slot.mag == null) {
            slot.mag = stack.mag;
            break;
          }
        }
      }
      while (leftover > 0) {
        pile = createPile(worldX + piles.length * 12, worldY);
        leftover = pile.inv.addItem(stack.itemId, leftover);
      }
    }
    piles = piles.filter((p) => !isEmpty(p));
    save();
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

  /** 世界层绘制地面标记。 */
  function draw(ctx) {
    const floor = Spec?.FLOOR_Y ?? 0;
    for (const pile of piles) {
      if (isEmpty(pile)) continue;
      const x = pile.x;
      const y = (pile.y || floor) - 6;
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
  }

  /** 开局溢出种子（仅当尚无地面存档）。 */
  function seedIfEmpty(worldX, stacks) {
    if (piles.length > 0 || !stacks?.length) return;
    dropStacks(worldX, stacks);
  }

  load();

  window.LpGroundLoot = {
    load,
    save,
    dropStacks,
    hasNearby,
    getNearbyPile,
    findNearest,
    pruneAndSave,
    draw,
    seedIfEmpty,
    applyFromSnapshot,
    NEAR_RADIUS,
    PILE_COLS,
    PILE_ROWS,
    getPiles: () => piles,
  };
})();
