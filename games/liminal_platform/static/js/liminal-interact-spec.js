/**
 * 车厢可交互节点规格（与贴图对齐，同一车厢可挂多个）。
 * 动力车：燃烧室≈(881) 加燃料；引擎控制台≈(1448) 开车。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;

  /** 节点表：carId + 车厢内 centerX → 世界坐标。 */
  const INTERACT_SPOTS = [
    {
      id: 'power-firebox',
      carId: 'power',
      label: '燃烧室',
      centerX: 881,
      promptAnchorY: 820,
      interactRadiusX: 110,
      action: 'addFuel',
      actionLabel: '添加燃料',
    },
    {
      id: 'power-controls',
      carId: 'power',
      label: '引擎控制',
      centerX: 1448,
      promptAnchorY: 800,
      interactRadiusX: 140,
      action: 'openDrivePanel',
      actionLabel: '打开控制台',
    },
  ];

  /** 返回带世界坐标的交互点列表。 */
  function buildInteractables() {
    const carById = Object.fromEntries(Spec.CARRIAGES.map((car) => [car.id, car]));
    return INTERACT_SPOTS.map((spot) => {
      const car = carById[spot.carId];
      return {
        ...spot,
        worldX: (car?.worldX ?? 0) + spot.centerX,
      };
    });
  }

  window.LiminalInteractSpec = {
    INTERACT_SPOTS,
    buildInteractables,
  };
})();
