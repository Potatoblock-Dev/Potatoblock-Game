/**
 * UV 皮套图版式（v2）：编辑器合成、模板下载、舞台渲染共用。
 *
 * rect      — 读取范围（含留白，可画臂甲/长发等超出推荐区的内容）
 * coreRect  — 推荐绘制区（模板色块与骨骼；舞台上对齐到 drawSize/drawRect）
 * drawRect  — 头部/身体在角色坐标系中的「推荐区」绘制范围
 * drawSize  — 四肢推荐区在角色坐标系中的 [宽, 长]（关节局部）
 * color     — 模板色块颜色（部位区分）
 *
 * 舞台渲染：把 core 对齐到 drawSize/drawRect，整份 rect 按同比例外扩，
 * 因此读取区留白里的臂甲/长发会露在推荐轮廓外，但基础比例与旧版一致。
 *
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

  // 读取区比推荐槽更大，便于臂甲、披风、长发；槽与槽之间留 4px 线分割空隙。
  const headRect = [4, 4, 300, 300];
  const bodyRect = [308, 4, 200, 168];
  const frontArmUpperRect = [308, 180, 48, 80];
  const frontArmLowerRect = [360, 180, 48, 84];
  const backArmUpperRect = [412, 180, 48, 80];
  const backArmLowerRect = [464, 180, 48, 84];
  const frontLegUpperRect = [308, 272, 48, 72];
  const frontLegLowerRect = [360, 272, 48, 76];
  const backLegUpperRect = [412, 272, 48, 72];
  const backLegLowerRect = [464, 272, 48, 76];

  window.UVLayout = {
    ATLAS_SIZE,
    LAYOUT_VERSION: 2,
    LEGACY_ATLAS_SIZE: 256,
    PARTS: {
      head: {
        label: '头部/头发',
        rect: headRect,
        // 整身画布映射到角色 72×72；推荐脸 = safeRect
        coreRect: [108, 8, 92, 75],
        drawRect: [-36, -36, 72, 72],
        safeRect: [-11, -35, 22, 18],
        color: '#facc15',
        kind: 'head',
      },
      body: {
        label: '身体',
        rect: bodyRect,
        coreRect: coreIn(bodyRect, 112, 120),
        drawRect: [-14, -17, 28, 30],
        color: '#22c55e',
        kind: 'body',
      },
      frontArmUpper: {
        label: '前臂·上段',
        rect: frontArmUpperRect,
        coreRect: coreIn(frontArmUpperRect, 28, 52),
        drawSize: [7, 13],
        color: '#f97316',
        kind: 'limb',
      },
      frontArmLower: {
        label: '前臂·下段',
        rect: frontArmLowerRect,
        coreRect: coreIn(frontArmLowerRect, 28, 56),
        drawSize: [7, 14],
        color: '#fb923c',
        kind: 'limb',
      },
      backArmUpper: {
        label: '后臂·上段',
        rect: backArmUpperRect,
        coreRect: coreIn(backArmUpperRect, 28, 52),
        drawSize: [7, 13],
        color: '#ef4444',
        kind: 'limb',
      },
      backArmLower: {
        label: '后臂·下段',
        rect: backArmLowerRect,
        coreRect: coreIn(backArmLowerRect, 28, 56),
        drawSize: [7, 14],
        color: '#f87171',
        kind: 'limb',
      },
      frontLegUpper: {
        label: '前腿·上段',
        rect: frontLegUpperRect,
        coreRect: coreIn(frontLegUpperRect, 36, 48),
        drawSize: [9, 12],
        color: '#8b5cf6',
        kind: 'limb',
      },
      frontLegLower: {
        label: '前腿·下段',
        rect: frontLegLowerRect,
        coreRect: coreIn(frontLegLowerRect, 36, 52),
        drawSize: [9, 13],
        color: '#a78bfa',
        kind: 'limb',
      },
      backLegUpper: {
        label: '后腿·上段',
        rect: backLegUpperRect,
        coreRect: coreIn(backLegUpperRect, 36, 48),
        drawSize: [9, 12],
        color: '#3b82f6',
        kind: 'limb',
      },
      backLegLower: {
        label: '后腿·下段',
        rect: backLegLowerRect,
        coreRect: coreIn(backLegLowerRect, 36, 52),
        drawSize: [9, 13],
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
