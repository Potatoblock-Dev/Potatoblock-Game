/**
 * 小型月台地牢：确定性布局（走廊 / 楼梯 / 安全屋·敌房·仓库房）。
 * 服务端只下发 world.seed；结构在客户端用 hash(seed, stationIndex) 生成。
 */
(() => {
  /**
   * 车厢足迹（与 carriage-spec 走道宽 × 舱内净空对齐；缺 Spec 时用 WORLD_SCALE=0.88 常量）。
   * 房间宽 ≈ 1.0–2.0× 走道宽。
   * 高：地牢无车厢贴图作参照，1× 舱高会显成扁条；用 ≈2.25× 舱高给足净空。
   */
  const _car = window.LiminalCarriageSpec;
  const CAR_WALK_W = _car
    ? _car.WALK_RIGHT - _car.WALK_LEFT
    : 1514 * 0.88; /* ≈1332 */
  const CAR_CABIN_H = _car ? _car.CABIN_CEIL_INSET : 320 * 0.88; /* ≈282 */

  /* 层间空气隙 + 同层走廊保证房间 AABB 互不贴边 */
  const ROOM_H = Math.round(CAR_CABIN_H * 2.25); /* ≈634：约 2.25× 舱高，避免扁条 */
  const ROOM_AIR_GAP = 160; /* 上下房间体积之间的空隙 */
  const FLOOR_GAP = ROOM_H + ROOM_AIR_GAP; /* ≈794：楼层地板间距 */
  const BASE_FLOOR_Y = 720;
  const ROOM_W_MIN = Math.round(CAR_WALK_W); /* ≈1332：1× 走道宽 */
  const ROOM_W_SPAN = Math.round(CAR_WALK_W); /* 宽 ≈1332–2664（至 2×） */
  const CORRIDOR_GAP_MIN = 260; /* 同层房间隔离最小间距（走廊隧道） */
  const CORRIDOR_GAP_SPAN = 140; /* 走廊 260–400 */
  const ROOM_PAD = 12; /* 任意两房间 AABB 最小外扩间隔 */
  const STAIR_LANDING = 72; /* 楼梯前后水平廊 stub */
  const STAIR_STEP_W = 36;
  const STAIR_STEP_H = 28;
  const MARGIN = 80;
  const WALL_THICK = 20; /* 房间侧墙 / 顶板厚度 */
  const DOOR_H = 220; /* 门洞净高（略高于立绘，与走廊同高） */
  const CORRIDOR_H = 220; /* 走廊隧道净高 */
  const PLAYER_HALF_W = 22;
  const PLAYER_BODY_H = 70;
  /** 最坏 3 层×3 房×2 厢宽 + 廊/梯 ≈28k；留余量 */
  const MAX_WIDTH = 32000;

  /** 与服务端 inventory_authority.PLATFORM_LOOT_TABLE 对齐。 */
  const PLATFORM_LOOT_TABLE = [
    { itemId: 'coal', min: 8, max: 32 },
    { itemId: 'lumber', min: 6, max: 24 },
    { itemId: 'iron_ingot', min: 4, max: 16 },
    { itemId: 'scrap', min: 4, max: 20 },
    { itemId: 'small_caliber_ammo', min: 24, max: 90 },
    { itemId: 'turret_ammo', min: 10, max: 40 },
    { itemId: 'medkit', min: 1, max: 1 },
    { itemId: 'first_aid_kit', min: 1, max: 2 },
  ];

  /** JS Math.imul 兼容。 */
  function imul(a, b) {
    return Math.imul(a | 0, b | 0);
  }

  /** mulberry32：与服务端 _mulberry32 对齐。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = imul(t ^ (t >>> 15), t | 1);
      t ^= t + imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 混合 worldSeed 与 stationIndex。 */
  function hash2(worldSeed, stationIndex) {
    let h = (worldSeed >>> 0) ^ imul((stationIndex | 0) + 1, 0x9e3779b9);
    h = imul(h ^ (h >>> 16), 0x85ebca6b);
    h = imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /**
   * 判定月台类型：无种子默认 large；?platform=small|large 可强制。
   * @param {number|null|undefined} worldSeed
   * @param {number} stationIndex
   * @returns {'small'|'large'}
   */
  function resolveKind(worldSeed, stationIndex) {
    try {
      const force = new URLSearchParams(location.search).get('platform');
      if (force === 'small' || force === 'large') return force;
    } catch (_) {
      /* ignore */
    }
    if (worldSeed == null || !Number.isFinite(Number(worldSeed))) return 'large';
    const r = mulberry32(hash2(Number(worldSeed), stationIndex | 0))();
    return r < 0.5 ? 'small' : 'large';
  }

  /**
   * 生成地牢仓库堆叠列表（不写 Inventory；供 Core / 服务端对齐）。
   * @param {number} worldSeed
   * @param {number} stationIndex
   * @returns {Array<{ itemId: string, qty: number, mag?: number, dur?: number, ammo?: number }>}
   */
  function platformLootStacks(worldSeed, stationIndex) {
    const rng = mulberry32(hash2(worldSeed, stationIndex) ^ 0xa11ce);
    const Catalog = window.LpItemCatalog;
    const out = [];
    const pileCount = 4 + Math.floor(rng() * 5);
    for (let i = 0; i < pileCount; i += 1) {
      const entry = PLATFORM_LOOT_TABLE[Math.floor(rng() * PLATFORM_LOOT_TABLE.length)];
      const qty = entry.min + Math.floor(rng() * (entry.max - entry.min + 1));
      if (qty < 1) continue;
      const stack = { itemId: entry.itemId, qty };
      const item = Catalog?.getItem?.(entry.itemId);
      if (item?.magazineSize != null) stack.mag = item.magazineSize;
      if (item?.maxDurability != null) stack.dur = item.maxDurability;
      if (item?.maxAmmo != null) stack.ammo = item.maxAmmo;
      out.push(stack);
    }
    return out;
  }

  /**
   * 把战利品灌进 Inventory 实例（先清空）。
   * @param {object} inv
   * @param {number} worldSeed
   * @param {number} stationIndex
   */
  function fillPlatformInventory(inv, worldSeed, stationIndex) {
    if (!inv) return;
    for (let i = 0; i < inv.size(); i += 1) {
      if (inv.isCovered?.(i)) continue;
      if (inv.getSlot?.(i)) inv.takeSlot?.(i);
    }
    for (const stack of platformLootStacks(worldSeed, stationIndex)) {
      let placed = false;
      for (let i = 0; i < inv.size(); i += 1) {
        if (inv.isCovered?.(i) || inv.getSlot?.(i)) continue;
        if (inv.placeStack?.(i, { ...stack })) {
          placed = true;
          break;
        }
      }
      if (!placed) inv.addItem?.(stack.itemId, stack.qty);
    }
  }

  /** 追加一段可走平台。 */
  function pushWalk(walks, left, right, y) {
    if (right - left < 8) return;
    walks.push({ left, right, y });
  }

  /** 在两层之间造阶梯走道（从 lowerY 爬到 upperY，Y 越小越高）。 */
  function buildStairs(walks, x0, lowerY, upperY) {
    const rise = lowerY - upperY;
    if (rise <= 0) return x0;
    const steps = Math.max(2, Math.ceil(rise / STAIR_STEP_H));
    let x = x0;
    for (let i = 0; i <= steps; i += 1) {
      const y = lowerY - (rise * i) / steps;
      pushWalk(walks, x, x + STAIR_STEP_W + 4, y);
      x += STAIR_STEP_W;
    }
    return x;
  }

  /**
   * 两房间体积（含 pad）是否相交：同层贴边或跨层叠成一团时为 true。
   * @param {{ left: number, right: number, floorY: number, ceilingY: number }} a
   * @param {{ left: number, right: number, floorY: number, ceilingY: number }} b
   * @param {number} pad
   */
  function roomsAabbOverlap(a, b, pad) {
    if (a.right + pad <= b.left || b.right + pad <= a.left) return false;
    if (a.floorY + pad <= b.ceilingY || b.floorY + pad <= a.ceilingY) return false;
    return true;
  }

  /**
   * 校验所有房间两两隔离（仅开发期告警，不改布局）。
   * @param {Array<object>} rooms
   */
  function warnIfRoomsNotIsolated(rooms) {
    for (let i = 0; i < rooms.length; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        if (roomsAabbOverlap(rooms[i], rooms[j], ROOM_PAD)) {
          console.warn('[LpDungeon] rooms not isolated', rooms[i].id, rooms[j].id);
        }
      }
    }
  }

  /**
   * 铺一段同层水平走廊（房间隔离带），并登记 FoW 端点 id。
   * @param {object[]} walks
   * @param {object[]} corridors
   * @param {number} left
   * @param {number} right
   * @param {number} y
   * @param {number} floor
   * @param {string|null} fromRoomId
   * @param {string|null} toRoomId
   */
  function pushCorridor(walks, corridors, left, right, y, floor, fromRoomId, toRoomId) {
    pushWalk(walks, left, right, y);
    corridors.push({
      left,
      right,
      y,
      floor,
      height: CORRIDOR_H,
      fromRoomId,
      toRoomId,
    });
  }

  /**
   * 追加一块实心墙 AABB（canvas：top < bottom）。
   * kind='v' 仅水平碰撞（侧墙/门楣竖条）；kind='h' 仅竖直碰撞（顶板/走廊隔断填实）。
   * @param {object[]} walls
   * @param {number} left
   * @param {number} top
   * @param {number} right
   * @param {number} bottom
   * @param {'v'|'h'} kind
   */
  function pushWall(walls, left, top, right, bottom, kind) {
    if (right - left < 1 || bottom - top < 1) return;
    walls.push({ left, top, right, bottom, kind });
  }

  /**
   * 为单间生成侧墙与顶板；有门的一侧只砌门楣以上，门洞通走廊。
   * @param {object[]} walls
   * @param {{ left: number, right: number, floorY: number, ceilingY: number, doorL?: boolean, doorR?: boolean }} room
   */
  function buildRoomShell(walls, room) {
    const { left, right, floorY, ceilingY } = room;
    pushWall(walls, left, ceilingY, right, ceilingY + WALL_THICK, 'h');
    if (room.doorL) {
      pushWall(walls, left, ceilingY, left + WALL_THICK, floorY - DOOR_H, 'v');
    } else {
      pushWall(walls, left, ceilingY, left + WALL_THICK, floorY, 'v');
    }
    if (room.doorR) {
      pushWall(walls, right - WALL_THICK, ceilingY, right, floorY - DOOR_H, 'v');
    } else {
      pushWall(walls, right - WALL_THICK, ceilingY, right, floorY, 'v');
    }
  }

  /**
   * 走廊：隧道上方填实墙（房间之间的隔断），下方留 CORRIDOR_H 可走空洞。
   * @param {object[]} walls
   * @param {{ left: number, right: number, y: number }} corridor
   */
  function buildCorridorShell(walls, corridor) {
    const ceil = corridor.y - CORRIDOR_H;
    /* 隔断实体：从房间顶高落到隧道顶（只挡跳跃，不水平挤出） */
    pushWall(walls, corridor.left, corridor.y - ROOM_H, corridor.right, ceil, 'h');
    /* 隧道顶板厚度 */
    pushWall(walls, corridor.left, ceil - WALL_THICK, corridor.right, ceil, 'h');
  }

  /**
   * 根据房间门洞与走廊列表生成全部实心墙。
   * @param {object[]} rooms
   * @param {object[]} corridors
   * @returns {object[]}
   */
  function buildWalls(rooms, corridors) {
    const walls = [];
    for (const room of rooms) {
      buildRoomShell(walls, room);
    }
    for (const c of corridors) {
      buildCorridorShell(walls, c);
    }
    return walls;
  }

  /**
   * 竖直方向是否与墙重叠（开区间边缘不碰）。
   * @param {number} head
   * @param {number} feet
   * @param {{ top: number, bottom: number }} wall
   */
  function bodyOverlapsWallY(head, feet, wall) {
    return feet > wall.top && head < wall.bottom;
  }

  /**
   * 水平推离竖直侧墙；宽幅顶板/隔断不参与，避免走廊跳起被整条挤出。
   * @param {object[]} walls
   * @param {number} x
   * @param {number} halfW
   * @param {number} head
   * @param {number} feet
   */
  function resolveWallsX(walls, x, halfW, head, feet) {
    for (let pass = 0; pass < 3; pass += 1) {
      let left = x - halfW;
      let right = x + halfW;
      let hit = false;
      for (const w of walls) {
        if (w.kind === 'h') continue;
        if (!bodyOverlapsWallY(head, feet, w)) continue;
        if (right <= w.left || left >= w.right) continue;
        const mid = (w.left + w.right) * 0.5;
        if (x <= mid) x = w.left - halfW;
        else x = w.right + halfW;
        left = x - halfW;
        right = x + halfW;
        hit = true;
      }
      if (!hit) break;
    }
    return x;
  }

  /**
   * 头顶撞水平墙（顶板/走廊隔断）时压回脚下物理 Y，并清上跳速度。
   * @param {object[]} walls
   * @param {number} x
   * @param {number} halfW
   * @param {number} height
   * @param {number} floorY
   * @param {number} physicsY
   * @param {number} vy
   */
  function resolveWallsY(walls, x, halfW, height, floorY, physicsY, vy) {
    let feet = floorY + physicsY;
    let head = feet - height;
    const left = x - halfW;
    const right = x + halfW;
    for (const w of walls) {
      if (w.kind === 'v') continue;
      if (right <= w.left || left >= w.right) continue;
      if (head >= w.bottom || feet <= w.top) continue;
      if (head < w.bottom && feet > w.top) {
        const newHead = w.bottom;
        feet = newHead + height;
        physicsY = feet - floorY;
        if (vy < 0) vy = 0;
        head = newHead;
      }
    }
    return { physicsY, vy };
  }

  /**
   * 地牢实心墙碰撞：先 X 后顶板 Y（供主循环在位移后调用）。
   * @param {ReturnType<typeof generate>} dungeon
   * @param {{ x: number, physicsY: number, vy: number, floorY: number, halfW?: number, height?: number }} body
   */
  function resolveBody(dungeon, body) {
    const walls = dungeon?.walls;
    if (!walls?.length || !body) {
      return {
        x: body?.x ?? 0,
        physicsY: body?.physicsY ?? 0,
        vy: body?.vy ?? 0,
      };
    }
    const halfW = body.halfW ?? PLAYER_HALF_W;
    const height = body.height ?? PLAYER_BODY_H;
    const floorY = body.floorY;
    let x = body.x;
    let physicsY = body.physicsY;
    let vy = body.vy;
    let feet = floorY + physicsY;
    let head = feet - height;
    x = resolveWallsX(walls, x, halfW, head, feet);
    feet = floorY + physicsY;
    head = feet - height;
    const yOut = resolveWallsY(walls, x, halfW, height, floorY, physicsY, vy);
    return { x, physicsY: yOut.physicsY, vy: yOut.vy };
  }

  /**
   * 生成小型地牢布局：房间 AABB 互不贴边，仅走廊 / 楼梯廊连通。
   * @param {number} worldSeed
   * @param {number} stationIndex
   */
  function generate(worldSeed, stationIndex) {
    const sub = hash2(worldSeed, stationIndex);
    const rng = mulberry32(sub);
    const floorCount = 2 + Math.floor(rng() * 2); /* 2–3 */
    const rooms = [];
    const walks = [];
    const corridors = [];
    const stairs = [];
    const spawns = [];

    let maxRight = MARGIN;
    /** 下一层房间起点（层间串接，避免跨层房间 X 重叠）。 */
    let cursor = MARGIN + 40 + Math.floor(rng() * 60);
    const floorYs = [];
    for (let f = 0; f < floorCount; f += 1) {
      floorYs.push(BASE_FLOOR_Y - f * FLOOR_GAP);
    }

    /** @type {object[]|null} */
    let prevFloorRooms = null;

    for (let f = 0; f < floorCount; f += 1) {
      const floorY = floorYs[f];
      const floorRooms = [];

      /* 层间：仅楼梯廊连接上一层末房 → 本层首房 */
      if (f > 0 && prevFloorRooms?.length) {
        const lowerRoom = prevFloorRooms[prevFloorRooms.length - 1];
        lowerRoom.doorR = true;
        const lowerY = floorYs[f - 1];
        const upperY = floorY;
        const approachL = lowerRoom.right;
        const approachR = approachL + STAIR_LANDING;
        pushCorridor(
          walks,
          corridors,
          approachL,
          approachR,
          lowerY,
          f - 1,
          lowerRoom.id,
          null
        );
        const stairX0 = approachR;
        const stairX1 = buildStairs(walks, stairX0, lowerY, upperY);
        const landL = stairX1;
        const landR = landL + STAIR_LANDING;
        pushCorridor(walks, corridors, landL, landR, upperY, f, null, null);
        stairs.push({
          x0: stairX0,
          x1: stairX1,
          lowerY,
          upperY,
          floorFrom: f - 1,
          floorTo: f,
          fromRoomId: lowerRoom.id,
          toRoomId: null,
        });
        cursor = landR;
        maxRight = Math.max(maxRight, landR);
      }

      const roomN = 2 + Math.floor(rng() * 2);
      for (let r = 0; r < roomN; r += 1) {
        if (r > 0) {
          const gap = CORRIDOR_GAP_MIN + Math.floor(rng() * CORRIDOR_GAP_SPAN);
          const corrL = cursor;
          const corrR = cursor + gap;
          floorRooms[r - 1].doorR = true;
          pushCorridor(
            walks,
            corridors,
            corrL,
            corrR,
            floorY,
            f,
            floorRooms[r - 1].id,
            null
          );
          cursor = corrR;
        }
        const w = ROOM_W_MIN + Math.floor(rng() * ROOM_W_SPAN);
        const left = cursor;
        const right = left + w;
        const room = {
          id: `r${f}-${r}`,
          type: 'enemy',
          floor: f,
          left,
          right,
          floorY,
          ceilingY: floorY - ROOM_H,
          doorL: r > 0 || f > 0,
          doorR: false,
        };
        rooms.push(room);
        floorRooms.push(room);
        if (r > 0) {
          corridors[corridors.length - 1].toRoomId = room.id;
        }
        if (f > 0 && r === 0) {
          /* 回填楼梯廊两端：下层接近廊 + 上层落脚廊 + stairs.toRoomId */
          const landCorr = corridors[corridors.length - 1];
          const approachCorr = corridors[corridors.length - 2];
          landCorr.fromRoomId = approachCorr.fromRoomId;
          landCorr.toRoomId = room.id;
          approachCorr.toRoomId = room.id;
          stairs[stairs.length - 1].toRoomId = room.id;
        }
        pushWalk(walks, left, right, floorY);
        cursor = right;
        maxRight = Math.max(maxRight, right);
      }

      prevFloorRooms = floorRooms;
    }

    warnIfRoomsNotIsolated(rooms);

    const walls = buildWalls(rooms, corridors);

    /* 分配房间类型：1 安全屋、≥1 仓库、其余敌人 */
    const order = rooms.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    const safeIdx = order[0];
    const whIdx = order[1] != null ? order[1] : order[0];
    rooms[safeIdx].type = 'safehouse';
    rooms[whIdx].type = 'warehouse';
    for (let i = 0; i < rooms.length; i += 1) {
      if (rooms[i].type === 'enemy') {
        const n = 1 + Math.floor(rng() * 3);
        const pad = WALL_THICK + 40; /* 避开侧墙厚度 + 怪半径余量 */
        const innerL = rooms[i].left + pad;
        const innerR = rooms[i].right - pad;
        for (let s = 0; s < n; s += 1) {
          const t = (s + 1) / (n + 1);
          let x = rooms[i].left + (rooms[i].right - rooms[i].left) * t;
          if (innerR > innerL) {
            x = Math.min(innerR, Math.max(innerL, x));
          }
          /* 气球约 35%；保龄球其余 — 对齐压力表 balloon+3 / bowling+7 */
          const species = rng() < 0.35 ? 'balloon' : 'bowling';
          spawns.push({
            x,
            floorY: rooms[i].floorY,
            ceilingY: rooms[i].ceilingY,
            roomId: rooms[i].id,
            species,
          });
        }
      }
    }

    const safe = rooms[safeIdx];
    const warehouse = rooms[whIdx];
    const spawnX = (safe.left + safe.right) * 0.5;
    const boardX = safe.left + 70;
    /* 安全屋右侧：连通列车仓储车厢（与回车点错开） */
    const vehicleStorageX = Math.max(boardX + 170, safe.right - 90);
    const warehouseX = (warehouse.left + warehouse.right) * 0.5;

    const width = Math.max(1200, maxRight + MARGIN);
    const height = BASE_FLOOR_Y + 180;
    const topY = floorYs[floorYs.length - 1] - ROOM_H - 40;

    return {
      kind: 'small',
      seed: sub,
      stationIndex: stationIndex | 0,
      width,
      height,
      topY,
      baseFloorY: BASE_FLOOR_Y,
      floors: floorYs,
      rooms,
      corridors,
      walls,
      stairs,
      walks,
      spawns,
      spawnX,
      spawnFloorY: safe.floorY,
      spots: [
        {
          id: 'platform-board',
          action: 'boardTrain',
          actionLabel: '返回列车',
          worldX: boardX,
          interactRadiusX: 110,
          rect: {
            x: boardX - 70,
            y: safe.floorY - 160,
            w: 140,
            h: 160,
          },
        },
        {
          id: 'platform-vehicle-storage',
          action: 'openVehicleStorage',
          actionLabel: '打开车辆仓库',
          worldX: vehicleStorageX,
          interactRadiusX: 120,
          rect: {
            x: vehicleStorageX - 80,
            y: safe.floorY - 140,
            w: 160,
            h: 140,
          },
        },
        {
          id: 'platform-dungeon-warehouse',
          action: 'openPlatformStorage',
          actionLabel: '打开地牢仓库',
          worldX: warehouseX,
          interactRadiusX: 120,
          rect: {
            x: warehouseX - 80,
            y: warehouse.floorY - 140,
            w: 160,
            h: 140,
          },
        },
      ],
      bounds: {
        left: MARGIN + 20,
        right: width - MARGIN - 20,
        floorY: BASE_FLOOR_Y,
      },
    };
  }

  /**
   * 查询 x 处可走平台顶（Y 越小越高）。
   * 有 preferY 时取距该 Y 最近的平台（楼梯廊多段叠 x）；否则取最高。
   * @param {ReturnType<typeof generate>} dungeon
   * @param {number} x
   * @param {number} [preferY]
   */
  function floorAt(dungeon, x, preferY) {
    if (!dungeon?.walks?.length) return null;
    let best = null;
    let bestDist = Infinity;
    const prefer = Number.isFinite(preferY) ? preferY : null;
    for (const p of dungeon.walks) {
      if (x < p.left || x > p.right) continue;
      if (prefer === null) {
        if (best === null || p.y < best) best = p.y;
        continue;
      }
      const d = Math.abs(p.y - prefer);
      if (d < bestDist) {
        bestDist = d;
        best = p.y;
      }
    }
    return best;
  }

  /**
   * 绘制地牢占位几何（房间壳 / 走廊隧道 / 实心墙 / 地板）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof generate>} dungeon
   * @param {number} exitCouplerIndex
   */
  function draw(ctx, dungeon, exitCouplerIndex) {
    if (!dungeon) return;
    ctx.fillStyle = '#12161e';
    ctx.fillRect(0, dungeon.topY - 40, dungeon.width, dungeon.height - dungeon.topY + 80);

    const typeColor = {
      safehouse: '#7dd3a0',
      enemy: '#c47a7a',
      warehouse: '#7aa3c4',
    };

    const Fow = window.LpDungeonFow;

    /* 走廊隧道内腔（墙体之下的可走空洞） */
    for (const c of dungeon.corridors || []) {
      const corrKnown = !Fow || Fow.isCorridorVisible?.(c);
      const h = c.height || CORRIDOR_H;
      ctx.fillStyle = corrKnown ? '#252a36' : '#181b22';
      ctx.fillRect(c.left, c.y - h, c.right - c.left, h);
    }

    for (const room of dungeon.rooms) {
      const known = !Fow || Fow.isRoomExplored?.(room.id);
      const inset = WALL_THICK;
      const ix = room.left + inset;
      const iy = room.ceilingY + inset;
      const iw = Math.max(0, room.right - room.left - inset * 2);
      const ih = Math.max(0, ROOM_H - inset);
      if (known) {
        ctx.fillStyle = typeColor[room.type] || '#888';
        ctx.globalAlpha = 0.22;
        ctx.fillRect(ix, iy, iw, ih);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = '#1a1e28';
        ctx.globalAlpha = 0.35;
        ctx.fillRect(ix, iy, iw, ih);
        ctx.globalAlpha = 1;
      }
      if (known) {
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label =
          room.type === 'safehouse' ? '安全屋' : room.type === 'warehouse' ? '仓库' : '敌区';
        ctx.fillText(label, (room.left + room.right) / 2, room.ceilingY + 28);
      }
    }

    /* 实心墙：房间隔断 + 门楣 + 走廊上填 */
    for (const w of dungeon.walls || []) {
      const midX = (w.left + w.right) * 0.5;
      const midY = (w.top + w.bottom) * 0.5;
      const floorGuess =
        dungeon.floors?.reduce?.(
          (best, fy) => (Math.abs(fy - midY) < Math.abs(best - midY) ? fy : best),
          dungeon.floors[0]
        ) ?? midY;
      const nearRoom = Fow?.roomAt?.(dungeon, midX, floorGuess);
      let wallKnown = !Fow;
      if (Fow) {
        if (nearRoom && Fow.isRoomExplored?.(nearRoom.id)) wallKnown = true;
        else {
          for (const c of dungeon.corridors || []) {
            if (midX < c.left - 2 || midX > c.right + 2) continue;
            if (Fow.isCorridorVisible?.(c)) {
              wallKnown = true;
              break;
            }
          }
        }
      }
      ctx.fillStyle = wallKnown ? '#3d4556' : '#22262f';
      ctx.fillRect(w.left, w.top, w.right - w.left, w.bottom - w.top);
      if (wallKnown) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(w.left, w.top, w.right - w.left, Math.min(4, w.bottom - w.top));
      }
    }

    /* 楼梯廊：竖向色带，与房间体积分离 */
    for (const s of dungeon.stairs || []) {
      const stairKnown = !Fow || Fow.isStairVisible?.(s);
      const x0 = Math.min(s.x0, s.x1);
      const x1 = Math.max(s.x0, s.x1);
      const y0 = Math.min(s.lowerY, s.upperY);
      const y1 = Math.max(s.lowerY, s.upperY);
      ctx.fillStyle = stairKnown ? 'rgba(90,100,120,0.35)' : 'rgba(30,34,42,0.4)';
      ctx.fillRect(x0, y0, Math.max(12, x1 - x0), y1 - y0);
    }

    for (const p of dungeon.walks) {
      ctx.fillStyle = '#9ca3af';
      ctx.fillRect(p.left, p.y - 6, p.right - p.left, 14);
    }

    for (const spot of dungeon.spots) {
      const r = spot.rect;
      const spotFloor = r.y + r.h;
      const spotRoom = Fow?.roomAt?.(dungeon, spot.worldX, spotFloor);
      const spotKnown = !Fow || !spotRoom || Fow.isRoomExplored?.(spotRoom.id);
      if (!spotKnown) continue;
      ctx.fillStyle =
        spot.action === 'openVehicleStorage'
          ? '#86efac'
          : spot.action === 'openPlatformStorage'
            ? '#93c5fd'
            : '#d4d4d4';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(30,30,30,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#222';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const spotLabel =
        spot.action === 'boardTrain'
          ? '回车'
          : spot.action === 'openVehicleStorage'
            ? '仓储'
            : '地牢仓';
      ctx.fillText(spotLabel, r.x + r.w / 2, r.y + r.h / 2);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '18px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('小型月台 · 地牢', 100, dungeon.topY);
    ctx.font = '13px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`回车连接处 #${(exitCouplerIndex | 0) + 1}`, 100, dungeon.topY + 26);
  }

  window.LpDungeon = {
    mulberry32,
    hash2,
    resolveKind,
    generate,
    floorAt,
    draw,
    resolveBody,
    platformLootStacks,
    fillPlatformInventory,
    PLATFORM_LOOT_TABLE,
    BASE_FLOOR_Y,
    ROOM_H,
    CORRIDOR_H,
    DOOR_H,
    WALL_THICK,
    CAR_WALK_W,
    CAR_CABIN_H,
    MAX_WIDTH,
  };
})();
