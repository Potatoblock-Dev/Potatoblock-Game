/**
 * 车厢模块规格（与 Krita 工程 trains.kra 对齐：2250×1688 @96ppi）。
 * 07_gameplay 层走线若调整，同步改 ART_*；WORLD_SCALE 只调人车观感比例。
 *
 * 世界约定：屏幕右侧为列车前进方向（世界 +X）；
 * 编组（左→右 = 车尾→车头前进方向）：
 * 卫兵防御 → 仓储 → 动力 → 绘轨 → 枢机
 * （绘轨接在车头/动力前，枢机接在绘轨前；译名取自 成品/车厢 文件名。）
 */
(() => {
  const ART_MODULE_W = 2250;
  const ART_MODULE_H = 1688;
  /** 主走道顶边 Y（源图像素）：红色底盘顶面，脚底落在此线。 */
  const ART_FLOOR_Y = 972;
  /**
   * 车厢底盘下表面 Y（源图像素；贴图不透明底边众数 ≈1023）。
   * 弹道命中此水平面 → 车底尘土 FX。
   */
  const ART_UNDERSIDE_Y = 1023;
  /**
   * 轨道 / 轨道路基虚拟地面 Y（源图像素；贴图轮缘约至 1058，略下为逻辑轨面）。
   * 弹道命中此水平面 → 地面尘土 FX。
   */
  const ART_TRACK_Y = 1100;
  /** 单节车厢内可行走水平范围（含 chassis 顶边，不含外侧链钩）。 */
  const ART_WALK_LEFT = 456;
  const ART_WALK_RIGHT = 1793;
  /**
   * 相邻车厢 worldX 间距：前车右钩尖与后车左钩尖对接。
   * 成品贴图测得：动力/卫兵防御右 tip≈1898，仓储左 tip≈372 → 1526。
   */
  const ART_COUPLER_JOIN = 1526;

  /**
   * 世界相对贴图的缩放：略缩小车厢，使人相对更大、比例更自然。
   * 联机 multiplayer.py 须使用同一 WORLD_SCALE。
   */
  const WORLD_SCALE = 0.88;
  /** 列车前进方向（屏幕右 = 世界 +X）。节流正档、正速度均沿此方向。 */
  const TRAIN_FORWARD_X = 1;
  /** 本地 / 联机开局默认出生车厢。 */
  const DEFAULT_SPAWN_CAR_ID = 'power';

  /** 贴图像素 → 世界坐标。 */
  function scaleArt(value) {
    return value * WORLD_SCALE;
  }

  const MODULE_W = scaleArt(ART_MODULE_W);
  const MODULE_H = scaleArt(ART_MODULE_H);
  const FLOOR_Y = scaleArt(ART_FLOOR_Y);
  const UNDERSIDE_Y = scaleArt(ART_UNDERSIDE_Y);
  const TRACK_Y = scaleArt(ART_TRACK_Y);
  const WALK_LEFT = scaleArt(ART_WALK_LEFT);
  const WALK_RIGHT = scaleArt(ART_WALK_RIGHT);
  const COUPLER_JOIN_OFFSET = scaleArt(ART_COUPLER_JOIN);

  const CARRIAGES = [
    {
      id: 'guard',
      label: '卫兵防御车厢',
      image: '/static/games/liminal-platform/img/cars/guard-car.png?v=3',
      icon: '/static/games/liminal-platform/img/cars/guard-car-icon.png?v=1',
      worldX: 0,
      map: {
        shortLabel: '卫兵',
        kind: 'defense',
        tone: '#b91c1c',
      },
    },
    {
      id: 'storage',
      label: '仓储车厢',
      image: '/static/games/liminal-platform/img/cars/storage-car.png?v=4',
      icon: '/static/games/liminal-platform/img/cars/storage-car-icon.png?v=1',
      worldX: COUPLER_JOIN_OFFSET,
      map: {
        shortLabel: '仓储',
        kind: 'cargo',
        tone: '#64748b',
      },
    },
    {
      id: 'power',
      label: '动力车厢',
      image: '/static/games/liminal-platform/img/cars/power-car.png?v=4',
      icon: '/static/games/liminal-platform/img/cars/power-car-icon.png?v=1',
      worldX: COUPLER_JOIN_OFFSET * 2,
      map: {
        shortLabel: '动力',
        kind: 'engine',
        tone: '#d97706',
      },
    },
    {
      id: 'huigui',
      label: '绘轨车厢',
      image: '/static/games/liminal-platform/img/cars/huigui-car.png?v=1',
      icon: '/static/games/liminal-platform/img/cars/huigui-car-icon.png?v=1',
      worldX: COUPLER_JOIN_OFFSET * 3,
      map: {
        shortLabel: '绘轨',
        kind: 'sensor',
        tone: '#0f766e',
      },
    },
    {
      id: 'shuji',
      label: '枢机车厢',
      image: '/static/games/liminal-platform/img/cars/shuji-car.png?v=1',
      icon: '/static/games/liminal-platform/img/cars/shuji-car-icon.png?v=1',
      worldX: COUPLER_JOIN_OFFSET * 4,
      map: {
        shortLabel: '枢机',
        kind: 'compute',
        tone: '#6366f1',
      },
    },
  ];

  /**
   * 规范化单节车厢的小地图条目（缺省字段可补）。
   * 未来自定义车厢只需在 CARRIAGES 填 map，或在此兜底。
   */
  function mapEntryFor(car) {
    const map = car?.map || {};
    return {
      id: car.id,
      label: car.label || car.id,
      shortLabel: map.shortLabel || car.label || car.id,
      kind: map.kind || 'default',
      tone: map.tone || null,
      icon: car.icon || map.icon || null,
      worldX: car.worldX,
    };
  }

  /** 按编组顺序返回小地图条目（世界 +X = 列车前进 = 列表从左到右）。 */
  function listMapEntries() {
    return CARRIAGES.map(mapEntryFor);
  }

  /** 按 id 查找车厢。 */
  function carriageById(carId) {
    return CARRIAGES.find((car) => car.id === carId) || null;
  }

  /** 开局出生世界 X（默认动力车厢走道中心）。 */
  function defaultSpawnX(carId = DEFAULT_SPAWN_CAR_ID) {
    const car =
      carriageById(carId) ||
      carriageById(DEFAULT_SPAWN_CAR_ID) ||
      CARRIAGES[CARRIAGES.length - 1];
    return car.worldX + (WALK_LEFT + WALK_RIGHT) / 2;
  }

  /** 返回世界坐标下的走道平台段（含节间连廊）。 */
  function buildWalkPlatforms() {
    const floors = CARRIAGES.map((car) => ({
      id: `${car.id}-floor`,
      left: car.worldX + WALK_LEFT,
      right: car.worldX + WALK_RIGHT,
      y: FLOOR_Y,
    }));

    const platforms = [];
    for (let i = 0; i < floors.length; i += 1) {
      if (i > 0) {
        const prev = floors[i - 1];
        const cur = floors[i];
        if (cur.left > prev.right) {
          platforms.push({
            id: `gangway-${i}`,
            left: prev.right,
            right: cur.left,
            y: FLOOR_Y,
          });
        }
      }
      platforms.push(floors[i]);
    }

    return platforms;
  }

  /** 根据世界 X 判定玩家所在车厢（不含节间连廊）。 */
  function carriageAt(worldX) {
    for (const car of CARRIAGES) {
      const left = car.worldX + WALK_LEFT;
      const right = car.worldX + WALK_RIGHT;
      if (worldX >= left && worldX <= right) return car;
    }
    return null;
  }

  /**
   * 线段与水平面相交：若本帧跨越 planeY 且命中 x 落在 [xMin,xMax]，写入候选（取更近的 t）。
   */
  function considerPlaneHit(best, x0, y0, dx, dy, planeY, surface, xMin, xMax) {
    if (Math.abs(dy) < 1e-8) return best;
    if ((y0 - planeY) * (y0 + dy - planeY) > 0) return best;
    const t = (planeY - y0) / dy;
    if (t < 0 || t > 1) return best;
    const hx = x0 + t * dx;
    if (hx < xMin || hx > xMax) return best;
    if (best && t >= best.t) return best;
    return { t, x: hx, y: planeY, surface };
  }

  /**
   * 弹道本帧线段相对车底 / 轨道地面的最早命中点（世界坐标）。
   * 无命中返回 null；surface 为 'underside' | 'ground'。
   */
  function hitProjectileSurfaces(x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    let best = null;
    for (const car of CARRIAGES) {
      best = considerPlaneHit(
        best,
        x0,
        y0,
        dx,
        dy,
        UNDERSIDE_Y,
        'underside',
        car.worldX + WALK_LEFT,
        car.worldX + WALK_RIGHT
      );
    }
    const trackLeft = CARRIAGES[0].worldX - scaleArt(80);
    const trackRight =
      CARRIAGES[CARRIAGES.length - 1].worldX + MODULE_W + scaleArt(80);
    best = considerPlaneHit(
      best,
      x0,
      y0,
      dx,
      dy,
      TRACK_Y,
      'ground',
      trackLeft,
      trackRight
    );
    if (!best) return null;
    return { surface: best.surface, x: best.x, y: best.y };
  }

  window.LiminalCarriageSpec = {
    WORLD_SCALE,
    TRAIN_FORWARD_X,
    DEFAULT_SPAWN_CAR_ID,
    scaleArt,
    MODULE_W,
    MODULE_H,
    FLOOR_Y,
    UNDERSIDE_Y,
    TRACK_Y,
    WALK_LEFT,
    WALK_RIGHT,
    COUPLER_JOIN_OFFSET,
    CARRIAGES,
    mapEntryFor,
    listMapEntries,
    carriageById,
    defaultSpawnX,
    buildWalkPlatforms,
    carriageAt,
    hitProjectileSurfaces,
  };
})();
