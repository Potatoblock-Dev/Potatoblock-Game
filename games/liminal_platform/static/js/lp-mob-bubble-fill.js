/**
 * 怪体内半透明彩色泡泡 + 蒙版流动填充，以及轮廓流动描边。
 * 填充：离屏先 source-over 画洗/色带/泡泡，再 destination-in 白剪影裁形（避免 source-in 连乘把 alpha 乘没），边缘再羽化。
 * 描边：离屏白描边蒙版 + source-in 色带；paintFlowSheet 在 source-in 下首层后改 source-atop。
 * 禁止用 soft-light 铺色带（透明底上≈整矩形，会露出 AABB 彩虹方块）。
 */
(() => {
  /** 单区默认泡泡数。 */
  const DEFAULT_COUNT = 8;
  /** 单区上限，避免多部位叠画爆帧。 */
  const MAX_COUNT = 12;
  /** 底色洗白默认透明度。 */
  const DEFAULT_BASE_ALPHA = 0.05;
  /** 流动色带默认透明度（蒙版层整体）。 */
  const DEFAULT_FLOW_ALPHA = 0.42;
  /** 泡泡主体默认透明度下限 / 脉冲幅度。 */
  const DEFAULT_BUBBLE_ALPHA = 0.16;
  const DEFAULT_BUBBLE_PULSE = 0.12;
  /** 流动描边默认透明度。 */
  const DEFAULT_OUTLINE_ALPHA = 0.92;
  /** 调色盘：高饱和色停。 */
  const PALETTE = [
    [255, 99, 132],
    [255, 206, 86],
    [72, 219, 151],
    [77, 150, 255],
    [199, 125, 255],
    [255, 143, 171],
    [56, 224, 220],
    [255, 159, 67],
  ];

  /** 共享动画时间（秒）。 */
  let timeSec = 0;
  let framed = false;

  /** 填充用离屏缓冲（复用，按需放大）。 */
  let fillScratch = null;
  let fillScratchCtx = null;
  /** 描边用离屏缓冲（与填充分离，避免同帧互相清掉）。 */
  let outlineScratch = null;
  let outlineScratchCtx = null;
  /** 流动色带缓存（同 seed/时间桶复用，fill+stroke 共享）。 */
  let flowSheet = null;
  let flowSheetCtx = null;
  let flowSheetKey = '';

  /** @type {MediaQueryList|null} */
  let coarseMq = null;

  /**
   * 质量档：1 桌面；&lt;1 触控/低 DPR 时少泡泡、简化色带。
   * @returns {number}
   */
  function qualityFactor() {
    if (!coarseMq) {
      coarseMq = window.matchMedia('(pointer: coarse)');
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (coarseMq.matches && dpr < 1.5) return 0.5;
    if (coarseMq.matches) return 0.65;
    if (dpr < 1.25) return 0.8;
    return 1;
  }

  /**
   * 从当前世界变换求可见矩形（世界像素）；失败返回 null。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} [margin]
   */
  function viewRectFromTransform(ctx, margin = 24) {
    try {
      const m = ctx.getTransform();
      const sx = m.a;
      const sy = m.d;
      if (!(sx > 0) || !(sy > 0) || !ctx.canvas) return null;
      return {
        left: (0 - m.e) / sx - margin,
        right: (ctx.canvas.width - m.e) / sx + margin,
        top: (0 - m.f) / sy - margin,
        bot: (ctx.canvas.height - m.f) / sy + margin,
      };
    } catch {
      return null;
    }
  }

  /**
   * AABB 是否与可视矩形相交。
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} ox
   * @param {number} oy
   * @param {number} w
   * @param {number} h
   */
  function aabbVisible(rect, ox, oy, w, h) {
    return !(ox + w < rect.left || ox > rect.right || oy + h < rect.top || oy > rect.bot);
  }

  /**
   * 稳定哈希：把种子与序号压成 (0,1) 浮点。
   * @param {string|number} seed
   * @param {number} i
   */
  function hash01(seed, i) {
    const s = String(seed);
    let h = (i * 374761393 + 668265263) | 0;
    for (let k = 0; k < s.length; k += 1) {
      h = Math.imul(h ^ s.charCodeAt(k), 0x5bd1e995);
      h = (h ^ (h >>> 13)) | 0;
    }
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /**
   * 每帧调用一次：推进共享时钟（dt 秒）。
   * @param {number} [dt]
   */
  function beginFrame(dt) {
    if (Number.isFinite(dt) && dt > 0) {
      timeSec += Math.min(0.05, dt);
    } else {
      timeSec = performance.now() * 0.001;
    }
    framed = true;
  }

  /** @returns {number} */
  function nowSec() {
    if (!framed) return performance.now() * 0.001;
    return timeSec;
  }

  /**
   * 取够大的离屏画布（填充 / 描边分池）。
   * @param {number} w
   * @param {number} h
   * @param {'fill'|'outline'} [kind]
   */
  function ensureScratch(w, h, kind = 'fill') {
    const cw = Math.max(1, Math.ceil(w));
    const ch = Math.max(1, Math.ceil(h));
    const isOutline = kind === 'outline';
    let scratch = isOutline ? outlineScratch : fillScratch;
    let scratchCtx = isOutline ? outlineScratchCtx : fillScratchCtx;
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratchCtx = scratch.getContext('2d', { willReadFrequently: false });
      if (isOutline) {
        outlineScratch = scratch;
        outlineScratchCtx = scratchCtx;
      } else {
        fillScratch = scratch;
        fillScratchCtx = scratchCtx;
      }
    }
    if (scratch.width < cw || scratch.height < ch) {
      scratch.width = cw;
      scratch.height = ch;
      scratchCtx = scratch.getContext('2d', { willReadFrequently: false });
      if (isOutline) outlineScratchCtx = scratchCtx;
      else fillScratchCtx = scratchCtx;
    }
    return { canvas: scratch, ctx: scratchCtx, w: cw, h: ch };
  }

  /**
   * 从 pathFn 或椭圆 bounds 解析包围盒。
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   */
  function resolveBounds(pathOrBounds) {
    if (typeof pathOrBounds === 'function') {
      const b = typeof pathOrBounds.bounds === 'function' ? pathOrBounds.bounds() : null;
      if (b && b.rx > 0 && b.ry > 0) return b;
      return null;
    }
    const cx = pathOrBounds.cx;
    const cy = pathOrBounds.cy;
    const rx = Math.max(0.5, pathOrBounds.rx);
    const ry = Math.max(0.5, pathOrBounds.ry != null ? pathOrBounds.ry : rx);
    return { cx, cy, rx, ry };
  }

  /**
   * 在任意 ctx 上按包围盒铺滚动彩虹色带（供 clip / destination-in / source-in 蒙版裁切）。
   * 若调用方处于 source-in：仅首层用 source-in 写入蒙版，后续改 source-atop，避免多层 fill 把 alpha 连乘近 0。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ cx: number, cy: number, rx: number, ry: number }} box
   * @param {string} key
   * @param {number} t
   * @param {number} alpha 整体透明度 0–1
   * @param {number[][]} palette
   * @param {number} [speed]
   */
  function paintFlowSheet(ctx, box, key, t, alpha, palette, speed = 1.1) {
    const q = qualityFactor();
    const { cx, cy, rx, ry } = box;
    const pad = Math.max(rx, ry) * 0.35;
    const left = cx - rx - pad;
    const top = cy - ry - pad;
    const width = (rx + pad) * 2;
    const height = (ry + pad) * 2;
    const n = Math.max(4, Math.min(palette.length, q < 0.7 ? 5 : 7));
    const drift = (t * speed * 0.55 + hash01(key, 2)) % 1;
    const angle = hash01(key, 5) * Math.PI * 0.35 + t * speed * 0.22;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const span = Math.hypot(width, height) * 0.55;
    const a = Math.max(0, Math.min(1, alpha));

    /**
     * 把相位滚动的色停写入渐变：只平移 u，色盘按 key+i 固定，避免 phase 进 hash 后 |0 阶跃换色闪烁。
     * @param {CanvasGradient} g
     * @param {number} phase
     */
    function addCyclingStops(g, phase) {
      /** @type {{ u: number, rgb: number[] }[]} */
      const stops = [];
      for (let i = 0; i < n; i += 1) {
        const u = (i / (n - 1) + phase) % 1;
        const rgb =
          palette[(i + Math.floor(hash01(key, i + 11) * palette.length)) % palette.length];
        stops.push({ u, rgb });
      }
      stops.sort((a, b) => a.u - b.u);
      let lastU = -1;
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first.u > 0.001) {
        g.addColorStop(0, `rgb(${last.rgb[0]},${last.rgb[1]},${last.rgb[2]})`);
        lastU = 0;
      }
      for (const s of stops) {
        const u = Math.min(1, Math.max(0, s.u));
        if (u <= lastU + 1e-4) continue;
        g.addColorStop(u, `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`);
        lastU = u;
      }
      if (lastU < 0.999) {
        g.addColorStop(1, `rgb(${first.rgb[0]},${first.rgb[1]},${first.rgb[2]})`);
      }
    }

    ctx.save();
    const underSourceIn = ctx.globalCompositeOperation === 'source-in';
    ctx.globalAlpha = a;

    const g1 = ctx.createLinearGradient(
      cx - cos * span,
      cy - sin * span,
      cx + cos * span,
      cy + sin * span
    );
    addCyclingStops(g1, drift);
    ctx.fillStyle = g1;
    ctx.fillRect(left, top, width, height);

    /* 低质量：单层色带即可，省第二线性 + 径向 */
    if (q < 0.7) {
      ctx.restore();
      return;
    }

    /* source-in 只用于首层；后续叠层改 source-atop，否则 As*=Ad 会把蒙版 alpha 乘没 */
    if (underSourceIn) {
      ctx.globalCompositeOperation = 'source-atop';
    }

    const angle2 = angle + Math.PI * 0.5;
    const cos2 = Math.cos(angle2);
    const sin2 = Math.sin(angle2);
    const g2 = ctx.createLinearGradient(
      cx - cos2 * span * 0.85,
      cy - sin2 * span * 0.85,
      cx + cos2 * span * 0.85,
      cy + sin2 * span * 0.85
    );
    addCyclingStops(g2, (drift * 1.7 + 0.33) % 1);
    ctx.globalAlpha = a * 0.48;
    ctx.fillStyle = g2;
    ctx.fillRect(left, top, width, height);

    if (q >= 0.95) {
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry) * 1.05);
      rg.addColorStop(0, 'rgba(255,255,255,0.28)');
      rg.addColorStop(0.55, 'rgba(255,255,255,0.06)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = a * 0.7;
      ctx.fillStyle = rg;
      ctx.fillRect(left, top, width, height);
    }

    ctx.restore();
  }

  /**
   * 取缓存的流动色带图（世界无关局部坐标）；同 seed/时间桶复用。
   * @param {{ cx: number, cy: number, rx: number, ry: number }} box
   * @param {string} key
   * @param {number} t
   * @param {number[][]} palette
   * @param {number} speed
   * @returns {{ canvas: HTMLCanvasElement, dim: number } | null}
   */
  function getCachedFlowSheet(box, key, t, palette, speed) {
    const q = qualityFactor();
    const dim = Math.max(8, Math.ceil(Math.max(box.rx, box.ry) * 2.5));
    const tBucket = Math.floor(t * (q < 0.7 ? 10 : 20));
    const cacheKey = `${dim}|${key}|${tBucket}|${q.toFixed(2)}|${speed}`;
    if (!flowSheet) {
      flowSheet = document.createElement('canvas');
      flowSheetCtx = flowSheet.getContext('2d', { willReadFrequently: false });
    }
    if (flowSheet.width < dim || flowSheet.height < dim) {
      flowSheet.width = dim;
      flowSheet.height = dim;
      flowSheetCtx = flowSheet.getContext('2d', { willReadFrequently: false });
    }
    if (flowSheetKey === cacheKey) {
      return { canvas: flowSheet, dim };
    }
    const fctx = flowSheetCtx;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.globalAlpha = 1;
    fctx.clearRect(0, 0, dim, dim);
    const localBox = { cx: dim * 0.5, cy: dim * 0.5, rx: box.rx, ry: box.ry };
    paintFlowSheet(fctx, localBox, key, t, 1, palette, speed);
    flowSheetKey = cacheKey;
    return { canvas: flowSheet, dim };
  }

  /**
   * 在封闭区内：底洗 + 流动色带 + 彩色泡泡；离屏绘制后 destination-in 裁成剪影。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @param {number} [_dt]
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function drawBubbleFill(ctx, pathOrBounds, _dt, seed, opts = {}) {
    if (!ctx || pathOrBounds == null) return;
    const key = String(seed);
    const t = nowSec();
    const q = qualityFactor();
    const count = Math.max(
      1,
      Math.min(
        MAX_COUNT,
        Math.floor(
          (opts.count != null ? Math.floor(opts.count) : DEFAULT_COUNT) * q
        )
      )
    );
    const baseAlpha = opts.alpha != null ? opts.alpha : DEFAULT_BASE_ALPHA;
    const flowAlpha = opts.flowAlpha != null ? opts.flowAlpha : DEFAULT_FLOW_ALPHA;
    const bubbleAlpha =
      opts.bubbleAlpha != null ? opts.bubbleAlpha : DEFAULT_BUBBLE_ALPHA;
    const bubblePulse =
      opts.bubblePulse != null ? opts.bubblePulse : DEFAULT_BUBBLE_PULSE;
    const palette =
      opts.palette && opts.palette.length ? opts.palette : PALETTE;
    const speed = opts.speed != null ? opts.speed : 1.05;

    const box = resolveBounds(pathOrBounds);
    if (!box) return;

    const { cx, cy, rx, ry } = box;
    const softPad = Math.max(2, Math.min(rx, ry) * 0.08);
    const w = rx * 2 + softPad * 2;
    const h = ry * 2 + softPad * 2;
    const ox = cx - rx - softPad;
    const oy = cy - ry - softPad;

    const view = viewRectFromTransform(ctx);
    if (view && !aabbVisible(view, ox, oy, w, h)) return;

    const { canvas: sc, ctx: sctx, w: cw, h: ch } = ensureScratch(w, h, 'fill');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, cw, ch);

    sctx.save();
    sctx.translate(-ox, -oy);

    /* 1) source-over 画内容（可先溢出 AABB；半透明层正常叠加） */
    sctx.globalCompositeOperation = 'source-over';
    if (opts.base) {
      sctx.fillStyle = opts.base;
      sctx.fillRect(cx - rx - softPad, cy - ry - softPad, w, h);
    }
    sctx.fillStyle = `rgba(255, 248, 240, ${baseAlpha})`;
    sctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);

    const flow = getCachedFlowSheet(box, key, t, palette, speed);
    if (flow) {
      const dim = flow.dim;
      const pad = Math.max(box.rx, box.ry) * 0.35;
      const fl = box.cx - box.rx - pad;
      const ft = box.cy - box.ry - pad;
      const fw = (box.rx + pad) * 2;
      const fh = (box.ry + pad) * 2;
      sctx.globalAlpha = flowAlpha;
      sctx.drawImage(flow.canvas, 0, 0, dim, dim, fl, ft, fw, fh);
      sctx.globalAlpha = 1;
    } else {
      paintFlowSheet(sctx, box, key, t, flowAlpha, palette, speed);
    }

    for (let i = 0; i < count; i += 1) {
      const a = hash01(key, i);
      const b = hash01(key, i + 17);
      const c = hash01(key, i + 41);
      const drift = (t * (0.4 + a * 0.5) + b) % 1;
      const localY = (1 - drift * 2) * 0.72 + Math.sin(t * 1.15 + i) * 0.06;
      const localX =
        Math.cos((b + t * 0.08) * Math.PI * 2) *
          (0.2 + c * 0.55) *
          (0.55 + 0.45 * (1 - Math.abs(localY))) +
        Math.sin(t * (0.9 + a) + b * 8) * 0.08;
      const px = cx + localX * rx;
      const py = cy + localY * ry;
      const size = Math.max(1.2, Math.min(rx, ry) * (0.09 + a * 0.14));
      const rgb = palette[(Math.floor(a * palette.length) + i) % palette.length];
      const pulse = 0.55 + 0.35 * Math.sin(t * (2.2 + b) + i);
      sctx.beginPath();
      sctx.arc(px, py, size * (0.75 + 0.25 * pulse), 0, Math.PI * 2);
      sctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${bubbleAlpha + bubblePulse * pulse})`;
      sctx.fill();
      if (q >= 0.7) {
        sctx.beginPath();
        sctx.arc(px - size * 0.28, py - size * 0.28, size * 0.28, 0, Math.PI * 2);
        sctx.fillStyle = `rgba(255,255,255,${0.2 * pulse})`;
        sctx.fill();
      }
    }

    /* 2) destination-in 白剪影：裁掉形外，避免 AABB 彩虹方块 */
    sctx.globalCompositeOperation = 'destination-in';
    buildOutlinePath(sctx, pathOrBounds, box);
    sctx.fillStyle = '#ffffff';
    sctx.fill();

    /* 3) 边缘轻微羽化（离屏；按椭圆缩放，避免拉长体被圆径向误切） */
    if (q >= 0.65) {
      const rim = Math.max(rx, ry);
      const feather = Math.max(1.2, Math.min(rx, ry) * 0.12);
      sctx.globalCompositeOperation = 'destination-in';
      sctx.save();
      sctx.translate(cx, cy);
      sctx.scale(rx / rim, ry / rim);
      const soft = sctx.createRadialGradient(0, 0, Math.max(0.5, rim - feather), 0, 0, rim * 1.02);
      soft.addColorStop(0, 'rgba(0,0,0,1)');
      soft.addColorStop(0.82, 'rgba(0,0,0,1)');
      soft.addColorStop(1, 'rgba(0,0,0,0)');
      sctx.fillStyle = soft;
      sctx.beginPath();
      sctx.arc(0, 0, rim * 1.02, 0, Math.PI * 2);
      sctx.fill();
      sctx.restore();
    }

    sctx.restore();

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.drawImage(sc, 0, 0, cw, ch, ox, oy, w, h);
    ctx.restore();
  }

  /**
   * 构建路径（椭圆或 pathFn）到给定 ctx。
   * @param {CanvasRenderingContext2D} c
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @param {{ cx: number, cy: number, rx: number, ry: number }} box
   */
  function buildOutlinePath(c, pathOrBounds, box) {
    c.beginPath();
    if (typeof pathOrBounds === 'function') {
      pathOrBounds(c);
    } else {
      c.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
    }
  }

  /**
   * 沿封闭轮廓描流动彩虹（离屏白描边蒙版 + source-in 色带；色带内多层走 source-atop）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function strokeFlowingOutline(ctx, pathOrBounds, seed, opts = {}) {
    if (!ctx || pathOrBounds == null) return;
    const key = String(seed);
    const t = nowSec();
    const palette =
      opts.palette && opts.palette.length ? opts.palette : PALETTE;
    const alpha = opts.alpha != null ? opts.alpha : DEFAULT_OUTLINE_ALPHA;
    const speed = opts.speed != null ? opts.speed : 1.2;
    const lineWidth = opts.lineWidth != null ? opts.lineWidth : 2;
    const box = resolveBounds(pathOrBounds) || opts.bounds || null;
    if (!box) return;

    const pad = Math.ceil(lineWidth * 2.5 + 4);
    const w = box.rx * 2 + pad * 2;
    const h = box.ry * 2 + pad * 2;
    const ox = box.cx - box.rx - pad;
    const oy = box.cy - box.ry - pad;

    const view = viewRectFromTransform(ctx);
    if (view && !aabbVisible(view, ox, oy, w, h)) return;

    const { canvas: sc, ctx: sctx, w: cw, h: ch } = ensureScratch(w, h, 'outline');
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    sctx.globalAlpha = 1;
    sctx.clearRect(0, 0, cw, ch);

    sctx.save();
    sctx.translate(-ox, -oy);

    /* 1) 白描边作 alpha 蒙版 */
    buildOutlinePath(sctx, pathOrBounds, box);
    sctx.lineWidth = lineWidth;
    sctx.lineJoin = 'round';
    sctx.lineCap = 'round';
    sctx.strokeStyle = '#ffffff';
    sctx.stroke();

    /* 外圈淡光蒙版（更粗、半透明）；低质量跳过 */
    if (qualityFactor() >= 0.7) {
      buildOutlinePath(sctx, pathOrBounds, box);
      sctx.lineWidth = lineWidth * 2.1;
      sctx.strokeStyle = 'rgba(255,255,255,0.35)';
      sctx.stroke();
    }

    /* 2) source-in：色带只留在描边像素 */
    sctx.globalCompositeOperation = 'source-in';
    const flow = getCachedFlowSheet(box, key, t, palette, speed);
    if (flow) {
      const dim = flow.dim;
      const fpad = Math.max(box.rx, box.ry) * 0.35;
      const fl = box.cx - box.rx - fpad;
      const ft = box.cy - box.ry - fpad;
      const fw = (box.rx + fpad) * 2;
      const fh = (box.ry + fpad) * 2;
      sctx.drawImage(flow.canvas, 0, 0, dim, dim, fl, ft, fw, fh);
    } else {
      paintFlowSheet(sctx, box, key, t, 1, palette, speed);
    }
    sctx.restore();

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(sc, 0, 0, cw, ch, ox, oy, w, h);
    ctx.restore();
  }

  /**
   * 圆形封闭区便捷填充。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function fillCircle(ctx, x, y, r, seed, opts = {}) {
    if (!(r > 0)) return;
    drawBubbleFill(ctx, { cx: x, cy: y, rx: r, ry: r }, 0, seed, opts);
  }

  /**
   * 椭圆封闭区便捷填充。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} rx
   * @param {number} ry
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function fillEllipse(ctx, x, y, rx, ry, seed, opts = {}) {
    if (!(rx > 0) || !(ry > 0)) return;
    drawBubbleFill(ctx, { cx: x, cy: y, rx, ry }, 0, seed, opts);
  }

  /**
   * 任意封闭 path 便捷填充。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function} pathFn
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function fillPath(ctx, pathFn, seed, opts = {}) {
    if (typeof pathFn !== 'function') return;
    drawBubbleFill(ctx, pathFn, 0, seed, opts);
  }

  /**
   * 圆形流动描边便捷方法。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {string|number} seed
   * @param {object} [opts]
   */
  function strokeFlowingCircle(ctx, x, y, r, seed, opts = {}) {
    if (!(r > 0)) return;
    strokeFlowingOutline(ctx, { cx: x, cy: y, rx: r, ry: r }, seed, opts);
  }

  /** 清空时钟，并释放离屏缓冲（场景切换 / reset 时回收 canvas 位图）。 */
  function reset() {
    timeSec = 0;
    framed = false;
    if (fillScratch) {
      fillScratch.width = 0;
      fillScratch.height = 0;
    }
    if (outlineScratch) {
      outlineScratch.width = 0;
      outlineScratch.height = 0;
    }
    if (flowSheet) {
      flowSheet.width = 0;
      flowSheet.height = 0;
    }
    fillScratch = null;
    fillScratchCtx = null;
    outlineScratch = null;
    outlineScratchCtx = null;
    flowSheet = null;
    flowSheetCtx = null;
    flowSheetKey = '';
  }

  window.LpMobBubbleFill = {
    beginFrame,
    /** @deprecated 同 beginFrame */
    sync: beginFrame,
    drawBubbleFill,
    fillCircle,
    fillEllipse,
    fillPath,
    strokeFlowingOutline,
    strokeFlowingCircle,
    reset,
    PALETTE,
    DEFAULT_BASE_ALPHA,
    DEFAULT_FLOW_ALPHA,
    DEFAULT_BUBBLE_ALPHA,
    DEFAULT_OUTLINE_ALPHA,
  };
})();
