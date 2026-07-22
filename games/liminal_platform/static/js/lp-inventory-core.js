/**
 * 物品栏核心：多格占位、堆叠、存取与本地持久化。
 * 手部库存 ignoreItemSize=true，仍受 canHoldInHand 限制。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const STORAGE_KEY = 'liminal-platform-inventory-v4';
  const LEGACY_KEYS = [
    'liminal-platform-inventory-v3',
    'liminal-platform-inventory-v2',
    'liminal-platform-inventory-v1',
  ];

  /** 装备栏槽位键（与 UI 人偶一致）。 */
  const EQUIP_SLOT_KEYS = ['head', 'chest', 'legs', 'accessory', 'accessory'];

  /** 创建空槽位数组。 */
  function emptySlots(size) {
    return Array.from({ length: size }, () => null);
  }

  /** 规范化堆叠数据（不含占位标记）。 */
  function normalizeStack(stack) {
    if (!stack?.itemId || !stack.qty) return null;
    if (stack.occupiedBy != null) return null;
    const item = Catalog.getItem(stack.itemId);
    if (!item) return null;
    const qty = Math.max(1, Math.min(stack.qty, item.maxStack));
    return { itemId: item.id, qty };
  }

  /** 是否为占位格。 */
  function isOccupancyMarker(slot) {
    return Boolean(slot && slot.occupiedBy != null);
  }

  class Inventory {
    /**
     * @param {string} id 库存标识
     * @param {number} cols 列数
     * @param {number} rows 行数
     * @param {Array} seed 初始堆叠
     * @param {{ ignoreItemSize?: boolean, slotKeys?: string[] }} options
     */
    constructor(id, cols, rows, seed = [], options = {}) {
      this.id = id;
      this.cols = cols;
      this.rows = rows;
      this.ignoreItemSize = Boolean(options.ignoreItemSize);
      this.slotKeys = options.slotKeys ? [...options.slotKeys] : null;
      this.slots = emptySlots(cols * rows);
      for (const entry of seed) {
        if (entry.index >= 0 && entry.index < this.slots.length) {
          this.placeStack(entry.index, entry.stack);
        }
      }
    }

    /** 槽位总数。 */
    size() {
      return this.slots.length;
    }

    /** 该库存中物品占用的宽高。 */
    sizeFor(itemId) {
      if (this.ignoreItemSize) return { w: 1, h: 1 };
      return Catalog.getItemSize(itemId);
    }

    /** 是否允许放入此库存；装备栏需指定槽位下标。 */
    acceptsItem(itemId, index = null) {
      if (!Catalog.getItem(itemId)) return false;
      if (this.id === 'hands' && !Catalog.canHoldInHand(itemId)) return false;
      if (this.slotKeys) {
        if (index == null) {
          return this.slotKeys.some((key, i) =>
            Catalog.canEquipInSlot(itemId, key) && !this.getSlot(i)
          );
        }
        const key = this.slotKeys[index];
        return Catalog.canEquipInSlot(itemId, key);
      }
      return true;
    }

    /** 行列 → 下标。 */
    indexAt(col, row) {
      if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return -1;
      return row * this.cols + col;
    }

    /** 下标 → 行列。 */
    coordsOf(index) {
      return {
        col: index % this.cols,
        row: Math.floor(index / this.cols),
      };
    }

    /** 以 origin 为左上角，物品覆盖的全部下标。 */
    footprint(origin, itemId) {
      const { w, h } = this.sizeFor(itemId);
      const { col, row } = this.coordsOf(origin);
      const cells = [];
      for (let dy = 0; dy < h; dy += 1) {
        for (let dx = 0; dx < w; dx += 1) {
          const idx = this.indexAt(col + dx, row + dy);
          if (idx < 0) return null;
          cells.push(idx);
        }
      }
      return cells;
    }

    /** 点击任意格时解析到原点下标。 */
    originIndex(index) {
      const raw = this.slots[index];
      if (!raw) return index;
      if (isOccupancyMarker(raw)) return raw.occupiedBy;
      return index;
    }

    /** 读取逻辑堆叠（占位格返回原点物品）。 */
    getSlot(index) {
      const origin = this.originIndex(index);
      const raw = this.slots[origin];
      if (!raw || isOccupancyMarker(raw)) return null;
      return { ...raw };
    }

    /** 该格是否为多格物品的非原点占位。 */
    isCovered(index) {
      return isOccupancyMarker(this.slots[index]);
    }

    /** 原点格的占格尺寸（用于 UI span）。 */
    spanAt(index) {
      const stack = this.getSlot(index);
      if (!stack || this.originIndex(index) !== index) return { w: 1, h: 1 };
      return this.sizeFor(stack.itemId);
    }

    /** 检查能否以 origin 放置（可忽略某原点占用的格）。 */
    canPlaceAt(origin, itemId, ignoreOrigin = -1) {
      if (!this.acceptsItem(itemId, origin)) return false;
      const cells = this.footprint(origin, itemId);
      if (!cells) return false;
      for (const idx of cells) {
        const raw = this.slots[idx];
        if (!raw) continue;
        const owner = isOccupancyMarker(raw) ? raw.occupiedBy : idx;
        if (owner === ignoreOrigin) continue;
        return false;
      }
      return true;
    }

    /** 清除某原点及其占位。 */
    clearFootprint(origin) {
      const raw = this.slots[origin];
      if (!raw || isOccupancyMarker(raw)) {
        this.slots[origin] = null;
        return;
      }
      const cells = this.footprint(origin, raw.itemId) || [origin];
      for (const idx of cells) this.slots[idx] = null;
    }

    /** 在 origin 写入堆叠并标记占位；失败返回 false。 */
    placeStack(origin, stack, ignoreOrigin = -1) {
      const normalized = normalizeStack(stack);
      if (!normalized) return false;
      if (!this.canPlaceAt(origin, normalized.itemId, ignoreOrigin)) return false;
      if (ignoreOrigin >= 0) this.clearFootprint(ignoreOrigin);
      else this.clearFootprint(origin);

      const cells = this.footprint(origin, normalized.itemId);
      this.slots[origin] = normalized;
      for (const idx of cells) {
        if (idx === origin) continue;
        this.slots[idx] = { occupiedBy: origin };
      }
      return true;
    }

    /** 写入槽位（单格兼容 API；多格物品需空足足迹）。 */
    setSlot(index, stack) {
      const origin = this.originIndex(index);
      this.clearFootprint(origin);
      if (!stack) return;
      this.placeStack(origin, stack);
    }

    /** 取走原点堆叠并清空足迹。 */
    takeSlot(index) {
      const origin = this.originIndex(index);
      const stack = this.getSlot(origin);
      if (!stack) return null;
      this.clearFootprint(origin);
      return stack;
    }

    /** 两槽互换（仅在双方足迹互不冲突时成功）。 */
    swapSlots(a, b) {
      const oa = this.originIndex(a);
      const ob = this.originIndex(b);
      if (oa === ob) return;
      const stackA = this.getSlot(oa);
      const stackB = this.getSlot(ob);
      this.clearFootprint(oa);
      this.clearFootprint(ob);
      if (stackB && !this.canPlaceAt(oa, stackB.itemId)) {
        if (stackA) this.placeStack(oa, stackA);
        if (stackB) this.placeStack(ob, stackB);
        return;
      }
      if (stackA && !this.canPlaceAt(ob, stackA.itemId)) {
        if (stackA) this.placeStack(oa, stackA);
        if (stackB) this.placeStack(ob, stackB);
        return;
      }
      if (stackB) this.placeStack(oa, stackB);
      if (stackA) this.placeStack(ob, stackA);
    }

    /** 寻找可放置 origin。 */
    findPlaceIndex(itemId) {
      for (let i = 0; i < this.slots.length; i += 1) {
        if (this.canPlaceAt(i, itemId)) return i;
      }
      return -1;
    }

    /** 合并同类堆叠，返回剩余数量。 */
    addItem(itemId, qty) {
      const item = Catalog.getItem(itemId);
      if (!item || qty <= 0) return qty;
      if (!this.acceptsItem(itemId)) return qty;

      let remaining = qty;
      for (let i = 0; i < this.slots.length && remaining > 0; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        const space = item.maxStack - raw.qty;
        if (space <= 0) continue;
        const moved = Math.min(space, remaining);
        raw.qty += moved;
        remaining -= moved;
      }

      while (remaining > 0) {
        const origin = this.findPlaceIndex(itemId);
        if (origin < 0) break;
        const moved = Math.min(item.maxStack, remaining);
        this.placeStack(origin, { itemId, qty: moved });
        remaining -= moved;
      }

      return remaining;
    }

    /** 从库存扣除物品，返回实际扣除数量。 */
    removeItem(itemId, qty) {
      if (qty <= 0) return 0;
      let need = qty;
      let removed = 0;
      for (let i = 0; i < this.slots.length && need > 0; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        const take = Math.min(raw.qty, need);
        if (take >= raw.qty) this.clearFootprint(i);
        else raw.qty -= take;
        need -= take;
        removed += take;
      }
      return removed;
    }

    /** 统计某物品数量。 */
    countItem(itemId) {
      let total = 0;
      for (let i = 0; i < this.slots.length; i += 1) {
        const raw = this.slots[i];
        if (!raw || isOccupancyMarker(raw) || raw.itemId !== itemId) continue;
        total += raw.qty;
      }
      return total;
    }

    /** 导出可序列化快照（只存原点堆叠）。 */
    toJSON() {
      return {
        id: this.id,
        cols: this.cols,
        rows: this.rows,
        ignoreItemSize: this.ignoreItemSize,
        slotKeys: this.slotKeys,
        slots: this.slots.map((slot) => {
          if (!slot || isOccupancyMarker(slot)) return null;
          return { itemId: slot.itemId, qty: slot.qty };
        }),
      };
    }

    /** 从快照恢复并重建占位。 */
    static fromJSON(data, options = {}) {
      const ignoreItemSize =
        options.ignoreItemSize ?? Boolean(data.ignoreItemSize);
      const slotKeys = options.slotKeys ?? data.slotKeys ?? null;
      const inv = new Inventory(data.id, data.cols, data.rows, [], {
        ignoreItemSize,
        slotKeys: slotKeys || undefined,
      });
      const pending = [];
      for (let i = 0; i < (data.slots || []).length; i += 1) {
        const stack = normalizeStack(data.slots[i]);
        if (stack) pending.push({ index: i, stack });
      }
      for (const entry of pending) {
        if (!inv.placeStack(entry.index, entry.stack)) {
          inv.addItem(entry.stack.itemId, entry.stack.qty);
        }
      }
      return inv;
    }
  }

  const PLAYER_SEED = [
    { index: 0, stack: { itemId: 'coal', qty: 16 } },
    { index: 1, stack: { itemId: 'scrap', qty: 4 } },
    { index: 2, stack: { itemId: 'wrench', qty: 1 } },
    { index: 4, stack: { itemId: 'signal_lamp', qty: 1 } },
    { index: 6, stack: { itemId: 'work_cap', qty: 1 } },
    { index: 9, stack: { itemId: 'work_vest', qty: 1 } },
    { index: 18, stack: { itemId: 'work_pants', qty: 1 } },
  ];

  const STORAGE_SEED = [
    { index: 0, stack: { itemId: 'coal', qty: 100 } },
    { index: 1, stack: { itemId: 'lumber', qty: 64 } },
    { index: 2, stack: { itemId: 'iron_ingot', qty: 40 } },
    { index: 3, stack: { itemId: 'scrap', qty: 20 } },
  ];

  /** 新建默认背包。 */
  function createDefaultPlayer() {
    return new Inventory('player', 6, 5, PLAYER_SEED);
  }

  /** 新建默认仓库。 */
  function createDefaultStorage() {
    return new Inventory('storage', 8, 8, STORAGE_SEED);
  }

  /** 新建双手槽（无视物品占格）。 */
  function createDefaultHands() {
    return new Inventory('hands', 2, 1, [], { ignoreItemSize: true });
  }

  /** 新建装备栏（头/胸/腿/配件×2）。 */
  function createDefaultEquip() {
    return new Inventory('equip', 5, 1, [], {
      ignoreItemSize: true,
      slotKeys: EQUIP_SLOT_KEYS,
    });
  }

  /** 组装一套库存（含缺省装备栏）。 */
  function bundleInventories(partial) {
    return {
      player: partial.player,
      storage: partial.storage,
      hands: partial.hands || createDefaultHands(),
      equip: partial.equip || createDefaultEquip(),
    };
  }

  /** 从旧版存档迁移。 */
  function migrateFromLegacy() {
    for (const key of LEGACY_KEYS) {
      const saved = localStorage.getItem(key);
      if (!saved) continue;
      try {
        const parsed = JSON.parse(saved);
        return bundleInventories({
          player: Inventory.fromJSON(parsed.player),
          storage: Inventory.fromJSON(parsed.storage),
          hands: parsed.hands
            ? Inventory.fromJSON(parsed.hands, { ignoreItemSize: true })
            : createDefaultHands(),
          equip: parsed.equip
            ? Inventory.fromJSON(parsed.equip, {
                ignoreItemSize: true,
                slotKeys: EQUIP_SLOT_KEYS,
              })
            : createDefaultEquip(),
        });
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** 读取或初始化持久化库存。 */
  function loadInventories() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) {
      return (
        migrateFromLegacy() ||
        bundleInventories({
          player: createDefaultPlayer(),
          storage: createDefaultStorage(),
          hands: createDefaultHands(),
          equip: createDefaultEquip(),
        })
      );
    }
    try {
      const parsed = JSON.parse(saved);
      return bundleInventories({
        player: Inventory.fromJSON(parsed.player),
        storage: Inventory.fromJSON(parsed.storage),
        hands: parsed.hands
          ? Inventory.fromJSON(parsed.hands, { ignoreItemSize: true })
          : createDefaultHands(),
        equip: parsed.equip
          ? Inventory.fromJSON(parsed.equip, {
              ignoreItemSize: true,
              slotKeys: EQUIP_SLOT_KEYS,
            })
          : createDefaultEquip(),
      });
    } catch {
      return bundleInventories({
        player: createDefaultPlayer(),
        storage: createDefaultStorage(),
        hands: createDefaultHands(),
        equip: createDefaultEquip(),
      });
    }
  }

  /** 保存库存到 localStorage。 */
  function saveInventories(player, storage, hands, equip) {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        player: player.toJSON(),
        storage: storage.toJSON(),
        hands: hands.toJSON(),
        equip: equip.toJSON(),
      })
    );
  }

  /** 将堆叠放入槽位，返回未能放入的部分（或交换出的堆叠）。 */
  function placeOnSlot(inventory, index, stack) {
    const incoming = normalizeStack(stack);
    if (!incoming) return stack;
    const origin = inventory.originIndex(index);
    if (!inventory.acceptsItem(incoming.itemId, origin)) return stack;

    const current = inventory.getSlot(origin);

    if (!current) {
      if (!inventory.placeStack(origin, incoming)) return incoming;
      return null;
    }

    if (current.itemId === incoming.itemId) {
      const item = Catalog.getItem(incoming.itemId);
      const space = item.maxStack - current.qty;
      if (space <= 0) return incoming;
      const moved = Math.min(space, incoming.qty);
      inventory.slots[origin].qty = current.qty + moved;
      const leftoverQty = incoming.qty - moved;
      return leftoverQty > 0 ? { itemId: incoming.itemId, qty: leftoverQty } : null;
    }

    // 交换：先拿走目标，再尝试放入；失败则还原
    const removed = inventory.takeSlot(origin);
    if (!inventory.placeStack(origin, incoming)) {
      if (removed) inventory.placeStack(origin, removed);
      return incoming;
    }
    return removed;
  }

  /** Shift+点击：整堆转移到另一库存。 */
  function quickTransfer(sourceInv, sourceIndex, targetInv) {
    const origin = sourceInv.originIndex(sourceIndex);
    const stack = sourceInv.getSlot(origin);
    if (!stack) return;
    if (!targetInv.acceptsItem(stack.itemId)) return;
    const leftover = targetInv.addItem(stack.itemId, stack.qty);
    if (leftover >= stack.qty) return;
    if (leftover <= 0) {
      sourceInv.takeSlot(origin);
    } else {
      sourceInv.slots[origin].qty = leftover;
    }
  }

  window.LpInventoryCore = {
    Inventory,
    EQUIP_SLOT_KEYS,
    loadInventories,
    saveInventories,
    placeOnSlot,
    quickTransfer,
    normalizeStack,
  };
})();
