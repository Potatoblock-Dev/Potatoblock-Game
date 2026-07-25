/**
 * 世界背景层：由 world.seed 派生调性（密度 / 色相 / 饱和度等）+ 多层远景（雾带 / 远形 / 尘星 / 中景泡）。
 * 绘于轨道/车厢之下；种子变化时才重建参数，避免每帧重算。仅柔边径向光晕，无硬 AABB 色块。
 */
(() => {
  /** FOV 外延（世界像素）。 */
  const FOV_MARGIN = 120;
  /** 与地牢/月台区分的背景子流盐。 */
  const BG_STREAM = 0xb6b61e;
  /** 中景泡密度上下限。 */
  const BUBBLE_MIN = 8;
  const BUBBLE_MAX = 22;
  /** 远景大柔形上下限。 */
  const FAR_MIN = 3;
  const FAR_MAX = 8;
  /** 丝带条数上下限。 */
  const RIBBON_MIN = 2;
  const RIBBON_MAX = 5;
  /** 水平雾带上下限。 */
  const HAZE_MIN = 2;
  const HAZE_MAX = 5;
  /** 尘星上下限（小点，移动端仍轻）。 */
  const DUST_MIN = 32;
  const DUST_MAX = 72;
  /** 造型枚举。 */
  const SHAPES = ['ellipse', 'squircle', 'blob', 'petal', 'ring', 'diamond'];

  let timeSec = 0;
  /** @type {number|null} */
  let appliedSeed = null;
  /** @type {BgTheme|null} */
  let theme = null;
  /** @type {BubbleSpec[]} */
  let bubbles = [];
  /** @type {FarSpec[]} */
  let farShapes = [];
  /** @type {HazeBandSpec[]} */
  let hazeBands = [];
  /** @type {DustSpec[]} */
  let dust = [];
  /** @type {MediaQueryList|null} */
  let coarseMq = null;
  /** 上次重建时使用的质量档，变化时按同一种子重建层密度。 */
  let appliedQuality = 1;

  /**
   * 画质系数：触控 / 低 DPR 降低尘星与中景泡数量。
   * @returns {number}
   */
  function qualityFactor() {
    if (!coarseMq) coarseMq = window.matchMedia('(pointer: coarse)');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (coarseMq.matches && dpr < 1.5) return 0.45;
    if (coarseMq.matches) return 0.6;
    if (dpr < 1.25) return 0.75;
    return 1;
  }

  /**
   * @typedef {{
   *   seed: number,
   *   palette: number[][],
   *   hue: number,
   *   saturation: number,
   *   brightness: number,
   *   density: number,
   *   bubbleCount: number,
   *   farCount: number,
   *   ribbonCount: number,
   *   hazeCount: number,
   *   dustCount: number,
   *   sizeMin: number,
   *   sizeMax: number,
   *   drift: number,
   *   opacity: number,
   *   washContrast: number,
   *   washTint: number[],
   *   hazeAlpha: number,
   * }} BgTheme
   */

  /**
   * @typedef {{
   *   shape: string,
   *   u: number,
   *   v: number,
   *   sizeN: number,
   *   aspect: number,
   *   rot: number,
   *   lobe: number,
   *   wobble: number,
   *   phase: number,
   *   speedN: number,
   *   colorI: number,
   *   parallax: number,
   * }} BubbleSpec
   */

  /**
   * @typedef {{
   *   shape: string,
   *   u: number,
   *   v: number,
   *   sizeN: number,
   *   aspect: number,
   *   rot: number,
   *   lobe: number,
   *   wobble: number,
   *   phase: number,
   *   speedN: number,
   *   colorI: number,
   *   parallax: number,
   * }} FarSpec
   */

  /**
   * @typedef {{
   *   v: number,
   *   heightN: number,
   *   phase: number,
   *   speedN: number,
   *   colorI: number,
   *   alphaN: number,
   * }} HazeBandSpec
   */

  /**
   * @typedef {{
   *   u: number,
   *   v: number,
   *   sizeN: number,
   *   phase: number,
   *   speedN: number,
   *   colorI: number,
   *   twinkle: number,
   *   parallax: number,
   * }} DustSpec
   */

  /** mulberry32：优先复用 LpDungeon，否则本地对齐实现。 */
  function mulberry32(seed) {
    const D = window.LpDungeon;
    if (D?.mulberry32) return D.mulberry32(seed);
    let a = seed >>> 0;
    return function rng() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** hash2：优先复用 LpDungeon。 */
  function hash2(worldSeed, salt) {
    const D = window.LpDungeon;
    if (D?.hash2) return D.hash2(worldSeed, salt);
    let h = (worldSeed >>> 0) ^ Math.imul((salt | 0) + 1, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
  }

  /**
   * HSL → RGB（0–255）；s/l 为 0–1。
   * @param {number} hDeg
   * @param {number} s
   * @param {number} l
   * @returns {number[]}
   */
  function hslToRgb(hDeg, s, l) {
    const h = ((hDeg % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0;
    let g = 0;
    let b = 0;
    if (h < 60) {
      r = c;
      g = x;
    } else if (h < 120) {
      r = x;
      g = c;
    } else if (h < 180) {
      g = c;
      b = x;
    } else if (h < 240) {
      g = x;
      b = c;
    } else if (h < 300) {
      r = x;
      b = c;
    } else {
      r = c;
      b = x;
    }
    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255),
    ];
  }

  /**
   * 由世界种子构建背景调性与各层规格；只在种子变化时调用。
   * @param {number} worldSeed
   */
  function rebuildFromSeed(worldSeed) {
    const seed = worldSeed >>> 0;
    const rng = mulberry32(hash2(seed, BG_STREAM));
    const q = qualityFactor();
    appliedQuality = q;

    const hue = rng() * 360;
    const saturation = 0.32 + rng() * 0.48;
    const brightness = 0.38 + rng() * 0.28;
    const density = 0.35 + rng() * 0.65;
    const bubbleCount = Math.max(
      4,
      Math.round((BUBBLE_MIN + density * (BUBBLE_MAX - BUBBLE_MIN)) * q)
    );
    const farCount = Math.max(
      2,
      Math.round((FAR_MIN + density * (FAR_MAX - FAR_MIN)) * Math.max(0.55, q))
    );
    const ribbonCount = Math.round(
      RIBBON_MIN + rng() * (RIBBON_MAX - RIBBON_MIN)
    );
    const hazeCount = Math.round(HAZE_MIN + rng() * (HAZE_MAX - HAZE_MIN));
    const dustCount = Math.max(
      12,
      Math.round((DUST_MIN + density * (DUST_MAX - DUST_MIN)) * q)
    );
    const sizeMin = 0.032 + rng() * 0.022;
    const sizeMax = sizeMin + 0.035 + rng() * 0.055;
    const drift = 0.55 + rng() * 0.9;
    const opacity = 0.78 + rng() * 0.5;
    const washContrast = 0.65 + rng() * 0.55;
    const hazeAlpha = 0.09 + rng() * 0.1;
    const washTint = hslToRgb(hue, saturation * 0.45, 0.18 + brightness * 0.12);

    /** @type {number[][]} */
    const palette = [];
    const n = 5 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i += 1) {
      const h =
        hue +
        (i - (n - 1) / 2) * (18 + rng() * 28) +
        (rng() - 0.5) * 14;
      const s = Math.max(0.18, Math.min(0.78, saturation * (0.75 + rng() * 0.4)));
      const l = Math.max(
        0.28,
        Math.min(0.62, brightness * (0.85 + rng() * 0.35))
      );
      palette.push(hslToRgb(h, s, l));
    }

    /** @type {FarSpec[]} */
    const nextFar = [];
    for (let i = 0; i < farCount; i += 1) {
      nextFar.push({
        shape: SHAPES[Math.floor(rng() * SHAPES.length)],
        u: rng(),
        v: 0.04 + rng() * 0.42,
        sizeN: 0.09 + rng() * 0.14,
        aspect: 0.55 + rng() * 0.7,
        rot: (rng() - 0.5) * 0.9,
        lobe: 2 + Math.floor(rng() * 3),
        wobble: 0.1 + rng() * 0.2,
        phase: rng() * Math.PI * 2,
        speedN: 0.35 + rng() * 0.45,
        colorI: Math.floor(rng() * palette.length),
        parallax: 0.18 + rng() * 0.22,
      });
    }

    /** @type {BubbleSpec[]} */
    const nextBubbles = [];
    for (let i = 0; i < bubbleCount; i += 1) {
      nextBubbles.push({
        shape: SHAPES[Math.floor(rng() * SHAPES.length)],
        u: rng(),
        v: 0.05 + rng() * 0.48,
        sizeN: sizeMin + rng() * (sizeMax - sizeMin),
        aspect: 0.62 + rng() * 0.55,
        rot: (rng() - 0.5) * 0.7,
        lobe: 2 + Math.floor(rng() * 3),
        wobble: 0.08 + rng() * 0.18,
        phase: rng() * Math.PI * 2,
        speedN: 0.7 + rng() * 0.7,
        colorI: Math.floor(rng() * palette.length),
        parallax: 0.45 + rng() * 0.35,
      });
    }

    /** @type {HazeBandSpec[]} */
    const nextHaze = [];
    for (let i = 0; i < hazeCount; i += 1) {
      nextHaze.push({
        v: 0.08 + rng() * 0.52,
        heightN: 0.06 + rng() * 0.12,
        phase: rng() * Math.PI * 2,
        speedN: 0.25 + rng() * 0.4,
        colorI: Math.floor(rng() * palette.length),
        alphaN: 0.55 + rng() * 0.45,
      });
    }

    /** @type {DustSpec[]} */
    const nextDust = [];
    for (let i = 0; i < dustCount; i += 1) {
      nextDust.push({
        u: rng(),
        v: 0.02 + rng() * 0.58,
        sizeN: 0.0012 + rng() * 0.0038,
        phase: rng() * Math.PI * 2,
        speedN: 0.5 + rng() * 1.2,
        colorI: Math.floor(rng() * palette.length),
        twinkle: 0.35 + rng() * 0.65,
        parallax: 0.55 + rng() * 0.45,
      });
    }

    theme = {
      seed,
      palette,
      hue,
      saturation,
      brightness,
      density,
      bubbleCount,
      farCount,
      ribbonCount,
      hazeCount,
      dustCount,
      sizeMin,
      sizeMax,
      drift,
      opacity,
      washContrast,
      washTint,
      hazeAlpha,
    };
    farShapes = nextFar;
    bubbles = nextBubbles;
    hazeBands = nextHaze;
    dust = nextDust;
    appliedSeed = seed;
  }

  /**
   * 解析当前世界种子：LpPlatform（含离线本地种）→ 已应用种 → 临时随机。
   * @returns {number}
   */
  function resolveWorldSeed() {
    if (window.LpPlatform?.getWorldSeed) {
      const live = window.LpPlatform.getWorldSeed();
      if (Number.isFinite(live)) return live >>> 0;
    }
    if (appliedSeed != null) return appliedSeed;
    return (Math.random() * 0x1fffffffffffff) >>> 0;
  }

  /**
   * 若种子变了则重建主题与各层表。
   */
  function ensureTheme() {
    const seed = resolveWorldSeed();
    const q = qualityFactor();
    if (theme && appliedSeed === seed && Math.abs(appliedQuality - q) < 0.08) {
      return;
    }
    rebuildFromSeed(seed);
  }

  /**
   * 外部写入种子（快照 / 离线）；也可只靠 draw 时轮询 LpPlatform。
   * @param {number} seed
   */
  function setSeed(seed) {
    if (seed == null || !Number.isFinite(Number(seed))) return;
    rebuildFromSeed(Number(seed) >>> 0);
  }

  /** @returns {number|null} */
  function getSeed() {
    return appliedSeed;
  }

  /**
   * 推进背景时钟（秒）。
   * @param {number} [dt]
   */
  function tick(dt) {
    if (Number.isFinite(dt) && dt > 0) {
      timeSec += Math.min(0.05, dt);
    } else {
      timeSec = performance.now() * 0.001;
    }
  }

  /**
   * 从当前世界变换求可见世界矩形。
   * @param {CanvasRenderingContext2D} ctx
   * @returns {{ left: number, right: number, top: number, bot: number } | null}
   */
  function viewRectFromTransform(ctx) {
    const m = ctx.getTransform();
    const sx = m.a;
    const sy = m.d;
    if (!(sx > 0) || !(sy > 0) || !ctx.canvas) return null;
    return {
      left: (0 - m.e) / sx - FOV_MARGIN,
      right: (ctx.canvas.width - m.e) / sx + FOV_MARGIN,
      top: (0 - m.f) / sy - FOV_MARGIN,
      bot: (ctx.canvas.height - m.f) / sy + FOV_MARGIN,
    };
  }

  /**
   * 铺种子染色的深空场（对比与色相随主题轻变，不抢玩法对比）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {BgTheme} th
   */
  function paintVoidField(ctx, rect, th) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    if (!(w > 0) || !(h > 0)) return;

    const tint = th.washTint;
    const c = th.washContrast;
    const lift = (v) => Math.max(2, Math.min(32, Math.round(v * c)));

    const g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, `rgb(${lift(7)},${lift(8)},${lift(12)})`);
    g.addColorStop(
      0.22,
      `rgb(${lift(9 + tint[0] * 0.025)},${lift(11 + tint[1] * 0.025)},${lift(16 + tint[2] * 0.03)})`
    );
    g.addColorStop(
      0.48,
      `rgb(${lift(12 + tint[0] * 0.035)},${lift(14 + tint[1] * 0.03)},${lift(20 + tint[2] * 0.035)})`
    );
    g.addColorStop(
      0.72,
      `rgb(${lift(8 + tint[0] * 0.015)},${lift(9 + tint[1] * 0.015)},${lift(14 + tint[2] * 0.02)})`
    );
    g.addColorStop(1, `rgb(${lift(4)},${lift(5)},${lift(8)})`);
    ctx.fillStyle = g;
    ctx.fillRect(left, top, w, h);

    /* 上半球主柔雾：径向渐变软边，勿用 clip */
    const haze = ctx.createRadialGradient(
      left + w * 0.42,
      top + h * 0.16,
      h * 0.04,
      left + w * 0.5,
      top + h * 0.32,
      h * 0.9
    );
    const ha = Math.min(0.14, th.hazeAlpha);
    haze.addColorStop(0, `rgba(${tint[0]},${tint[1]},${tint[2]},${ha})`);
    haze.addColorStop(
      0.45,
      `rgba(${Math.round(tint[0] * 0.72)},${Math.round(tint[1] * 0.76)},${Math.round(tint[2] * 0.82)},${ha * 0.4})`
    );
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = haze;
    ctx.fillRect(left, top, w, h);

    /* 次级侧雾：增加纵深，仍软边 */
    const side = ctx.createRadialGradient(
      left + w * (0.12 + (th.seed % 7) * 0.04),
      top + h * 0.28,
      h * 0.02,
      left + w * 0.22,
      top + h * 0.4,
      h * 0.55
    );
    const sa = ha * 0.55;
    side.addColorStop(
      0,
      `rgba(${Math.round(tint[0] * 0.85)},${Math.round(tint[1] * 0.9)},${Math.round(tint[2])},${sa})`
    );
    side.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = side;
    ctx.fillRect(left, top, w, h);

    const well = ctx.createLinearGradient(0, top + h * 0.58, 0, bot);
    well.addColorStop(0, 'rgba(0, 0, 0, 0)');
    well.addColorStop(1, `rgba(0, 0, 0,${0.36 + c * 0.12})`);
    ctx.fillStyle = well;
    ctx.fillRect(left, top + h * 0.58, w, h * 0.42);
  }

  /**
   * 画水平柔雾带（纵向渐变，边缘 alpha→0，无硬条）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   * @param {BgTheme} th
   */
  function paintHazeBands(ctx, rect, t, th) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    const op = th.opacity;

    for (let i = 0; i < hazeBands.length; i += 1) {
      const band = hazeBands[i];
      const driftY =
        Math.sin(t * 0.08 * band.speedN * th.drift + band.phase) * h * 0.012;
      const cy = top + h * band.v + driftY;
      const half = Math.max(18, h * band.heightN * 0.5);
      const rgb = th.palette[band.colorI % th.palette.length];
      const peak = Math.min(0.09, 0.035 * band.alphaN * op);

      const g = ctx.createLinearGradient(0, cy - half, 0, cy + half);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      g.addColorStop(
        0.35,
        `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak * 0.55})`
      );
      g.addColorStop(0.5, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak})`);
      g.addColorStop(
        0.65,
        `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak * 0.55})`
      );
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(left, cy - half, w, half * 2);
    }
  }

  /**
   * 画主题色丝带（条数与色随种子；略提可见度仍保持细线）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   * @param {BgTheme} th
   */
  function paintRibbons(ctx, rect, t, th) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    const rng = mulberry32(hash2(th.seed, BG_STREAM ^ 0x51));
    for (let i = 0; i < th.ribbonCount; i += 1) {
      const phase = rng() * Math.PI * 2;
      const yBase = top + h * (0.16 + rng() * 0.42);
      const amp = h * (0.012 + rng() * 0.022) * th.drift;
      const rgb = th.palette[i % th.palette.length];
      const alpha = 0.04 + th.opacity * 0.03;
      ctx.beginPath();
      const steps = 22;
      for (let s = 0; s <= steps; s += 1) {
        const u = s / steps;
        const x = left + u * w;
        const y =
          yBase +
          Math.sin(u * Math.PI * 1.4 + t * 0.2 * th.drift + phase) * amp +
          Math.sin(u * Math.PI * 0.6 - t * 0.1 * th.drift + phase * 0.4) *
            amp *
            0.45;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
      ctx.lineWidth = Math.max(1.6, h * 0.009);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  /**
   * 局部点经旋转平移到世界坐标（不用 save/restore：current path 在 drawing state 里，restore 会清空刚建的 path）。
   * @param {number} cx
   * @param {number} cy
   * @param {number} rot
   * @param {number} lx
   * @param {number} ly
   * @returns {{ x: number, y: number }}
   */
  function mapLocal(cx, cy, rot, lx, ly) {
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    };
  }

  /**
   * 构建封闭造型 path（世界坐标点）；ellipse/ring 无旋转时返回 bounds 供 ellipse()。
   * @param {string} shape
   * @param {number} cx
   * @param {number} cy
   * @param {number} rx
   * @param {number} ry
   * @param {number} rot
   * @param {{ lobe: number, phase: number, wobble: number }} spec
   * @returns {Function|{ cx: number, cy: number, rx: number, ry: number }}
   */
  function makeShapePath(shape, cx, cy, rx, ry, rot, spec) {
    if (shape === 'ellipse' || shape === 'ring') {
      if (Math.abs(rot) < 0.02) return { cx, cy, rx, ry };
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        c.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
      };
      pathFn.bounds = () => ({
        cx,
        cy,
        rx: rx * 1.05 + Math.abs(Math.sin(rot)) * ry * 0.2,
        ry: ry * 1.05 + Math.abs(Math.sin(rot)) * rx * 0.2,
      });
      return pathFn;
    }

    if (shape === 'squircle') {
      const k = 0.55;
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const p0 = mapLocal(cx, cy, rot, rx, 0);
        c.moveTo(p0.x, p0.y);
        let a = mapLocal(cx, cy, rot, rx, ry * k);
        let b = mapLocal(cx, cy, rot, rx * k, ry);
        let p = mapLocal(cx, cy, rot, 0, ry);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, -rx * k, ry);
        b = mapLocal(cx, cy, rot, -rx, ry * k);
        p = mapLocal(cx, cy, rot, -rx, 0);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, -rx, -ry * k);
        b = mapLocal(cx, cy, rot, -rx * k, -ry);
        p = mapLocal(cx, cy, rot, 0, -ry);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        a = mapLocal(cx, cy, rot, rx * k, -ry);
        b = mapLocal(cx, cy, rot, rx, -ry * k);
        p = mapLocal(cx, cy, rot, rx, 0);
        c.bezierCurveTo(a.x, a.y, b.x, b.y, p.x, p.y);
        c.closePath();
      };
      pathFn.bounds = () => ({ cx, cy, rx: rx * 1.08, ry: ry * 1.08 });
      return pathFn;
    }

    if (shape === 'diamond') {
      const soft = 0.35;
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const p0 = mapLocal(cx, cy, rot, 0, -ry);
        c.moveTo(p0.x, p0.y);
        let ctrl = mapLocal(cx, cy, rot, rx * soft, -ry * soft);
        let p = mapLocal(cx, cy, rot, rx, 0);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, rx * soft, ry * soft);
        p = mapLocal(cx, cy, rot, 0, ry);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, -rx * soft, ry * soft);
        p = mapLocal(cx, cy, rot, -rx, 0);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        ctrl = mapLocal(cx, cy, rot, -rx * soft, -ry * soft);
        p = mapLocal(cx, cy, rot, 0, -ry);
        c.quadraticCurveTo(ctrl.x, ctrl.y, p.x, p.y);
        c.closePath();
      };
      pathFn.bounds = () => ({ cx, cy, rx: rx * 1.05, ry: ry * 1.05 });
      return pathFn;
    }

    if (shape === 'petal') {
      const lobes = Math.max(2, Math.min(4, spec.lobe | 0));
      /** @param {CanvasRenderingContext2D} c */
      const pathFn = (c) => {
        const steps = 28;
        for (let s = 0; s <= steps; s += 1) {
          const a = (s / steps) * Math.PI * 2;
          const petal =
            0.72 +
            0.28 *
              Math.cos(a * lobes + spec.phase) *
              (1 - 0.35 * Math.sin(a * 0.5));
          const p = mapLocal(
            cx,
            cy,
            rot,
            Math.cos(a) * rx * petal,
            Math.sin(a) * ry * petal
          );
          if (s === 0) c.moveTo(p.x, p.y);
          else c.lineTo(p.x, p.y);
        }
        c.closePath();
      };
      pathFn.bounds = () => ({ cx, cy, rx: rx * 1.12, ry: ry * 1.12 });
      return pathFn;
    }

    /* blob：低频径向起伏 */
    /** @param {CanvasRenderingContext2D} c */
    const pathFn = (c) => {
      const steps = 26;
      const lobes = Math.max(2, Math.min(5, spec.lobe | 0));
      for (let s = 0; s <= steps; s += 1) {
        const a = (s / steps) * Math.PI * 2;
        const wob =
          1 +
          spec.wobble * Math.sin(a * lobes + spec.phase) +
          spec.wobble *
            0.45 *
            Math.sin(a * (lobes + 1) - spec.phase * 0.7);
        const p = mapLocal(
          cx,
          cy,
          rot,
          Math.cos(a) * rx * wob,
          Math.sin(a) * ry * wob
        );
        if (s === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      }
      c.closePath();
    };
    pathFn.bounds = () => ({
      cx,
      cy,
      rx: rx * (1 + spec.wobble * 1.2),
      ry: ry * (1 + spec.wobble * 1.2),
    });
    return pathFn;
  }

  /**
   * 用径向渐变把当前封闭 path 填成柔边光晕（边缘 alpha→0，避免硬轮廓块）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx
   * @param {number} cy
   * @param {number} rx
   * @param {number} ry
   * @param {number[]} rgb
   * @param {number} peakAlpha
   */
  function fillSoftGlow(ctx, cx, cy, rx, ry, rgb, peakAlpha) {
    const rMax = Math.max(rx, ry) * 1.05;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rMax);
    const a0 = Math.max(0, Math.min(0.24, peakAlpha));
    g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0})`);
    g.addColorStop(
      0.42,
      `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0 * 0.42})`
    );
    g.addColorStop(
      0.72,
      `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0 * 0.12})`
    );
    g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
    ctx.fillStyle = g;
    ctx.fill();
  }

  /**
   * 画一层带视差漂移的柔光造型（远景更慢更大 / 中景更密更小）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   * @param {BgTheme} th
   * @param {(BubbleSpec|FarSpec)[]} specs
   * @param {{ peakMul: number, strokeMul: number, driftScale: number }} style
   */
  function paintGlowShapes(ctx, rect, t, th, specs, style) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    const op = th.opacity;

    for (let i = 0; i < specs.length; i += 1) {
      const spec = specs[i];
      const px = spec.parallax;
      const baseX = left + ((spec.u + spec.v * 0.12) % 1) * w;
      const baseY = top + h * spec.v;
      const driftX =
        Math.sin(t * (0.05 + spec.speedN * 0.04) * th.drift + spec.phase) *
        w *
        0.014 *
        th.drift *
        px *
        style.driftScale;
      const driftY =
        Math.cos(t * (0.04 + spec.speedN * 0.03) * th.drift + spec.phase * 1.3) *
        h *
        0.011 *
        th.drift *
        px *
        style.driftScale;
      const cx = baseX + driftX;
      const cy = baseY + driftY;
      const rx = Math.max(14, h * spec.sizeN);
      const ry = Math.max(12, rx * spec.aspect);
      /* 视口外跳过（含柔边外延） */
      if (
        cx + rx < left ||
        cx - rx > right ||
        cy + ry < top ||
        cy - ry > bot
      ) {
        continue;
      }
      const pathOrBounds = makeShapePath(
        spec.shape,
        cx,
        cy,
        rx,
        ry,
        spec.rot,
        spec
      );
      const rgb = th.palette[spec.colorI % th.palette.length];
      const isRing = spec.shape === 'ring';
      const peakAlpha =
        (isRing ? 0.065 : 0.11) * Math.min(1.25, op) * style.peakMul;
      const strokeAlpha =
        (isRing ? 0.1 : 0.05) * Math.min(1.2, op) * style.strokeMul;

      ctx.beginPath();
      if (typeof pathOrBounds === 'function') {
        pathOrBounds(ctx);
      } else {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      }

      if (isRing) {
        ctx.ellipse(cx, cy, rx * 0.52, ry * 0.52, spec.rot, 0, Math.PI * 2);
        const g = ctx.createRadialGradient(
          cx,
          cy,
          Math.min(rx, ry) * 0.35,
          cx,
          cy,
          Math.max(rx, ry) * 1.05
        );
        g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        g.addColorStop(
          0.45,
          `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peakAlpha})`
        );
        g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        ctx.fillStyle = g;
        ctx.fill('evenodd');
      } else {
        fillSoftGlow(ctx, cx, cy, rx, ry, rgb, peakAlpha);
      }

      ctx.beginPath();
      if (typeof pathOrBounds === 'function') {
        pathOrBounds(ctx);
      } else {
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      }
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${strokeAlpha})`;
      ctx.lineWidth = Math.max(1.1, rx * (isRing ? 0.05 : 0.026));
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  }

  /**
   * 画细微尘星（软点 + 慢闪烁 + 轻视差，不抢前景可读性）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   * @param {BgTheme} th
   */
  function paintDust(ctx, rect, t, th) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    const op = th.opacity;
    const q = qualityFactor();
    const useSolid = q < 0.7;

    for (let i = 0; i < dust.length; i += 1) {
      const d = dust[i];
      const px = d.parallax;
      const driftX =
        Math.sin(t * 0.06 * d.speedN * th.drift + d.phase) *
        w *
        0.018 *
        px;
      const driftY =
        Math.cos(t * 0.045 * d.speedN * th.drift + d.phase * 1.7) *
        h *
        0.01 *
        px;
      const cx = left + d.u * w + driftX;
      const cy = top + d.v * h + driftY;
      const r = Math.max(0.8, h * d.sizeN);
      if (cx + r * 2.2 < left || cx - r * 2.2 > right || cy + r * 2.2 < top || cy - r * 2.2 > bot) {
        continue;
      }
      const tw =
        0.55 +
        0.45 * Math.sin(t * (0.7 + d.twinkle) + d.phase) * d.twinkle;
      const rgb = th.palette[d.colorI % th.palette.length];
      const peak = Math.min(0.2, 0.07 * op * tw);

      if (useSolid) {
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak})`;
        ctx.beginPath();
        ctx.arc(cx, cy, r * 1.2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak})`);
      g.addColorStop(
        0.45,
        `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${peak * 0.35})`
      );
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, r * 2.2, r * 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * 在世界变换下绘制背景（须在 LpTrack / 车厢之前调用）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!ctx) return;
    ensureTheme();
    if (!theme) return;
    const rect = viewRectFromTransform(ctx);
    if (!rect) return;
    if (!(timeSec > 0)) timeSec = performance.now() * 0.001;
    const t = timeSec;

    ctx.save();
    paintVoidField(ctx, rect, theme);
    paintHazeBands(ctx, rect, t, theme);
    paintGlowShapes(ctx, rect, t, theme, farShapes, {
      peakMul: 0.72,
      strokeMul: 0.55,
      driftScale: 0.7,
    });
    paintRibbons(ctx, rect, t, theme);
    paintDust(ctx, rect, t, theme);
    paintGlowShapes(ctx, rect, t, theme, bubbles, {
      peakMul: 1,
      strokeMul: 1,
      driftScale: 1,
    });
    ctx.restore();
  }

  window.LpWorldBackground = {
    tick,
    draw,
    setSeed,
    getSeed,
    /** @deprecated 调试用；主题重建后才有意义 */
    getTheme: () => theme,
  };
})();
