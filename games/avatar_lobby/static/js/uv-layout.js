/**
 * UV 皮套图版式（v4）：约 8 头身真人比例；编辑器 / 模板 / 舞台共用。
 *
 * rect      — 读取范围（含留白；四肢留白加大，便于臂甲等）
 * coreRect  — 推荐绘制区（模板色块与骨骼；舞台上对齐到 drawSize/drawRect）
 * drawRect  — 头部/身体在角色坐标系中的「推荐区」绘制范围
 * drawSize  — 四肢推荐区在角色坐标系中的 [宽, 长]（关节局部）
 * code      — 模板短码（如 RA1）
 * color     — 模板色块颜色（部位区分）
 *
 * 舞台渲染：把 core 对齐到 drawSize/drawRect，整份 rect 按同比例外扩。
 * 旧 256×256 皮套继续使用 LEGACY_PARTS。
 */
(() => {
  const ATLAS_SIZE = 512;

  /** 在读取区内居中放置推荐区。 */
  function coreIn(rect, coreW, coreH) {
    const [x, y, w, h] = rect;
    return [
      x + Math.floor((w - coreW) / 2),
      y + Math.floor((h - coreH) / 2),
      coreW,
      coreH,
    ];
  }

  // 头/身在上；四肢在下方整宽排布，单槽约 122×118，相对推荐区有大幅留白。
  const headRect = [4, 4, 250, 250];
  const bodyRect = [262, 4, 246, 150];
  const limbW = 122;
  const limbGap = 4;
  const armY = 258;
  const armH = 118;
  const legY = 380;
  const legH = 118;
  const limbXs = [4, 4 + limbW + limbGap, 4 + 2 * (limbW + limbGap), 4 + 3 * (limbW + limbGap)];

  const frontArmUpperRect = [limbXs[0], armY, limbW, armH];
  const frontArmLowerRect = [limbXs[1], armY, limbW, armH];
  const backArmUpperRect = [limbXs[2], armY, limbW, armH];
  const backArmLowerRect = [limbXs[3], armY, limbW, armH];
  const frontLegUpperRect = [limbXs[0], legY, limbW, legH];
  const frontLegLowerRect = [limbXs[1], legY, limbW, legH];
  const backLegUpperRect = [limbXs[2], legY, limbW, legH];
  const backLegLowerRect = [limbXs[3], legY, limbW, legH];

  // 约 8 头身：头≈1/8 身高；髋偏低、腿更长，脚底落在画布 y=+36。
  // safeRect 映射：drawRect [-36,-36,72,72] → slot 250×250
  const headCoreRect = [
    Math.round(4 + (-9 - (-36)) * (250 / 72)),
    Math.round(4 + (-33 - (-36)) * (250 / 72)),
    Math.round(18 * (250 / 72)),
    Math.round(15 * (250 / 72)),
  ];

  window.UVLayout = {
    ATLAS_SIZE,
    LAYOUT_VERSION: 4,
    LEGACY_ATLAS_SIZE: 256,
    // 关节锚点（角色局部坐标，+y 向下）
    RIG: {
      shoulderX: 11,
      shoulderY: -16,
      hipX: 6,
      hipY: 3,
    },
    PARTS: {
      head: {
        label: '头部/头发',
        code: 'HD',
        tagLine: 'HD  head  头部/头发',
        rect: headRect,
        coreRect: headCoreRect,
        drawRect: [-36, -36, 72, 72],
        safeRect: [-9, -33, 18, 15],
        color: '#facc15',
        kind: 'head',
      },
      body: {
        label: '身体',
        code: 'BD',
        tagLine: 'BD  body  身体',
        rect: bodyRect,
        // 世界约 20×20 → atlas 4×
        coreRect: coreIn(bodyRect, 80, 80),
        drawRect: [-10, -16, 20, 20],
        color: '#22c55e',
        kind: 'body',
      },
      // 朝右时 front = 角色右侧（右手/右腿），back = 左侧
      frontArmUpper: {
        label: '右手臂·上',
        code: 'RA1',
        tagLine: 'RA1  right arm 1  右手臂上段',
        rect: frontArmUpperRect,
        coreRect: coreIn(frontArmUpperRect, 28, 60),
        drawSize: [7, 15],
        color: '#f97316',
        kind: 'limb',
      },
      frontArmLower: {
        label: '右手臂·下',
        code: 'RA2',
        tagLine: 'RA2  right arm 2  右手臂下段',
        rect: frontArmLowerRect,
        coreRect: coreIn(frontArmLowerRect, 28, 64),
        drawSize: [7, 16],
        color: '#fb923c',
        kind: 'limb',
      },
      backArmUpper: {
        label: '左手臂·上',
        code: 'LA1',
        tagLine: 'LA1  left arm 1  左手臂上段',
        rect: backArmUpperRect,
        coreRect: coreIn(backArmUpperRect, 28, 60),
        drawSize: [7, 15],
        color: '#ef4444',
        kind: 'limb',
      },
      backArmLower: {
        label: '左手臂·下',
        code: 'LA2',
        tagLine: 'LA2  left arm 2  左手臂下段',
        rect: backArmLowerRect,
        coreRect: coreIn(backArmLowerRect, 28, 64),
        drawSize: [7, 16],
        color: '#f87171',
        kind: 'limb',
      },
      frontLegUpper: {
        label: '右腿·上',
        code: 'RL1',
        tagLine: 'RL1  right leg 1  右腿上段',
        rect: frontLegUpperRect,
        coreRect: coreIn(frontLegUpperRect, 32, 64),
        drawSize: [8, 16],
        color: '#8b5cf6',
        kind: 'limb',
      },
      frontLegLower: {
        label: '右腿·下',
        code: 'RL2',
        tagLine: 'RL2  right leg 2  右腿下段',
        rect: frontLegLowerRect,
        coreRect: coreIn(frontLegLowerRect, 32, 68),
        drawSize: [8, 17],
        color: '#a78bfa',
        kind: 'limb',
      },
      backLegUpper: {
        label: '左腿·上',
        code: 'LL1',
        tagLine: 'LL1  left leg 1  左腿上段',
        rect: backLegUpperRect,
        coreRect: coreIn(backLegUpperRect, 32, 64),
        drawSize: [8, 16],
        color: '#3b82f6',
        kind: 'limb',
      },
      backLegLower: {
        label: '左腿·下',
        code: 'LL2',
        tagLine: 'LL2  left leg 2  左腿下段',
        rect: backLegLowerRect,
        coreRect: coreIn(backLegLowerRect, 32, 68),
        drawSize: [8, 17],
        color: '#60a5fa',
        kind: 'limb',
      },
    },
    LEGACY_PARTS: {
      head: { rect: [0, 0, 88, 72] },
      body: { rect: [96, 0, 112, 120] },
      frontArmUpper: { rect: [0, 80, 28, 52] },
      frontArmLower: { rect: [32, 80, 28, 56] },
      backArmUpper: { rect: [0, 144, 28, 52] },
      backArmLower: { rect: [32, 144, 28, 56] },
      frontLegUpper: { rect: [64, 128, 36, 48] },
      frontLegLower: { rect: [104, 128, 36, 52] },
      backLegUpper: { rect: [64, 184, 36, 48] },
      backLegLower: { rect: [104, 184, 36, 52] },
    },
  };
})();
