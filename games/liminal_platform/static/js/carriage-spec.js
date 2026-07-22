/**
 * 车厢模块规格（与 Krita 工程 trains.kra 对齐：2250×1688 @96ppi）。
 * 07_gameplay 层走线若调整，同步改这里的 walk 区间。
 */
(() => {
  const MODULE_W = 2250;
  const MODULE_H = 1688;

  /** 主走道顶边 Y（源图像素，脚落在此线）。 */
  const FLOOR_Y = 979;

  /** 单节车厢内可行走水平范围（含 chassis 顶边，不含外侧链钩）。 */
  const WALK_LEFT = 456;
  const WALK_RIGHT = 1793;

  /**
   * 第二节车厢 worldX：使动力车右钩尖与仓储车左钩尖对接。
   * 由贴图测得：power tip≈1882，storage tip≈366 → 1882−366=1516。
   */
  const COUPLER_JOIN_OFFSET = 1516;

  const CARRIAGES = [
    {
      id: 'power',
      label: '动力车厢',
      image: '/static/games/liminal-platform/img/power-car.png',
      worldX: 0,
    },
    {
      id: 'storage',
      label: '仓储车厢',
      image: '/static/games/liminal-platform/img/storage-car.png',
      worldX: COUPLER_JOIN_OFFSET,
    },
  ];

  /** 返回世界坐标下的走道平台段（含节间连廊）。 */
  function buildWalkPlatforms() {
    const platforms = CARRIAGES.map((car) => ({
      id: `${car.id}-floor`,
      left: car.worldX + WALK_LEFT,
      right: car.worldX + WALK_RIGHT,
      y: FLOOR_Y,
    }));

    const first = platforms[0];
    const second = platforms[1];
    if (first && second && second.left > first.right) {
      platforms.splice(1, 0, {
        id: 'gangway',
        left: first.right,
        right: second.left,
        y: FLOOR_Y,
      });
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
