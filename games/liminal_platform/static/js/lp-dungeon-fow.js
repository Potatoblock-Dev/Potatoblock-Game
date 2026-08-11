/**
 * 小型月台地牢战争迷雾：本机/队友进入过的房间可见，
 * 与已探索房间相连的走廊（及楼梯）自动可见。
 */
(() => {
  /** 判定站在房间内的楼层容差（世界 Y）。 */
  const FLOOR_SLACK = 48;

  /** @type {Set<string>} */
  let explored = new Set();
  /** 探索集代数：新增房间时递增，供小地图静态层 dirty 检测。 */
  let exploredGen = 0;
  /** 当前访问键：seed-station；换站/离台时重置。 */
  let visitKey = null;
  /** @type {ReturnType<typeof window.LpDungeon.generate>|null} */
  let boundDungeon = null;

  /** 生成当前地牢访问键。 */
  function makeVisitKey(dungeon) {
    if (!dungeon) return null;
    return `${dungeon.seed ?? ''}:${dungeon.stationIndex ?? ''}`;
  }

  /**
   * 清空探索状态（换站或离开月台）。
   */
  function reset() {
    explored = new Set();
    exploredGen += 1;
    visitKey = null;
    boundDungeon = null;
  }

  /**
   * 绑定地牢实例并在需要时重置探索集。
   * @param {object|null|undefined} dungeon
   */
  function bindDungeon(dungeon) {
    if (!dungeon || dungeon.kind !== 'small') {
      reset();
      return;
    }
    const key = makeVisitKey(dungeon);
    if (key !== visitKey || boundDungeon !== dungeon) {
      explored = new Set();
      exploredGen += 1;
      visitKey = key;
      boundDungeon = dungeon;
      /* 出生点安全屋：进站即有视野 */
      const spawnRoom = roomAt(dungeon, dungeon.spawnX, dungeon.spawnFloorY);
      if (spawnRoom) explored.add(spawnRoom.id);
      for (const room of dungeon.rooms || []) {
        if (room.type === 'safehouse') explored.add(room.id);
      }
    }
  }

  /**
   * 查询 (x, floorY) 落在哪个房间内；走廊/楼梯返回 null。
   * @param {object} dungeon
   * @param {number} x
   * @param {number} floorY
   * @returns {object|null}
   */
  function roomAt(dungeon, x, floorY) {
    if (!dungeon?.rooms || !Number.isFinite(x) || !Number.isFinite(floorY)) {
      return null;
    }
    for (const room of dungeon.rooms) {
      if (x < room.left || x > room.right) continue;
      if (Math.abs(floorY - room.floorY) > FLOOR_SLACK) continue;
      return room;
    }
    return null;
  }

  /**
   * 标记某坐标所在房间为已探索。
   * @param {object} dungeon
   * @param {number} x
   * @param {number} floorY
   */
  function markPosition(dungeon, x, floorY) {
    const room = roomAt(dungeon, x, floorY);
    if (!room) return;
    const id = String(room.id);
    if (explored.has(id)) return;
    explored.add(id);
    exploredGen += 1;
  }

  /**
   * 房间是否已探索（本机或队友曾进入）。
   * @param {string} roomId
   */
  function isRoomExplored(roomId) {
    return Boolean(roomId) && explored.has(String(roomId));
  }

  /**
   * 走廊是否可见：任一端房间已探索。
   * @param {object} corridor
   */
  function isCorridorVisible(corridor) {
    if (!corridor) return false;
    if (corridor.fromRoomId && explored.has(corridor.fromRoomId)) return true;
    if (corridor.toRoomId && explored.has(corridor.toRoomId)) return true;
    /* 旧布局无 id 时：几何贴边回退 */
    const dungeon = boundDungeon;
    if (!dungeon?.rooms) return false;
    const eps = 4;
    for (const room of dungeon.rooms) {
      if (!explored.has(room.id)) continue;
      if (Math.abs(corridor.y - room.floorY) > 2) continue;
      if (
        Math.abs(corridor.left - room.right) <= eps ||
        Math.abs(corridor.right - room.left) <= eps
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 楼梯是否可见：连接的任一侧房间已探索。
   * @param {object} stair
   */
  function isStairVisible(stair) {
    if (!stair) return false;
    if (stair.fromRoomId && explored.has(stair.fromRoomId)) return true;
    if (stair.toRoomId && explored.has(stair.toRoomId)) return true;
    const dungeon = boundDungeon;
    if (!dungeon?.rooms) return false;
    const midX = ((stair.x0 || 0) + (stair.x1 || 0)) * 0.5;
    const margin = 120;
    for (const room of dungeon.rooms) {
      if (!explored.has(room.id)) continue;
      if (room.floor !== stair.floorFrom && room.floor !== stair.floorTo) continue;
      if (midX >= room.left - margin && midX <= room.right + margin) return true;
    }
    return false;
  }

  /**
   * 世界点是否在已探索视野内（房间 / 可见走廊 / 可见楼梯）。
   * @param {number} x
   * @param {number} floorY
   */
  function isWorldPosVisible(x, floorY) {
    const dungeon = boundDungeon;
    if (!dungeon || !Number.isFinite(x) || !Number.isFinite(floorY)) return false;
    const room = roomAt(dungeon, x, floorY);
    if (room) return explored.has(room.id);
    for (const c of dungeon.corridors || []) {
      if (!isCorridorVisible(c)) continue;
      if (x >= c.left && x <= c.right && Math.abs(floorY - c.y) <= FLOOR_SLACK) {
        return true;
      }
    }
    for (const s of dungeon.stairs || []) {
      if (!isStairVisible(s)) continue;
      const x0 = Math.min(s.x0, s.x1) - 20;
      const x1 = Math.max(s.x0, s.x1) + 20;
      if (x < x0 || x > x1) continue;
      const lo = Math.min(s.lowerY, s.upperY) - FLOOR_SLACK;
      const hi = Math.max(s.lowerY, s.upperY) + FLOOR_SLACK;
      if (floorY >= lo && floorY <= hi) return true;
    }
    return false;
  }

  /**
   * 返回当前可见结构掩码（小地图 / HUD 用）。
   * @returns {{ roomIds: string[], corridors: object[], stairs: object[] }}
   */
  function getVisibleDungeonMask() {
    const dungeon = boundDungeon;
    const roomIds = [...explored];
    if (!dungeon) {
      return { roomIds, corridors: [], stairs: [] };
    }
    return {
      roomIds,
      corridors: (dungeon.corridors || []).filter(isCorridorVisible),
      stairs: (dungeon.stairs || []).filter(isStairVisible),
    };
  }

  /**
   * 每帧：绑定地牢并据本机/队友站位扩展探索。
   */
  function tick() {
    const scene = window.LpPlatform?.getScene?.();
    const dungeon = window.LpPlatform?.getDungeon?.();
    if (scene !== 'platform' || !dungeon || dungeon.kind !== 'small') {
      if (visitKey != null) reset();
      return;
    }
    bindDungeon(dungeon);

    const localX = window.LpGame?.getLocalX?.();
    if (Number.isFinite(localX)) {
      const floorY =
        window.LpPlatform?.platformFloorAt?.(localX) ??
        dungeon.spawnFloorY ??
        dungeon.bounds?.floorY;
      markPosition(dungeon, localX, floorY);
    }

    /* 队友：姿态已同步；只读推算楼层（remember:false，勿污染本机层记忆） */
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
          dungeon.bounds?.floorY;
        markPosition(dungeon, rx, floorY);
      }
    }
  }

  /**
   * 响应月台场景切换：进小型地牢则绑定；离台则清空。
   * @param {CustomEvent} ev
   */
  function onPlatformScene(ev) {
    const detail = ev?.detail || {};
    if (detail.scene === 'platform' && detail.kind === 'small') {
      const dungeon = window.LpPlatform?.getDungeon?.();
      bindDungeon(dungeon);
      return;
    }
    reset();
  }

  window.addEventListener('liminal:platform-scene', onPlatformScene);

  window.LpDungeonFow = {
    tick,
    reset,
    bindDungeon,
    roomAt,
    markPosition,
    isRoomExplored,
    isCorridorVisible,
    isStairVisible,
    isWorldPosVisible,
    getVisibleDungeonMask,
    getExploredRoomIds: () => [...explored],
    /** 探索集版本号（小地图静态层 dirty）。 */
    getExploredGen: () => exploredGen,
  };
})();
