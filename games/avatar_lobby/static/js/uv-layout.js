/**
 * UV 皮套图版式（LAYOUT_VERSION 6）：4:3 画幅（683×512），左侧为部位槽，右侧留白。
 *
 * rect      — 读取范围（含留白；四肢留白加大，便于臂甲等）
 * coreRect  — 推荐绘制区（模板色块与骨骼；舞台上对齐到 drawSize/drawRect）
 * drawRect  — 头部/身体在角色坐标系中的「推荐区」绘制范围
 * drawSize  — 四肢推荐区在角色坐标系中的 [宽, 长]（关节局部）
 *
 * 舞台渲染：把 core 对齐到 drawSize/drawRect，整份 rect 按同比例外扩。
 * 兼容：256×256 → LEGACY_PARTS；512×512 旧右栏模板 → SQUARE_V1_PARTS。
 */
(() => {
  const ATLAS_HEIGHT = 512;
  const ATLAS_WIDTH = Math.round((ATLAS_HEIGHT * 4) / 3); // 683，4:3 横画幅
  const CONTENT_WIDTH = 512;
  const LEGACY_ATLAS_SIZE = 256;
  const SQUARE_ATLAS_SIZE = 512;

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

  /** 在读取区内靠上放置推荐区。 */
  function coreAtTop(rect, coreW, coreH, topMargin = 10) {
    const [x, y, w] = rect;
    return [
      x + Math.floor((w - coreW) / 2),
      y + topMargin,
      coreW,
      coreH,
    ];
  }

  const headRect = [4, 4, 250, 250];
  const bodyRect = [262, 4, 246, 250];
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

  const headCoreRect = [
    Math.round(4 + (-9 - (-36)) * (250 / 72)),
    Math.round(4 + (-33 - (-36)) * (250 / 72)),
    Math.round(18 * (250 / 72)),
    Math.round(15 * (250 / 72)),
  ];

  /** 当前模板共用的舞台绘制尺寸（与图集 rect 解耦）。 */
  const STAGE = {
    head: { drawRect: [-36, -36, 72, 72], safeRect: [-9, -33, 18, 15] },
    body: { drawRect: [-11, -17, 22, 26] },
    armU: [7, 15],
    armL: [7, 16],
    legU: [8, 16],
    legL: [8, 17],
  };

  const PARTS = {
    head: {
      label: '头部/头发',
      code: 'HD',
      tagLine: 'HD  head  头部/头发',
      rect: headRect,
      coreRect: headCoreRect,
      drawRect: STAGE.head.drawRect,
      safeRect: STAGE.head.safeRect,
      color: '#facc15',
      kind: 'head',
    },
    body: {
      label: '身体',
      code: 'BD',
      tagLine: 'BD  body  身体',
      rect: bodyRect,
      coreRect: coreAtTop(bodyRect, 88, 104, 10),
      drawRect: STAGE.body.drawRect,
      color: '#22c55e',
      kind: 'body',
    },
    frontArmUpper: {
      label: '右手臂·上',
      code: 'RA1',
      tagLine: 'RA1  right arm 1  右手臂上段',
      rect: frontArmUpperRect,
      coreRect: coreIn(frontArmUpperRect, 28, 60),
      drawSize: STAGE.armU,
      color: '#f97316',
      kind: 'limb',
    },
    frontArmLower: {
      label: '右手臂·下',
      code: 'RA2',
      tagLine: 'RA2  right arm 2  右手臂下段',
      rect: frontArmLowerRect,
      coreRect: coreIn(frontArmLowerRect, 28, 64),
      drawSize: STAGE.armL,
      color: '#fb923c',
      kind: 'limb',
    },
    backArmUpper: {
      label: '左手臂·上',
      code: 'LA1',
      tagLine: 'LA1  left arm 1  左手臂上段',
      rect: backArmUpperRect,
      coreRect: coreIn(backArmUpperRect, 28, 60),
      drawSize: STAGE.armU,
      color: '#ef4444',
      kind: 'limb',
    },
    backArmLower: {
      label: '左手臂·下',
      code: 'LA2',
      tagLine: 'LA2  left arm 2  左手臂下段',
      rect: backArmLowerRect,
      coreRect: coreIn(backArmLowerRect, 28, 64),
      drawSize: STAGE.armL,
      color: '#f87171',
      kind: 'limb',
    },
    frontLegUpper: {
      label: '右腿·上',
      code: 'RL1',
      tagLine: 'RL1  right leg 1  右腿上段',
      rect: frontLegUpperRect,
      coreRect: coreIn(frontLegUpperRect, 32, 64),
      drawSize: STAGE.legU,
      color: '#8b5cf6',
      kind: 'limb',
    },
    frontLegLower: {
      label: '右腿·下',
      code: 'RL2',
      tagLine: 'RL2  right leg 2  右腿下段',
      rect: frontLegLowerRect,
      coreRect: coreIn(frontLegLowerRect, 32, 68),
      drawSize: STAGE.legL,
      color: '#a78bfa',
      kind: 'limb',
    },
    backLegUpper: {
      label: '左腿·上',
      code: 'LL1',
      tagLine: 'LL1  left leg 1  左腿上段',
      rect: backLegUpperRect,
      coreRect: coreIn(backLegUpperRect, 32, 64),
      drawSize: STAGE.legU,
      color: '#3b82f6',
      kind: 'limb',
    },
    backLegLower: {
      label: '左腿·下',
      code: 'LL2',
      tagLine: 'LL2  left leg 2  左腿下段',
      rect: backLegLowerRect,
      coreRect: coreIn(backLegLowerRect, 32, 68),
      drawSize: STAGE.legL,
      color: '#60a5fa',
      kind: 'limb',
    },
  };

  const LEGACY_PARTS = {
    head: { rect: [0, 0, 88, 72], drawRect: [-9, -33, 18, 15], kind: 'head' },
    body: { rect: [96, 0, 112, 120], drawRect: STAGE.body.drawRect, kind: 'body' },
    frontArmUpper: { rect: [0, 80, 28, 52], drawSize: STAGE.armU, kind: 'limb' },
    frontArmLower: { rect: [32, 80, 28, 56], drawSize: STAGE.armL, kind: 'limb' },
    backArmUpper: { rect: [0, 144, 28, 52], drawSize: STAGE.armU, kind: 'limb' },
    backArmLower: { rect: [32, 144, 28, 56], drawSize: STAGE.armL, kind: 'limb' },
    frontLegUpper: { rect: [64, 128, 36, 48], drawSize: STAGE.legU, kind: 'limb' },
    frontLegLower: { rect: [104, 128, 36, 52], drawSize: STAGE.legL, kind: 'limb' },
    backLegUpper: { rect: [64, 184, 36, 48], drawSize: STAGE.legU, kind: 'limb' },
    backLegLower: { rect: [104, 184, 36, 52], drawSize: STAGE.legL, kind: 'limb' },
  };

  /**
   * 旧版 512×512 右栏模板（HAIR+HEAD 左大槽；BODY/FAU… 在右侧）。
   * 舞台尺寸沿用当前 PARTS，仅图集 rect 不同。
   */
  const SQUARE_V1_PARTS = {
    head: {
      rect: [0, 0, 288, 288],
      drawRect: STAGE.head.drawRect,
      safeRect: STAGE.head.safeRect,
      kind: 'head',
      color: '#facc15',
      label: '头部/头发',
      code: 'HD',
    },
    body: {
      rect: [304, 0, 112, 120],
      drawRect: STAGE.body.drawRect,
      kind: 'body',
      color: '#22c55e',
      label: '身体',
      code: 'BD',
    },
    frontArmUpper: { rect: [304, 136, 28, 52], drawSize: STAGE.armU, kind: 'limb', color: '#f97316', code: 'RA1' },
    frontArmLower: { rect: [336, 136, 28, 56], drawSize: STAGE.armL, kind: 'limb', color: '#fb923c', code: 'RA2' },
    backArmUpper: { rect: [368, 136, 28, 52], drawSize: STAGE.armU, kind: 'limb', color: '#ef4444', code: 'LA1' },
    backArmLower: { rect: [400, 136, 28, 56], drawSize: STAGE.armL, kind: 'limb', color: '#f87171', code: 'LA2' },
    frontLegUpper: { rect: [304, 208, 36, 48], drawSize: STAGE.legU, kind: 'limb', color: '#8b5cf6', code: 'RL1' },
    frontLegLower: { rect: [344, 208, 36, 52], drawSize: STAGE.legL, kind: 'limb', color: '#a78bfa', code: 'RL2' },
    backLegUpper: { rect: [384, 208, 36, 48], drawSize: STAGE.legU, kind: 'limb', color: '#3b82f6', code: 'LL1' },
    backLegLower: { rect: [424, 208, 36, 52], drawSize: STAGE.legL, kind: 'limb', color: '#60a5fa', code: 'LL2' },
  };

  /** 采样图集矩形不透明度（用于版式启发式）。 */
  function sampleOpaqueRatio(atlas, rect) {
    const [x, y, w, h] = rect;
    if (w <= 0 || h <= 0) return 0;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(w / 2));
    canvas.height = Math.max(1, Math.floor(h / 2));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(atlas, x, y, w, h, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaque = 0;
    let total = 0;
    for (let i = 3; i < data.length; i += 16) {
      total += 1;
      if (data[i] > 40) opaque += 1;
    }
    return total ? opaque / total : 0;
  }

  /**
   * 按图集尺寸 / 内容选择部位表。
   * 683×512 → PARTS；256 → LEGACY；512 右栏旧模板 → SQUARE_V1；512 底栏 → PARTS。
   */
  function resolveParts(atlas) {
    if (!atlas) return PARTS;
    if (atlas._uvPartsResolved) return atlas._uvPartsResolved;

    let parts = PARTS;
    if (atlas.width === LEGACY_ATLAS_SIZE && atlas.height === LEGACY_ATLAS_SIZE) {
      parts = LEGACY_PARTS;
    } else if (atlas.width === SQUARE_ATLAS_SIZE && atlas.height === SQUARE_ATLAS_SIZE) {
      const bottomLimb = sampleOpaqueRatio(atlas, frontLegLowerRect);
      const v1Limb = sampleOpaqueRatio(atlas, SQUARE_V1_PARTS.frontArmUpper.rect);
      parts = bottomLimb >= 0.15 && bottomLimb >= v1Limb ? PARTS : SQUARE_V1_PARTS;
    } else if (atlas.width === ATLAS_WIDTH && atlas.height === ATLAS_HEIGHT) {
      parts = PARTS;
    } else if (atlas.width >= 600) {
      parts = PARTS;
    } else if (atlas.width === SQUARE_ATLAS_SIZE || atlas.height === SQUARE_ATLAS_SIZE) {
      parts = SQUARE_V1_PARTS;
    }

    atlas._uvPartsResolved = parts;
    atlas._uvLayoutId =
      parts === LEGACY_PARTS ? 'legacy-256'
        : parts === SQUARE_V1_PARTS ? 'square-v1-512'
          : 'v6-683';
    return parts;
  }

  window.UVLayout = {
    ATLAS_WIDTH,
    ATLAS_HEIGHT,
    CONTENT_WIDTH,
    LAYOUT_VERSION: 6,
    LEGACY_ATLAS_SIZE,
    SQUARE_ATLAS_SIZE,
    RIG: {
      shoulderX: 11,
      shoulderY: -16,
      hipX: 6,
      hipY: 3,
    },
    PARTS,
    LEGACY_PARTS,
    SQUARE_V1_PARTS,
    resolveParts,
  };
})();
