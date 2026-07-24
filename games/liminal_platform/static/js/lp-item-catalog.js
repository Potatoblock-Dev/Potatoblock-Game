/**
 * 阈限月台物品目录（占位图标用色块 + 缩写，后续可换贴图）。
 * w/h：背包/仓库占格；手部栏无视占格。
 * equipSlot：head | chest | legs | accessory | backpack | 缺省不可装备。
 */
(() => {
  const TYPE_LABELS = {
    fuel: '燃料',
    material: '材料',
    metal: '金属',
    tool: '工具',
    weapon: '武器',
    ammo: '弹药',
    apparel: '服装',
    accessory: '配件',
  };

  const EQUIP_SLOT_LABELS = {
    head: '头部',
    chest: '胸部',
    legs: '腿部',
    accessory: '配件',
    backpack: '背包',
  };

  const ITEMS = {
    coal: {
      id: 'coal',
      name: '煤炭',
      short: '煤',
      type: 'fuel',
      /** 投入锅炉时每单位提供的燃料值；未来其它燃料同样声明此字段即可。 */
      boilerFuel: 18,
      use: '从古至今，煤炭都是最要紧的能源之一——丢进锅炉，列车才肯往前走。',
      color: '#1f2937',
      accent: '#475569',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/coal-icon.png?v=2',
    },
    lumber: {
      id: 'lumber',
      name: '木料',
      short: '木',
      type: 'material',
      use: '基础建材，可用于维修车厢或制作简易零件。',
      color: '#78350f',
      accent: '#b45309',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    iron_ingot: {
      id: 'iron_ingot',
      name: '铁板',
      short: '铁',
      type: 'metal',
      use: '压扁的铁板，厚实可靠——加固车厢、锻造零件都靠它。',
      color: '#475569',
      accent: '#94a3b8',
      maxStack: 50,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    scrap: {
      id: 'scrap',
      name: '废料',
      short: '废',
      type: 'material',
      use: '各种材料糅合在一起——也许会有人愿意回收它们。',
      color: '#334155',
      accent: '#64748b',
      maxStack: 50,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/scrap-icon.png?v=1',
    },
    wrench: {
      id: 'wrench',
      name: '扳手',
      short: '扳',
      type: 'tool',
      use: '用于日常检修设备——不过真正的工程师，可不会只用它来修东西。',
      color: '#854d0e',
      accent: '#ca8a04',
      maxStack: 1,
      w: 2,
      h: 1,
      canHoldInHand: true,
    },
    turret_ammo: {
      id: 'turret_ammo',
      name: '机炮弹药',
      short: '弹',
      type: 'ammo',
      use: '通用的机炮弹药，这种规格的弹药刚好足够把敌人撕碎。',
      color: '#14532d',
      accent: '#4ade80',
      maxStack: 100,
      w: 1,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/turret-ammo-icon.png?v=1',
    },
    shell_casing: {
      id: 'shell_casing',
      name: '机炮弹壳',
      short: '壳',
      type: 'material',
      use: '机炮开火后回收的弹壳，可以回收利用成新的弹药',
      color: '#a16207',
      accent: '#facc15',
      maxStack: 100,
      w: 1,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/turret-casing-icon.png?v=1',
    },
    small_caliber_ammo: {
      id: 'small_caliber_ammo',
      name: '小口径子弹',
      short: '9mm',
      type: 'ammo',
      use: '用于冲锋枪和手枪的弹药，威力勉强够用。主要用于GUR-65等武器上。',
      color: '#713f12',
      accent: '#fbbf24',
      maxStack: 90,
      w: 1,
      h: 1,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/items/small-caliber-ammo-icon.png?v=2',
    },
    gur65: {
      id: 'gur65',
      name: 'GUR-65冲锋枪',
      short: 'G65',
      type: 'weapon',
      weaponId: 'gur65',
      /**
       * 机炮/冲锋枪类别：长按连发（见 isFullAuto）。
       * 未来机炮武器设 weaponClass: 'machine_gun'（或 fullAuto / fireMode:'auto'）即可。
       */
      weaponClass: 'machine_gun',
      fullAuto: true,
      use: '制式武器，采用 6.5mm 弹药与顶部供弹，小巧轻便——对刚登上列车的新人来说，性能再合适不过。',
      color: '#1f2937',
      accent: '#9ca3af',
      maxStack: 1,
      w: 3,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/weapons/gur-65-icon.png?v=3',
      holdSprite: '/static/games/liminal-platform/img/weapons/gur-65.png?v=3',
      gripOffset: { x: 28, y: -28 },
      muzzleLength: 56,
      muzzleOffsetY: -4,
      ejectLocal: { x: 16, y: -11 },
      /* 手持放大约 +36%（相对躯干更像冲锋枪）；holdPose 由 ?debugHold=1 调参写回 */
      holdDrawW: 76,
      holdDrawH: 30,
      holdPivotX: 37,
      holdPivotY: 20,
      /** 双附着：握把 back/红（胸口布局）+ 护木 front/橙（相对握把沿枪管） */
      holdPose: {
        chestX: -11.5,
        chestY: -12,
        gripAlong: 25.5,
        gripBelow: 3.5,
        gunForendX: 19,
        gunForendY: 2,
        forendAlong: 16,
        forendBelow: 6,
        gripLimb: 'back',
        forendLimb: 'front',
        gripElbowSign: -1,
        forendElbowSign: -1,
        shoulderX: 11,
        shoulderY: -13,
        upperLen: 13,
        lowerLen: 16.5,
        shoulderMin: -2.9,
        shoulderMax: 1.85,
        elbowMin: -2.75,
        elbowMax: 2.75,
      },
      magazineSize: 27,
      ammoId: 'small_caliber_ammo',
      /** 顶部供弹换弹动作。 */
      reloadStyle: 'top_mag',
      reloadDuration: 0.92,
      fireCooldown: 0.085,
      /** 单发后坐抬升（0–1 散布标度）。 */
      recoilKick: 0.22,
      /** 移动时后坐倍率（中）。 */
      moveRecoilMul: 1.45,
      recoilDecay: 1.8,
      spreadBaseDeg: 1.2,
      spreadBloomDeg: 7.5,
      /** 抛壳初速（沿枪口法向，世界单位/秒近似）。 */
      shellEjectSpeed: { forward: -35, up: 145 },
      /** 弹壳绘制缩放（小口径）。 */
      shellCasingScale: 0.42,
      /** 飞行弹种：离散子弹实体（非激光）。 */
      projectileStyle: 'bullet',
      /**
       * 最大飞行距离（世界像素）；缺省用 PROJECTILE_STYLE[projectileStyle].maxRange。
       * bullet 默认 1600；shell（机炮）默认 6400。
       */
      maxRange: 1600,
      /** 单发音效（CC0：ak47 shooting.wav）。 */
      fireSound: '/static/games/liminal-platform/audio/weapons/gur-65-shot.wav?v=1',
      fireSoundVolume: 0.62,
    },
    work_cap: {
      id: 'work_cap',
      name: '工装帽',
      short: '帽',
      type: 'apparel',
      use: '遮灰挡屑的简易头帽。',
      color: '#334155',
      accent: '#94a3b8',
      maxStack: 1,
      w: 1,
      h: 1,
      canHoldInHand: true,
      equipSlot: 'head',
    },
    work_vest: {
      id: 'work_vest',
      name: '工装背心',
      short: '背心',
      type: 'apparel',
      use: '防护胸腹的厚织背心。',
      color: '#1e3a5f',
      accent: '#38bdf8',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'chest',
    },
    work_pants: {
      id: 'work_pants',
      name: '工装裤',
      short: '裤',
      type: 'apparel',
      use: '耐磨长裤，适合在车厢间走动。',
      color: '#3f3f46',
      accent: '#a1a1aa',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'legs',
    },
    signal_lamp: {
      id: 'signal_lamp',
      name: '信号灯',
      short: '灯',
      type: 'accessory',
      use: '挂在腰侧的小型信号灯，便于昏暗车厢辨位。',
      color: '#854d0e',
      accent: '#fbbf24',
      maxStack: 1,
      w: 1,
      h: 1,
      canHoldInHand: true,
      equipSlot: 'accessory',
    },
    work_satchel: {
      id: 'work_satchel',
      name: '帆布挎包',
      short: '包',
      type: 'apparel',
      use: '装杂物的帆布挎包。装备到背包槽后，物品栏扩大为宽 6 × 高 4。',
      color: '#57534e',
      accent: '#a8a29e',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'backpack',
      bagCols: 6,
      bagRows: 4,
    },
  };

  /* 旧存档 id 兼容 */
  ITEMS.gur77 = ITEMS.gur65;

  /** 按 id 取物品定义。 */
  function getItem(itemId) {
    return ITEMS[itemId] || null;
  }

  /** 物品在网格中的宽高（格）。 */
  function getItemSize(itemId) {
    const item = getItem(itemId);
    if (!item) return { w: 1, h: 1 };
    return {
      w: Math.max(1, item.w || 1),
      h: Math.max(1, item.h || 1),
    };
  }

  /** 是否允许放入手部槽。 */
  function canHoldInHand(itemId) {
    const item = getItem(itemId);
    if (!item) return false;
    return item.canHoldInHand !== false;
  }

  /** 是否可装入指定装备槽位键。 */
  function canEquipInSlot(itemId, slotKey) {
    const item = getItem(itemId);
    if (!item?.equipSlot || !slotKey) return false;
    return item.equipSlot === slotKey;
  }

  /** 装备槽中文名。 */
  function equipSlotLabel(slotKey) {
    return EQUIP_SLOT_LABELS[slotKey] || slotKey || '—';
  }

  /** 类型中文名。 */
  function typeLabel(type) {
    return TYPE_LABELS[type] || type || '未知';
  }

  /** 是否可作为锅炉燃料（type=fuel 且 boilerFuel>0）。 */
  function isBoilerFuel(itemId) {
    const item = getItem(itemId);
    return Boolean(item && item.type === 'fuel' && Number(item.boilerFuel) > 0);
  }

  /** 单份燃料对锅炉的贡献值。 */
  function getBoilerFuelValue(itemId) {
    if (!isBoilerFuel(itemId)) return 0;
    return Number(getItem(itemId).boilerFuel) || 0;
  }

  /** 全部可投入锅炉的燃料定义（按 id 稳定排序）。 */
  function listBoilerFuels() {
    return Object.values(ITEMS)
      .filter((item) => item.type === 'fuel' && Number(item.boilerFuel) > 0)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  /**
   * 是否为可开火武器。
   * 标记方式：type === 'weapon'，或声明 weaponId（战斗层占位 id）。
   */
  function isWeapon(itemId) {
    const item = getItem(itemId);
    return Boolean(item && (item.type === 'weapon' || item.weaponId));
  }

  /**
   * 是否为可装备件（有 equipSlot：头/胸/腿/配件/背包等）。
   * 与 canEquipInSlot 同源，不依赖 type 文案。
   */
  function isEquipment(itemId) {
    const item = getItem(itemId);
    return Boolean(item?.equipSlot);
  }

  /**
   * 背包 rot 时图标是否跟着转：仅武器与装备。
   * 弹药/材料/燃料/工具等足迹仍可换向，贴图保持 upright。
   */
  function iconFollowsRot(itemId) {
    return isWeapon(itemId) || isEquipment(itemId);
  }

  /**
   * 是否全自动（长按连发）。
   * 判定：fullAuto === true，或 fireMode === 'auto'，或 weaponClass === 'machine_gun'。
   * 半自动/单发武器不要设这些字段。
   */
  function isFullAuto(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    if (!item) return false;
    if (item.fullAuto === true) return true;
    if (item.fireMode === 'auto') return true;
    return item.weaponClass === 'machine_gun';
  }

  /** 测试阶段：燃料/弹药堆与仓储种子物资自动补满；炮塔箱同。不含手持弹匣。TEST_ONLY — remove after playtest。 */
  const TEST_AUTO_REFILL_CONSUMABLES = true;

  function isConsumableItem(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && (item.type === 'fuel' || item.type === 'ammo'));
  }

  /** 战斗用武器 id；非武器返回 null。 */
  function getWeaponId(itemId) {
    const item = getItem(itemId);
    if (!item || !isWeapon(itemId)) return null;
    return item.weaponId || item.id;
  }

  /** 共享仓库库存 id（与 Inventory.id === 'storage' 对齐）。 */
  const STORAGE_BAG_ID = 'storage';
  /** 仓储可叠加物品叠加上限；背包/手部等仍用物品自身 maxStack。 */
  const STORAGE_MAX_STACK = 9999;

  /**
   * 按库存返回叠加上限：仓储对可叠加物用 STORAGE_MAX_STACK，其它用图鉴 maxStack。
   * @param {string|null|undefined} bagId
   * @param {string|object|null|undefined} itemOrId
   */
  function maxStackIn(bagId, itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    const base = Math.max(1, Number(item?.maxStack) || 1);
    if (base <= 1) return base;
    if (bagId === STORAGE_BAG_ID) return STORAGE_MAX_STACK;
    return base;
  }

  /**
   * 弹药类型判定（catalog type === 'ammo'）。
   * @param {string|object|null|undefined} itemOrId
   */
  function isAmmo(itemOrId) {
    const item = typeof itemOrId === 'string' ? getItem(itemOrId) : itemOrId;
    return Boolean(item && item.type === 'ammo');
  }

  /**
   * 武器是否接受该弹药：须有 magazineSize，且 ammoId 与弹药 id 一致。
   * 机炮弹等无 ammoId 武器返回 false（不走背包拖装填）。
   */
  function weaponAcceptsAmmo(weaponItemOrId, ammoItemId) {
    const weapon =
      typeof weaponItemOrId === 'string' ? getItem(weaponItemOrId) : weaponItemOrId;
    if (!weapon || !ammoItemId) return false;
    if (!isWeapon(weapon.id || weaponItemOrId)) return false;
    if (weapon.magazineSize == null || !weapon.ammoId) return false;
    return weapon.ammoId === ammoItemId;
  }

  window.LpItemCatalog = {
    ITEMS,
    TYPE_LABELS,
    EQUIP_SLOT_LABELS,
    STORAGE_BAG_ID,
    STORAGE_MAX_STACK,
    TEST_AUTO_REFILL_CONSUMABLES,
    isConsumableItem,
    getItem,
    getItemSize,
    maxStackIn,
    canHoldInHand,
    canEquipInSlot,
    equipSlotLabel,
    typeLabel,
    isBoilerFuel,
    getBoilerFuelValue,
    listBoilerFuels,
    isWeapon,
    isEquipment,
    iconFollowsRot,
    isAmmo,
    isFullAuto,
    getWeaponId,
    weaponAcceptsAmmo,
  };
})();
