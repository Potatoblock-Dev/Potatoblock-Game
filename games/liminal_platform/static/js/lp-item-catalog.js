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
      use: '投入锅炉燃烧，为列车提供动力。',
      color: '#1f2937',
      accent: '#475569',
      maxStack: 100,
      w: 1,
      h: 1,
      canHoldInHand: true,
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
      use: '装杂物的帆布挎包，装备后便于携带物资。',
      color: '#57534e',
      accent: '#a8a29e',
      maxStack: 1,
      w: 2,
      h: 2,
      canHoldInHand: false,
      equipSlot: 'backpack',
    },
  };

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

  window.LpItemCatalog = {
    ITEMS,
    TYPE_LABELS,
    EQUIP_SLOT_LABELS,
    getItem,
    getItemSize,
    canHoldInHand,
    canEquipInSlot,
    equipSlotLabel,
    typeLabel,
  };
})();
