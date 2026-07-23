/**
 * 车厢可交互节点规格（与贴图对齐，同一车厢可挂多个）。
 * 动力车：燃烧室 / 引擎控制台；卫兵车：炮塔 / 弹药箱 / 回收箱。
 * centerX / promptAnchorY 为贴图像素，构建时经 Spec.scaleArt 进世界。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;

  /** 节点表：carId + 车厢内 centerX（贴图像素）。 */
  const INTERACT_SPOTS = [
    {
      id: 'power-firebox',
      carId: 'power',
      label: '燃烧室',
      centerX: 886,
      promptAnchorY: 817,
      interactRadiusX: 120,
      action: 'addFuel',
      actionLabel: '添加燃料',
    },
    {
      id: 'power-controls',
      carId: 'power',
      label: '引擎控制',
      centerX: 1353,
      promptAnchorY: 800,
      interactRadiusX: 140,
      action: 'openDrivePanel',
      actionLabel: '打开驾驶台',
    },
    {
      id: 'guard-turret-left',
      carId: 'guard',
      label: '左侧炮塔',
      centerX: 517,
      promptAnchorY: 780,
      interactRadiusX: 130,
      action: 'enterTurretLeft',
      actionLabel: '进入左侧炮塔',
    },
    {
      id: 'guard-turret-right',
      carId: 'guard',
      label: '右侧炮塔',
      centerX: 1728,
      promptAnchorY: 780,
      interactRadiusX: 130,
      action: 'enterTurretRight',
      actionLabel: '进入右侧炮塔',
    },
    {
      id: 'guard-ammo',
      carId: 'guard',
      label: '弹药箱',
      centerX: 965,
      promptAnchorY: 860,
      interactRadiusX: 100,
      action: 'guardAmmo',
      actionLabel: '存取弹药',
    },
    {
      id: 'guard-recycle',
      carId: 'guard',
      label: '回收箱',
      centerX: 1316,
      promptAnchorY: 880,
      interactRadiusX: 90,
      action: 'guardRecycle',
      actionLabel: '存取弹壳',
    },
  ];

  /** 返回带世界坐标的交互点列表。 */
  function buildInteractables() {
    const scale = Spec.scaleArt || ((v) => v);
    const carById = Object.fromEntries(Spec.CARRIAGES.map((car) => [car.id, car]));
    return INTERACT_SPOTS.map((spot) => {
      const car = carById[spot.carId];
      return {
        ...spot,
        centerX: scale(spot.centerX),
        promptAnchorY: scale(spot.promptAnchorY),
        interactRadiusX: scale(spot.interactRadiusX),
        worldX: (car?.worldX ?? 0) + scale(spot.centerX),
      };
    });
  }

  window.LiminalInteractSpec = {
    INTERACT_SPOTS,
    buildInteractables,
  };
})();
