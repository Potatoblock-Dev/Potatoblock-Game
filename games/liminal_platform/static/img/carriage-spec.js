/**
 * 车厢模块规格（与 Krita 工程 trains.kra 对齐：2250×1688 @96ppi）。
 * 07_gameplay 层走线若调整，同步改 ART_*；WORLD_SCALE 只调人车观感比例。
 *
 * 世界约定：屏幕右侧为列车前进方向（世界 +X）；
 * 编组：动力 → 仓储 → 卫兵防御（均按同一挂钩间距对接）。
 */
(() => {
  const ART_MODULE_W = 2250;
  const ART_MODULE_H = 1688;
  /** 主走道顶边 Y（源图像素）：红色底盘顶面，脚底落在此线。 */
  const ART_FLOOR_Y = 972;
  /** 单节车厢内可行走水平范围（含 chassis 顶边，不含外侧链钩）。 */
  const ART_WALK_LEFT = 456;
  const ART_WALK_RIGHT = 1793;
  /**
   * 相邻车厢 worldX 间距：前车右钩尖与后车左钩尖对接。
   * 成品贴图测得：动力/卫兵右 tip≈1898，仓储左 tip≈372 → 1526。
   */
  const ART_COUPLER_JOIN = 1526;

  /**
   * 世界相对贴图的缩放：略缩小车厢，使人相对更大、比例更自然。
   * 联机 multiplayer.py 须使用同一 WORLD_SCALE。
   */
  const WORLD_SCALE = 0.88;
  /** 列车前进方向（屏幕右 = 世界 +X）。节流正档、正速度均沿此方向。 */
  const TRAIN_FORWARD_X = 1;

  /** 贴图像素 → 世界坐标。 */
  function scaleArt(value) {
    return value * WORLD_SCALE;
  }

  const MODULE_W = scaleArt(ART_MODULE_W);
  const MODULE_H = scaleArt(ART_MODULE_H);
  const FLOOR_Y = scaleArt(ART_FLOOR_Y);
  const WALK_LEFT = scaleArt(ART_WALK_LEFT);
  const WALK_RIGHT = scaleArt(ART_WALK_RIGHT);
  const COUPLER_JOIN_OFFSET = scaleArt(ART_COUPLER_JOIN);

  const CARRIAGES = [
    {
      id: 'power',
      label: '动力车厢',
      image: '/static/games/liminal-platform/img/power-car.png?v=3',
      worldX: 0,
    },
    {
      id: 'storage',
      label: '仓储车厢',
      image: '/static/games/liminal-platform/img/storage-car.png?v=3',
      worldX: COUPLER_JOIN_OFFSET,
    },
    {
      id: 'guard',
      label: '卫兵防御车厢',
      image: '/static/games/liminal-platform/img/guard-car.png?v=2',
      worldX: COUPLER_JOIN_OFFSET * 2,
    },
  ];

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

  window.LiminalCarriageSpec = {
    WORLD_SCALE,
    TRAIN_FORWARD_X,
    scaleArt,
    MODULE_W,
    MODULE_H,
    FLOOR_Y,
    WALK_LEFT,
    WALK_RIGHT,
    COUPLER_JOIN_OFFSET,
    CARRIAGES,
    buildWalkPlatforms,
    carriageAt,
  };
})();
