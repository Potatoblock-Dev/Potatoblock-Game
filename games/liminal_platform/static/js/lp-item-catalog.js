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
      use: '投入锅炉燃烧，为列车提供动力。',
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
      name: '铁锭',
      short: '铁',
      type: 'metal',
      use: '锻造与加固用金属，可加工为零件。',
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
      use: '回收残骸，可拆解或熔炼再利用。',
      color: '#334155',
      accent: '#64748b',
      maxStack: 50,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    wrench: {
      id: 'wrench',
      name: '扳手',
      short: '扳',
      type: 'tool',
      use: '检修车钩与锅炉管道的基础工具。',
      color: '#854d0e',
      accent: '#ca8a04',
      maxStack: 1,
      w: 2,
      h: 1,
      canHoldInHand: true,
    },
    turret_ammo: {
      id: 'turret_ammo',
      name: '机炮子弹',
      short: '弹',
      type: 'ammo',
      use: '卫兵防御车厢双联机炮用弹，放入中间绿色弹药箱后开火消耗。',
      color: '#14532d',
      accent: '#4ade80',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    shell_casing: {
      id: 'shell_casing',
      name: '弹壳',
      short: '壳',
      type: 'material',
      use: '炮塔射击后的废壳，可从黄色回收箱取出再利用。',
      color: '#a16207',
      accent: '#facc15',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
    },
    small_caliber_ammo: {
      id: 'small_caliber_ammo',
      name: '小口径子弹',
      short: '9mm',
      type: 'ammo',
      use: '手枪与冲锋枪通用的小口径弹药，用于装填 GUR-65 等武器。',
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
      use: '顶部供弹冲锋枪。弹匣 27 发，后坐中等；移动时后坐加剧。按 R 装填小口径子弹。',
      color: '#1f2937',
      accent: '#9ca3af',
      maxStack: 1,
      w: 3,
      h: 2,
      canHoldInHand: true,
      icon: '/static/games/liminal-platform/img/weapons/gur-65-icon.png?v=3',
      holdSprite: '/static/games/liminal-platform/img/weapons/gur-65.png?v=3',
      gripOffset: { x: 22, y: -22 },
      muzzleLength: 42,
      muzzleOffsetY: -3,
      ejectLocal: { x: 12, y: -8 },
      holdDrawW: 56,
      holdDrawH: 24,
      /* 握把略偏贴图左下（枪柄），配合前臂 0.88 掌心锚 */
      holdPivotX: 8,
      holdPivotY: 15,
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

  /** 测试阶段：燃料/弹药用后自动补满。正式上线前改为 false。 */
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

  window.LpItemCatalog = {
    ITEMS,
    TYPE_LABELS,
    EQUIP_SLOT_LABELS,
    TEST_AUTO_REFILL_CONSUMABLES,
    isConsumableItem,
    getItem,
    getItemSize,
    canHoldInHand,
    canEquipInSlot,
    equipSlotLabel,
    typeLabel,
    isBoilerFuel,
    getBoilerFuelValue,
    listBoilerFuels,
    isWeapon,
    getWeaponId,
  };
})();
