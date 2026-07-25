/**
 * 可编辑车厢设施摆放：P 进入/退出；底栏从仓储拖设施到舱内格子；退出时本地持久化布局。
 * 首通仅仓储 / 空车厢；布局存 localStorage（联机不同步）。
 * 编辑中 R 水平镜像（flip）；设施仅视觉、不参与走道碰撞；联机时不扣/不还权威仓储。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const Catalog = window.LpItemCatalog;
  const STORAGE_KEY = 'lp-facility-layouts-v1';
  /** 与 carriage-spec 左右内收列数对齐；已迁移则写入此 key，避免重复平移。 */
  const LAYOUT_COL_INSET_MIGRATED_KEY = 'lp-facility-layouts-col-inset-v1';
  /** 网格向上多 1 行后的 floor-anchored 迁移标记（row+=1）；仅一次。 */
  const LAYOUT_ROW_UP_MIGRATED_KEY = 'lp-facility-layouts-row-up-v1';
  /** 灭火器站占地 2×1→2×3 后的布局重适配标记；仅一次。 */
  const LAYOUT_FES_2X3_MIGRATED_KEY = 'lp-facility-layouts-fes-2x3-v1';
  /** 相对旧 3 行网格，顶原点下存档需下移的行数（底边贴地不变）。 */
  const LAYOUT_ROW_UP_DELTA = 1;
  const FES_STATION_ID = 'facility_fire_extinguisher_station';

  const root = document.getElementById('lpFacilityEditRoot');
  const trayEl = document.getElementById('lpFacilityTray');
  const hintEl = document.getElementById('lpFacilityEditHint');
  const doneBtn = document.getElementById('lpFacilityEditDone');
  const ghostEl = document.getElementById('lpFacilityGhost');
  if (!root || !trayEl) return;

  /** @type {Record<string, Array<{ id: string, itemId: string, col: number, row: number, flip?: boolean }>>} */
  let layouts = loadLayouts();
  let editing = false;
  /** @type {string|null} */
  let editCarId = null;
  /** @type {{ itemId: string, fromPlacedId: string|null, flip: boolean }|null} */
  let drag = null;
  /** @type {{ col: number, row: number, ok: boolean }|null} */
  let hoverCell = null;
  /** 最近交互的已放设施 id（供未命中时 R 镜像）。 */
  let selectedId = null;
  /** 编辑态最近指针（客户端坐标），用于 R 命中检测。 */
  const lastPointer = { x: 0, y: 0 };
  let dirty = false;
  let onlineHintShown = false;

  /** 联机权威库存是否生效（此时禁止本地改仓储）。 */
  function isOnlineAuthority() {
    return Boolean(window.LpInventoryNet?.isActive?.());
  }

  /**
   * 规范化一条放置记录；仅在水平镜像时保留 flip:true（旧存档无该字段视为未翻转）。
   * @param {object} e
   * @param {string} fallbackId
   */
  function normalizePlacement(e, fallbackId) {
    const out = {
      id: typeof e.id === 'string' ? e.id : fallbackId,
      itemId: e.itemId,
      col: Math.max(0, e.col | 0),
      row: Math.max(0, e.row | 0),
    };
    if (e.flip) out.flip = true;
    return out;
  }

  /** 放置是否水平镜像。 */
  function isFlipped(placement) {
    return Boolean(placement?.flip);
  }

  /**
   * 写入或清除放置上的水平镜像标记。
   * @param {{ flip?: boolean }} target
   * @param {boolean} flip
   */
  function applyFlipFlag(target, flip) {
    if (flip) target.flip = true;
    else delete target.flip;
  }

  /** 从 localStorage 读取各车布局。 */
  function loadLayouts() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      const out = {};
      for (const [carId, list] of Object.entries(parsed)) {
        if (!Array.isArray(list)) continue;
        out[carId] = list
          .filter((e) => e && typeof e.itemId === 'string')
          .map((e, i) => normalizePlacement(e, `f_${carId}_${i}`));
      }
      return out;
    } catch {
      return {};
    }
  }

  /** 将当前布局写入 localStorage；失败时 toast，不抛以免卡在编辑态。 */
  function saveLayouts() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layouts));
      dirty = false;
      return true;
    } catch (err) {
      console.warn('[lp-facility-edit] saveLayouts', err);
      window.LiminalInteract?.showToast?.('设施布局保存失败（本地存储已满？）');
      return false;
    }
  }

  /**
   * 网格左右各去掉 inset 列后迁移本地布局：col 减 inset，越界则夹紧；
   * 仍无效或与保留项重叠则丢弃并退回仓储。仅执行一次（标记 key）。
   */
  function migrateLayoutsForSideInset() {
    const inset = Spec?.FACILITY_GRID_SIDE_INSET_COLS ?? 1;
    if (inset <= 0) return;
    try {
      if (localStorage.getItem(LAYOUT_COL_INSET_MIGRATED_KEY) === '1') return;
    } catch {
      /* 无存储时仍尝试内存迁移 */
    }
    let changed = false;
    const next = {};
    for (const [carId, list] of Object.entries(layouts)) {
      const grid = Spec?.facilityGridFor?.(carId);
      const kept = [];
      for (const p of list) {
        let col = (p.col | 0) - inset;
        let row = p.row | 0;
        const size = Catalog?.getFacilitySize?.(p.itemId) || { w: 1, h: 1 };
        if (grid) {
          if (size.w > grid.cols || size.h > grid.rows) {
            returnToStorage(p.itemId);
            changed = true;
            continue;
          }
          const maxCol = Math.max(0, grid.cols - size.w);
          const maxRow = Math.max(0, grid.rows - size.h);
          if (col < 0) col = 0;
          if (row < 0) row = 0;
          if (col > maxCol) col = maxCol;
          if (row > maxRow) row = maxRow;
        } else if (col < 0 || row < 0) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        const candidate = { ...p, col, row };
        if (grid && placementOverlapsList(kept, grid, candidate)) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        if (candidate.col !== p.col || candidate.row !== p.row) changed = true;
        kept.push(candidate);
      }
      next[carId] = kept;
      if (kept.length !== list.length) changed = true;
    }
    layouts = next;
    try {
      localStorage.setItem(LAYOUT_COL_INSET_MIGRATED_KEY, '1');
    } catch {
      /* ignore */
    }
    if (changed) saveLayouts();
  }

  /**
   * 网格向上多 LAYOUT_ROW_UP_DELTA 行后迁移本地布局。
   * 存档 row 为顶左原点索引、底边贴地板；扩顶后 originY 上移，故 row+=Δ 保持相对地板世界位置。
   * 越界夹紧；仍无效或重叠则退回仓储。仅执行一次（标记 key）。
   */
  function migrateLayoutsForExtraTopRow() {
    const delta = LAYOUT_ROW_UP_DELTA;
    if (delta <= 0) return;
    try {
      if (localStorage.getItem(LAYOUT_ROW_UP_MIGRATED_KEY) === '1') return;
    } catch {
      /* 无存储时仍尝试内存迁移 */
    }
    let changed = false;
    const next = {};
    for (const [carId, list] of Object.entries(layouts)) {
      const grid = Spec?.facilityGridFor?.(carId);
      const kept = [];
      for (const p of list) {
        let col = p.col | 0;
        let row = (p.row | 0) + delta;
        const size = Catalog?.getFacilitySize?.(p.itemId) || { w: 1, h: 1 };
        if (grid) {
          if (size.w > grid.cols || size.h > grid.rows) {
            returnToStorage(p.itemId);
            changed = true;
            continue;
          }
          const maxCol = Math.max(0, grid.cols - size.w);
          const maxRow = Math.max(0, grid.rows - size.h);
          if (col < 0) col = 0;
          if (row < 0) row = 0;
          if (col > maxCol) col = maxCol;
          if (row > maxRow) row = maxRow;
        } else if (col < 0 || row < 0) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        const candidate = { ...p, col, row };
        if (grid && placementOverlapsList(kept, grid, candidate)) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        if (candidate.col !== p.col || candidate.row !== p.row) changed = true;
        kept.push(candidate);
      }
      next[carId] = kept;
      if (kept.length !== list.length) changed = true;
    }
    layouts = next;
    try {
      localStorage.setItem(LAYOUT_ROW_UP_MIGRATED_KEY, '1');
    } catch {
      /* ignore */
    }
    if (changed) saveLayouts();
  }

  /**
   * 灭火器站由 2×1 改为 2×3：尽量贴地抬高原点（row-=2），夹紧后重试邻格；
   * 仍放不下则退回仓储。仅执行一次（标记 key）。
   */
  function migrateLayoutsForFes2x3() {
    try {
      if (localStorage.getItem(LAYOUT_FES_2X3_MIGRATED_KEY) === '1') return;
    } catch {
      /* 无存储时仍尝试内存迁移 */
    }
    let changed = false;
    const next = {};
    for (const [carId, list] of Object.entries(layouts)) {
      const grid = Spec?.facilityGridFor?.(carId);
      const kept = [];
      for (const p of list) {
        if (p.itemId !== FES_STATION_ID) {
          kept.push(p);
          continue;
        }
        if (!grid) {
          kept.push(p);
          continue;
        }
        const size = Catalog?.getFacilitySize?.(FES_STATION_ID) || { w: 2, h: 3 };
        if (size.w > grid.cols || size.h > grid.rows) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        const maxCol = Math.max(0, grid.cols - size.w);
        const maxRow = Math.max(0, grid.rows - size.h);
        /** 旧 2×1 底边约在 row；新 2×3 贴地原点优先 row-(h-1)。 */
        const preferRow = (p.row | 0) - (size.h - 1);
        const candidates = [];
        const pushCand = (col, row) => {
          const c = Math.max(0, Math.min(maxCol, col | 0));
          const r = Math.max(0, Math.min(maxRow, row | 0));
          if (!candidates.some((x) => x.col === c && x.row === r)) {
            candidates.push({ col: c, row: r });
          }
        };
        pushCand(p.col, preferRow);
        pushCand(p.col, p.row);
        for (let dRow = 1; dRow <= size.h + 1; dRow += 1) {
          pushCand(p.col, preferRow - dRow);
          pushCand(p.col, preferRow + dRow);
          pushCand(p.col, (p.row | 0) - dRow);
        }
        for (const dCol of [-1, 1, -2, 2]) {
          pushCand((p.col | 0) + dCol, preferRow);
          pushCand((p.col | 0) + dCol, p.row);
        }
        let fitted = null;
        for (const c of candidates) {
          const candidate = { ...p, col: c.col, row: c.row };
          if (!placementOverlapsList(kept, grid, candidate)) {
            fitted = candidate;
            break;
          }
        }
        if (!fitted) {
          returnToStorage(p.itemId);
          changed = true;
          continue;
        }
        if (fitted.col !== p.col || fitted.row !== p.row) changed = true;
        kept.push(fitted);
      }
      next[carId] = kept;
      if (kept.length !== list.length) changed = true;
    }
    layouts = next;
    try {
      localStorage.setItem(LAYOUT_FES_2X3_MIGRATED_KEY, '1');
    } catch {
      /* ignore */
    }
    if (changed) saveLayouts();
  }

  /**
   * 候选放置是否与已保留列表占地重叠。
   * @param {Array<{ itemId: string, col: number, row: number }>} kept
   * @param {{ cols: number, rows: number }} grid
   * @param {{ itemId: string, col: number, row: number }} candidate
   */
  function placementOverlapsList(kept, grid, candidate) {
    const cells = footprintCells(grid, candidate.col, candidate.row, candidate.itemId);
    if (!cells) return true;
    for (const other of kept) {
      const otherCells = footprintCells(grid, other.col, other.row, other.itemId);
      if (!otherCells) continue;
      for (const a of cells) {
        if (otherCells.some((b) => b.col === a.col && b.row === a.row)) return true;
      }
    }
    return false;
  }

  /** 是否处于设施编辑模式。 */
  function isOpen() {
    return editing;
  }

  /** 当前编辑车厢 id；未编辑时为 null。 */
  function getEditCarId() {
    return editCarId;
  }

  /**
   * 编辑态镜头锁焦点：舱内设施网格水平/竖直中心。
   * 供 liminal-platform 覆盖玩家跟随，使当前可编辑车厢居中。
   * @returns {{ x: number, y: number }|null}
   */
  function getCameraFocus() {
    if (!editing || !editCarId) return null;
    const grid = Spec?.facilityGridFor?.(editCarId);
    if (grid) {
      return {
        x: grid.originX + (grid.cols * grid.cell) / 2,
        y: grid.originY + (grid.rows * grid.cell) / 2,
      };
    }
    const car = Spec?.carriageById?.(editCarId);
    if (!car || Spec.WALK_LEFT == null || Spec.WALK_RIGHT == null) return null;
    return {
      x: car.worldX + (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2,
      y: Spec.FLOOR_Y - (Spec.CABIN_CEIL_INSET || 0) / 2,
    };
  }

  /** 取设施专用仓库（权威仍由物品栏模块持有）；缺省回落物资仓。 */
  function storageInv() {
    return (
      window.LpInventory?.getFacilityStorageInventory?.() ||
      window.LpInventory?.getStorageInventory?.() ||
      null
    );
  }

  /** 某设施在设施仓库中的数量。 */
  function storageCount(itemId) {
    return storageInv()?.countItem?.(itemId) || 0;
  }

  /**
   * 从设施仓库扣除一件设施；成功返回 true。
   * 联机：要求仓库仍有该设施（本机可见托盘），但不改权威仓储。
   */
  function takeFromStorage(itemId) {
    if (isOnlineAuthority()) {
      return (storageCount(itemId) || 0) >= 1;
    }
    const inv = storageInv();
    if (!inv) return false;
    if ((inv.countItem(itemId) || 0) < 1) return false;
    const removed = inv.removeItem(itemId, 1);
    if (removed < 1) return false;
    window.LpInventory?.persistAndRender?.();
    return true;
  }

  /**
   * 将一件设施退回设施仓库；满仓或拒收时返回 false（调用方应还原布局）。
   * 联机：不写入权威仓储，只删本机布局条目，故恒为 true。
   */
  function returnToStorage(itemId) {
    if (isOnlineAuthority()) return true;
    const inv = storageInv();
    if (!inv) return false;
    const leftover = inv.addItem(itemId, 1);
    if (leftover > 0) return false;
    window.LpInventory?.persistAndRender?.();
    return true;
  }

  /**
   * 指针是否落在底栏托盘回收区（几何判定，避免 disabled 按钮被 elementFromPoint 穿透）。
   * @param {number} clientX
   * @param {number} clientY
   */
  function isPointerOverTray(clientX, clientY) {
    const rect = trayEl.getBoundingClientRect();
    const pad = 8;
    return (
      clientX >= rect.left - pad &&
      clientX <= rect.right + pad &&
      clientY >= rect.top - pad &&
      clientY <= rect.bottom + pad
    );
  }

  /** 当前编辑车的放置列表。 */
  function placementsFor(carId) {
    if (!layouts[carId]) layouts[carId] = [];
    return layouts[carId];
  }

  /** 设施足迹格子列表；越界返回 null。 */
  function footprintCells(grid, col, row, itemId) {
    const size = Catalog?.getFacilitySize?.(itemId) || { w: 1, h: 1 };
    const cells = [];
    for (let dy = 0; dy < size.h; dy += 1) {
      for (let dx = 0; dx < size.w; dx += 1) {
        const c = col + dx;
        const r = row + dy;
        if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return null;
        cells.push({ col: c, row: r });
      }
    }
    return cells;
  }

  /**
   * 检查是否可放置（忽略 ignoreId 对应的已放设施）。
   * @param {string} carId
   * @param {string} itemId
   * @param {number} col
   * @param {number} row
   * @param {string|null} [ignoreId]
   */
  function canPlace(carId, itemId, col, row, ignoreId = null) {
    const grid = Spec?.facilityGridFor?.(carId);
    if (!grid) return false;
    const cells = footprintCells(grid, col, row, itemId);
    if (!cells) return false;
    const placed = placementsFor(carId);
    for (const p of placed) {
      if (ignoreId && p.id === ignoreId) continue;
      const other = footprintCells(grid, p.col, p.row, p.itemId);
      if (!other) continue;
      for (const a of cells) {
        if (other.some((b) => b.col === a.col && b.row === a.row)) return false;
      }
    }
    return true;
  }

  /** 世界坐标 → 网格格（左上对齐）。 */
  function worldToCell(grid, worldX, worldY) {
    const col = Math.floor((worldX - grid.originX) / grid.cell);
    const row = Math.floor((worldY - grid.originY) / grid.cell);
    return { col, row };
  }

  /** 命中已放置设施（按绘制矩形）。 */
  function hitPlaced(carId, worldX, worldY) {
    const grid = Spec?.facilityGridFor?.(carId);
    if (!grid) return null;
    const list = placementsFor(carId);
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const p = list[i];
      const size = Catalog?.getFacilitySize?.(p.itemId) || { w: 1, h: 1 };
      const x0 = grid.originX + p.col * grid.cell;
      const y0 = grid.originY + p.row * grid.cell;
      const x1 = x0 + size.w * grid.cell;
      const y1 = y0 + size.h * grid.cell;
      if (worldX >= x0 && worldX < x1 && worldY >= y0 && worldY < y1) return p;
    }
    return null;
  }

  /** 刷新底栏：设施仓库中有库存的可摆放设施。 */
  function renderTray() {
    trayEl.replaceChildren();
    const defs = Catalog?.listPlaceableFacilities?.() || [];
    for (const item of defs) {
      const qty = storageCount(item.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lp-facility-tray-item';
      btn.dataset.itemId = item.id;
      btn.disabled = qty <= 0;
      btn.title = qty > 0 ? `${item.name} ×${qty}` : `${item.name}（设施仓库无货）`;

      const swatch = document.createElement('span');
      swatch.className = 'lp-facility-tray-swatch';
      swatch.style.setProperty('--lp-fac-color', item.color || '#64748b');
      swatch.style.setProperty('--lp-fac-accent', item.accent || '#94a3b8');
      if (item.icon) {
        swatch.classList.add('has-image');
        swatch.style.setProperty('--lp-fac-icon', `url("${item.icon}")`);
        swatch.textContent = '';
      } else {
        swatch.textContent = item.short || item.name.slice(0, 1);
      }

      const meta = document.createElement('span');
      meta.className = 'lp-facility-tray-meta';
      const name = document.createElement('span');
      name.className = 'lp-facility-tray-name';
      name.textContent = item.name;
      const count = document.createElement('span');
      count.className = 'lp-facility-tray-qty';
      count.textContent = `×${qty}`;
      meta.append(name, count);

      btn.append(swatch, meta);
      btn.addEventListener('pointerdown', (event) => {
        if (qty <= 0 || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        beginDragFromTray(item.id, event);
      });
      trayEl.appendChild(btn);
    }
    if (!defs.length) {
      const empty = document.createElement('p');
      empty.className = 'lp-facility-tray-empty';
      empty.textContent = '设施仓库暂无可摆放设施';
      trayEl.appendChild(empty);
    }
  }

  /** 更新幽灵跟随指针；拖拽镜像时水平翻转幽灵。 */
  function syncGhost(clientX, clientY) {
    if (!ghostEl || !drag) {
      if (ghostEl) ghostEl.hidden = true;
      return;
    }
    const item = Catalog?.getItem?.(drag.itemId);
    const scaleX = drag.flip ? -1 : 1;
    ghostEl.hidden = false;
    ghostEl.style.transform = `translate(${clientX}px, ${clientY}px) scaleX(${scaleX})`;
    ghostEl.style.setProperty('--lp-fac-color', item?.color || '#64748b');
    ghostEl.style.setProperty('--lp-fac-accent', item?.accent || '#94a3b8');
    ghostEl.textContent = item?.short || item?.name?.slice(0, 1) || '?';
  }

  /** 从底栏开始拖拽（默认未镜像）。 */
  function beginDragFromTray(itemId, event) {
    if (!editing || storageCount(itemId) < 1) return;
    selectedId = null;
    drag = { itemId, fromPlacedId: null, flip: false };
    hoverCell = null;
    syncGhost(event.clientX, event.clientY);
    try {
      trayEl.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
  }

  /** 从已放置设施开始拖拽（移动或收回）；继承原镜像。 */
  function beginDragPlaced(placed, event) {
    selectedId = placed.id;
    drag = {
      itemId: placed.itemId,
      fromPlacedId: placed.id,
      flip: isFlipped(placed),
    };
    hoverCell = null;
    syncGhost(event.clientX, event.clientY);
  }

  /** 指针世界坐标（编辑模式下用游戏相机）。 */
  function pointerWorld(clientX, clientY) {
    const view = window.LpGame?.getCameraView?.();
    if (!view || !window.LpGame?.screenToWorld) return null;
    return window.LpGame.screenToWorld(clientX, clientY, view);
  }

  /** 拖拽过程中更新吸附格。 */
  function updateHoverFromPointer(clientX, clientY) {
    if (!drag || !editCarId) {
      hoverCell = null;
      return;
    }
    const world = pointerWorld(clientX, clientY);
    const grid = Spec?.facilityGridFor?.(editCarId);
    if (!world || !grid) {
      hoverCell = null;
      return;
    }
    const { col, row } = worldToCell(grid, world.x, world.y);
    const ok = canPlace(editCarId, drag.itemId, col, row, drag.fromPlacedId);
    hoverCell = { col, row, ok };
  }

  /** 放下设施；拖到底栏托盘则从布局收回并退回设施仓库。 */
  function finishDrag(event) {
    if (!drag || !editCarId) {
      drag = null;
      hoverCell = null;
      if (ghostEl) ghostEl.hidden = true;
      return;
    }
    const itemId = drag.itemId;
    const fromId = drag.fromPlacedId;
    const x = event?.clientX ?? 0;
    const y = event?.clientY ?? 0;
    const under = document.elementFromPoint(x, y);
    const overTray =
      isPointerOverTray(x, y) ||
      Boolean(under?.closest?.('#lpFacilityTray, #lpFacilityEditRoot'));

    if (overTray) {
      if (fromId) {
        const list = placementsFor(editCarId);
        const idx = list.findIndex((p) => p.id === fromId);
        if (idx >= 0) {
          const [removed] = list.splice(idx, 1);
          if (!returnToStorage(itemId)) {
            list.splice(idx, 0, removed);
            window.LiminalInteract?.showToast?.('无法退回设施仓库（已满？）');
          } else {
            dirty = true;
            renderTray();
          }
        }
      }
    } else if (hoverCell?.ok) {
      if (fromId) {
        const list = placementsFor(editCarId);
        const p = list.find((e) => e.id === fromId);
        if (p) {
          p.col = hoverCell.col;
          p.row = hoverCell.row;
          applyFlipFlag(p, Boolean(drag.flip));
          selectedId = p.id;
          dirty = true;
        }
      } else if (takeFromStorage(itemId)) {
        const entry = {
          id: `f_${editCarId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          itemId,
          col: hoverCell.col,
          row: hoverCell.row,
        };
        applyFlipFlag(entry, Boolean(drag.flip));
        placementsFor(editCarId).push(entry);
        selectedId = entry.id;
        dirty = true;
        renderTray();
      }
    } else if (fromId) {
      /* 未落到有效格 / 未收回：仍写回拖拽中改过的镜像 */
      const list = placementsFor(editCarId);
      const p = list.find((e) => e.id === fromId);
      if (p && Boolean(drag.flip) !== isFlipped(p)) {
        applyFlipFlag(p, Boolean(drag.flip));
        selectedId = p.id;
        dirty = true;
      }
    }

    drag = null;
    hoverCell = null;
    if (ghostEl) ghostEl.hidden = true;
  }

  /** 关闭其它全屏 UI，避免与编辑冲突。 */
  function closeOtherUi() {
    window.LpInventory?.close?.();
    window.LpTrainMap?.close?.();
    window.LpDungeonMap?.close?.();
    window.LpBoilerPanel?.close?.();
    window.LpFuelFeed?.close?.();
    window.LpGuardCrateUi?.close?.();
    window.LpRadarScope?.close?.();
    window.LpAutoConsole?.close?.();
  }

  /**
   * 尝试进入当前车厢的设施编辑；不可编辑则无操作。
   * @param {number} [worldX]
   * @returns {boolean}
   */
  function tryEnter(worldX) {
    if (editing) return false;
    if (window.LpPlayerDeath?.isIncapacitated?.()) return false;
    if (window.LpGuardTurret?.isManned?.()) return false;
    const x = worldX ?? window.LpGame?.getLocalX?.();
    if (x == null || !Number.isFinite(Number(x))) return false;
    const car = Spec?.carriageAt?.(Number(x));
    if (!car || !Spec.isFacilityEditable(car)) return false;

    closeOtherUi();
    editing = true;
    editCarId = car.id;
    drag = null;
    hoverCell = null;
    selectedId = null;
    dirty = false;
    document.body.classList.add('lp-facility-edit-open');
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    const online = isOnlineAuthority();
    const coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches;
    if (hintEl) {
      if (online) {
        hintEl.textContent = coarse
          ? `${car.label} · 联机仅本机可见 · R 镜像 · 点「完成」保存退出`
          : `${car.label} · 联机布局仅本机可见 · R 镜像 · 再按 P 或点「完成」保存退出`;
      } else {
        hintEl.textContent = coarse
          ? `${car.label} · 拖底栏到格子 · R 镜像 · 点「完成」保存 · 拖回底栏收回`
          : `${car.label} · 拖底栏到格子 · R 镜像 · 再按 P 或点「完成」保存退出 · 拖回底栏收回`;
      }
    }
    if (online && !onlineHintShown) {
      onlineHintShown = true;
      window.LiminalInteract?.showToast?.(
        '联机：设施布局仅本机可见，不挡走道、不改共享仓储'
      );
    }
    renderTray();
    return true;
  }

  /** 退出编辑并持久化布局。 */
  function exit(save = true) {
    if (!editing) return;
    if (drag?.fromPlacedId) {
      /* 中断拖拽时保持原放置 */
    } else if (drag && !drag.fromPlacedId) {
      /* 从仓储拖出未放下：未扣仓储 */
    }
    drag = null;
    hoverCell = null;
    selectedId = null;
    if (ghostEl) ghostEl.hidden = true;
    if (save) saveLayouts();
    editing = false;
    editCarId = null;
    document.body.classList.remove('lp-facility-edit-open');
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
  }

  /**
   * 切换编辑：在可编辑车厢按 P 进入；编辑中再按 P 保存退出。
   * @param {number} [worldX]
   * @returns {boolean} 是否处理了按键
   */
  function toggle(worldX) {
    if (editing) {
      exit(true);
      return true;
    }
    return tryEnter(worldX);
  }

  /**
   * 绘制单件设施块：有 icon 时只 drawImage（保留 PNG alpha，不垫黑/色底）；
   * 贴图按占格 AABB contain、贴地底对齐，禁止非等比拉伸；flip 时水平镜像。
   */
  function drawFacilityBlock(ctx, grid, placement, fillAlpha = 0.92) {
    const item = Catalog?.getItem?.(placement.itemId);
    const size = Catalog?.getFacilitySize?.(placement.itemId) || { w: 1, h: 1 };
    const x = grid.originX + placement.col * grid.cell;
    const y = grid.originY + placement.row * grid.cell;
    const w = size.w * grid.cell;
    const h = size.h * grid.cell;
    const pad = 2;
    ctx.save();
    if (isFlipped(placement)) {
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.translate(cx, cy);
      ctx.scale(-1, 1);
      ctx.translate(-cx, -cy);
    }
    if (item?.icon) {
      const img = getFacilityImage(item.icon);
      if (img?.complete && img.naturalWidth > 0) {
        ctx.globalAlpha = fillAlpha;
        drawFacilityIconContain(ctx, img, x, y, w, h, pad);
        ctx.restore();
        return;
      }
    }
    const boxX = x + pad;
    const boxY = y + pad;
    const boxW = w - pad * 2;
    const boxH = h - pad * 2;
    ctx.globalAlpha = fillAlpha;
    ctx.fillStyle = item?.color || '#475569';
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = item?.accent || '#94a3b8';
    ctx.lineWidth = 2;
    ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);
    ctx.fillStyle = item?.accent || '#e2e8f0';
    ctx.font = `${Math.max(10, grid.cell * 0.28)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(item?.short || '?', x + w / 2, y + h / 2);
    ctx.restore();
  }

  /**
   * 将设施贴图按 contain 画入占格（等比缩放；水平居中、底边贴格底；不垫底色）。
   * 用占格 w×h 算比例（pad 只内缩可画区，不改变轴向独立拉伸）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasImageSource} img
   * @param {number} dx 占格左
   * @param {number} dy 占格顶
   * @param {number} dw 占格宽
   * @param {number} dh 占格高
   * @param {number} [pad=0] 四边内缩像素
   */
  function drawFacilityIconContain(ctx, img, dx, dy, dw, dh, pad = 0) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!(iw > 0 && ih > 0 && dw > 0 && dh > 0)) return;
    const inset = Math.max(0, pad);
    const innerW = Math.max(1, dw - inset * 2);
    const innerH = Math.max(1, dh - inset * 2);
    const scale = Math.min(innerW / iw, innerH / ih);
    const rw = iw * scale;
    const rh = ih * scale;
    const ox = dx + inset + (innerW - rw) / 2;
    const oy = dy + dh - inset - rh;
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, ox, oy, rw, rh);
    ctx.imageSmoothingEnabled = prevSmooth;
  }

  /** 设施贴图缓存。 */
  const facilityImages = new Map();

  /** 按 URL 懒加载设施贴图（依赖 catalog icon 上的 ?v= 作缓存破坏）。 */
  function getFacilityImage(url) {
    if (!url) return null;
    let img = facilityImages.get(url);
    if (img) return img;
    img = new Image();
    img.decoding = 'async';
    img.src = url;
    facilityImages.set(url, img);
    return img;
  }

  /**
   * 世界层绘制：已放置设施；编辑中叠加网格与预览。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!Spec?.CARRIAGES || !ctx) return;

    for (const car of Spec.CARRIAGES) {
      if (!Spec.isFacilityEditable(car)) continue;
      const grid = Spec.facilityGridFor(car);
      if (!grid) continue;
      const list = placementsFor(car.id);
      const skipId = editing && editCarId === car.id ? drag?.fromPlacedId : null;
      for (const p of list) {
        if (skipId && p.id === skipId) continue;
        drawFacilityBlock(ctx, grid, p);
      }
    }

    if (!editing || !editCarId) return;
    const grid = Spec.facilityGridFor(editCarId);
    if (!grid) return;

    ctx.save();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= grid.cols; c += 1) {
      const x = grid.originX + c * grid.cell;
      ctx.beginPath();
      ctx.moveTo(x, grid.originY);
      ctx.lineTo(x, grid.originY + grid.rows * grid.cell);
      ctx.stroke();
    }
    for (let r = 0; r <= grid.rows; r += 1) {
      const y = grid.originY + r * grid.cell;
      ctx.beginPath();
      ctx.moveTo(grid.originX, y);
      ctx.lineTo(grid.originX + grid.cols * grid.cell, y);
      ctx.stroke();
    }
    ctx.restore();

    if (drag && hoverCell) {
      const size = Catalog?.getFacilitySize?.(drag.itemId) || { w: 1, h: 1 };
      const preview = {
        itemId: drag.itemId,
        col: hoverCell.col,
        row: hoverCell.row,
      };
      applyFlipFlag(preview, Boolean(drag.flip));
      ctx.save();
      ctx.globalAlpha = hoverCell.ok ? 0.55 : 0.28;
      if (!hoverCell.ok) {
        ctx.fillStyle = 'rgba(185, 28, 28, 0.45)';
        ctx.fillRect(
          grid.originX + hoverCell.col * grid.cell + 2,
          grid.originY + hoverCell.row * grid.cell + 2,
          size.w * grid.cell - 4,
          size.h * grid.cell - 4
        );
      } else {
        drawFacilityBlock(ctx, grid, preview, 0.7);
      }
      ctx.restore();
    }
  }

  /**
   * 编辑态按 R：水平镜像当前拖拽件，或指针下 / 最近选中的已放设施。
   * @returns {boolean} 是否处理了按键
   */
  function toggleMirror() {
    if (!editing || !editCarId) return false;
    if (drag) {
      drag.flip = !drag.flip;
      syncGhost(lastPointer.x, lastPointer.y);
      return true;
    }
    const world = pointerWorld(lastPointer.x, lastPointer.y);
    let target = world ? hitPlaced(editCarId, world.x, world.y) : null;
    if (!target && selectedId) {
      target = placementsFor(editCarId).find((p) => p.id === selectedId) || null;
    }
    if (!target) return false;
    applyFlipFlag(target, !isFlipped(target));
    selectedId = target.id;
    dirty = true;
    return true;
  }

  document.addEventListener('pointermove', (event) => {
    if (!editing) return;
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    if (!drag) return;
    syncGhost(event.clientX, event.clientY);
    updateHoverFromPointer(event.clientX, event.clientY);
  });

  document.addEventListener('pointerup', (event) => {
    if (!editing || !drag) return;
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    updateHoverFromPointer(event.clientX, event.clientY);
    finishDrag(event);
  });

  document.addEventListener('pointercancel', () => {
    if (!drag) return;
    drag = null;
    hoverCell = null;
    if (ghostEl) ghostEl.hidden = true;
  });

  window.addEventListener('pointerdown', (event) => {
    if (!editing || !editCarId || event.button !== 0) return;
    lastPointer.x = event.clientX;
    lastPointer.y = event.clientY;
    if (event.target?.closest?.('#lpFacilityEditRoot')) return;
    if (event.target?.closest?.('.lp-inventory-root, .lp-train-map-root')) return;
    const world = pointerWorld(event.clientX, event.clientY);
    if (!world) return;
    const placed = hitPlaced(editCarId, world.x, world.y);
    if (!placed) return;
    event.preventDefault();
    beginDragPlaced(placed, event);
    updateHoverFromPointer(event.clientX, event.clientY);
  }, true);

  /** 仅设施编辑态占用 R（镜像）；捕获阶段抢在换弹绑定之前，且编辑时 isUiOpen 已挡住换弹。 */
  window.addEventListener(
    'keydown',
    (event) => {
      if (!editing) return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (event.repeat) return;
      const isR =
        event.code === 'KeyR' || event.key === 'r' || event.key === 'R';
      if (!isR) return;
      if (!toggleMirror()) return;
      event.preventDefault();
      event.stopPropagation();
    },
    true
  );

  window.addEventListener('lp:inventory-changed', () => {
    if (editing) renderTray();
  });

  /** 「完成」：保存并退出设施编辑（触屏无 P 键时的主出口）。 */
  doneBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    exit(true);
  });

  migrateLayoutsForSideInset();
  migrateLayoutsForExtraTopRow();
  migrateLayoutsForFes2x3();

  /* 启动时加载布局（已在模块顶完成）；不自动进入编辑 */
  window.LpFacilityEdit = {
    isOpen,
    getEditCarId,
    getCameraFocus,
    toggle,
    tryEnter,
    exit,
    draw,
    saveLayouts,
    getLayouts: () => layouts,
    /** 权威库存变更后刷新底栏数量。 */
    refreshTray: renderTray,
  };
})();
