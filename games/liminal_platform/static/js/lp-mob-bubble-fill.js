/**
 * 怪体内封闭区半透明彩色泡泡 + 液态流动填充（Canvas clip），
 * 以及封闭轮廓的流动彩虹描边。供 LpMobs 等调用；共享帧时钟、种子驱动。
 */
(() => {
  /** 单区默认泡泡数。 */
  const DEFAULT_COUNT = 8;
  /** 单区上限，避免多部位叠画爆帧。 */
  const MAX_COUNT = 12;
  /** 流动色带条数。 */
  const FLOW_BANDS = 3;
  /** 底色洗白默认透明度（半透明，不盖住轮廓）。 */
  const DEFAULT_BASE_ALPHA = 0.06;
  /** 流动色带默认透明度。 */
  const DEFAULT_FLOW_ALPHA = 0.08;
  /** 泡泡主体默认透明度下限 / 脉冲幅度。 */
  const DEFAULT_BUBBLE_ALPHA = 0.2;
  const DEFAULT_BUBBLE_PULSE = 0.16;
  /** 流动描边默认透明度。 */
  const DEFAULT_OUTLINE_ALPHA = 0.88;
  /** 调色盘：高饱和小圆点 / 描边色停。 */
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

  /** 共享动画时间（秒）；每帧 beginFrame 推进一次。 */
  let timeSec = 0;
  /** 本帧是否已 beginFrame。 */
  let framed = false;

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
   * 每帧调用一次：推进共享时钟（dt 秒）；未调用时 draw 用 performance 推算。
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

  /**
   * 当前动画时间；若本帧未 beginFrame 则回退到 performance。
   * @returns {number}
   */
  function nowSec() {
    if (!framed) return performance.now() * 0.001;
    return timeSec;
  }

  /**
   * 在包围盒内画半透明流动色带（液态感）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} cx
   * @param {number} cy
   * @param {number} rx
   * @param {number} ry
   * @param {string} key
   * @param {number} t
   * @param {number} flowAlpha
   * @param {number[][]} palette
   */
  function paintFlowBands(ctx, cx, cy, rx, ry, key, t, flowAlpha, palette) {
    for (let i = 0; i < FLOW_BANDS; i += 1) {
      const phase = hash01(key, i + 90) * Math.PI * 2;
      const amp = ry * (0.1 + hash01(key, i + 100) * 0.16);
      const y0 = cy - ry * 0.7 + ((i + 0.5) / FLOW_BANDS) * ry * 1.4;
      const rgb = palette[(i + Math.floor(hash01(key, i) * 3)) % palette.length];
      ctx.beginPath();
      const steps = 10;
      for (let s = 0; s <= steps; s += 1) {
        const u = s / steps;
        const x = cx - rx + u * rx * 2;
        const y =
          y0 +
          Math.sin(u * Math.PI * 2.1 + t * 1.35 + phase) * amp +
          Math.sin(u * Math.PI * 1.05 - t * 0.85 + phase * 0.5) * amp * 0.4;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let s = steps; s >= 0; s -= 1) {
        const u = s / steps;
        const x = cx - rx + u * rx * 2;
        const y =
          y0 +
          ry * 0.2 +
          Math.sin(u * Math.PI * 2.1 + t * 1.35 + phase + 0.7) * amp * 0.65;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${flowAlpha})`;
      ctx.fill();
    }
  }

  /**
   * 从 pathFn 或椭圆 bounds 解析裁剪区与近似包围盒（不 clip）。
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @returns {{ cx: number, cy: number, rx: number, ry: number } | null}
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
   * 从 pathFn 或椭圆 bounds 解析裁剪区与近似包围盒并 clip。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @returns {{ cx: number, cy: number, rx: number, ry: number } | null}
   */
  function beginClip(ctx, pathOrBounds) {
    ctx.beginPath();
    if (typeof pathOrBounds === 'function') {
      pathOrBounds(ctx);
      const b = resolveBounds(pathOrBounds);
      ctx.clip();
      return b;
    }
    const box = resolveBounds(pathOrBounds);
    if (!box) return null;
    ctx.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
    ctx.clip();
    return box;
  }

  /**
   * 沿包围盒构造随时间旋转的彩虹线性渐变（色停严格递增，供描边）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ cx: number, cy: number, rx: number, ry: number }} box
   * @param {string} key
   * @param {number} t
   * @param {number[][]} palette
   * @param {number} alpha
   * @param {number} speed
   * @returns {CanvasGradient}
   */
  function flowingOutlineGradient(ctx, box, key, t, palette, alpha, speed) {
    const angle = t * speed + hash01(key, 3) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { cx, cy, rx, ry } = box;
    const g = ctx.createLinearGradient(
      cx + cos * rx,
      cy + sin * ry,
      cx - cos * rx,
      cy - sin * ry
    );
    const n = Math.max(3, Math.min(palette.length, 6));
    const drift = (t * speed * 0.35 + hash01(key, 7)) % 1;
    /** @type {{ u: number, rgba: string }[]} */
    const stops = [];
    for (let i = 0; i < n; i += 1) {
      const u = (i / (n - 1) + drift) % 1;
      const rgb =
        palette[(i + Math.floor(hash01(key, i + 11) * palette.length)) % palette.length];
      stops.push({ u, rgba: `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})` });
    }
    stops.sort((a, b) => a.u - b.u);
    // 去重同偏移；0/1 端点用对端色衔接，保持循环流动感。
    let lastU = -1;
    if (stops[0].u > 0.001) {
      g.addColorStop(0, stops[stops.length - 1].rgba);
      lastU = 0;
    }
    for (const s of stops) {
      const u = Math.min(1, Math.max(0, s.u));
      if (u <= lastU + 1e-4) continue;
      g.addColorStop(u, s.rgba);
      lastU = u;
    }
    if (lastU < 0.999) {
      g.addColorStop(1, stops[0].rgba);
    }
    return g;
  }

  /**
   * 在封闭区内画半透明底洗 + 流动色带 + 彩色泡泡（clip 到 path / 椭圆）。
   * 默认不铺不透明实色；opts.base 若传入实色会盖住泡泡感，调用方宜省略或传 rgba。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   *   pathFn 可挂 `.bounds()` 返回 {cx,cy,rx,ry} 供粒子散布。
   * @param {number} [_dt] 保留兼容；实际用 beginFrame 共享时钟
   * @param {string|number} seed 稳定种子（建议 mobId + 部位名）
   * @param {{
   *   count?: number,
   *   base?: string,
   *   alpha?: number,
   *   flowAlpha?: number,
   *   bubbleAlpha?: number,
   *   bubblePulse?: number,
   *   palette?: number[][]
   * }} [opts]
   */
  function drawBubbleFill(ctx, pathOrBounds, _dt, seed, opts = {}) {
    if (!ctx || pathOrBounds == null) return;
    const key = String(seed);
    const t = nowSec();
    const count = Math.max(
      1,
      Math.min(MAX_COUNT, opts.count != null ? Math.floor(opts.count) : DEFAULT_COUNT)
    );
    const baseAlpha = opts.alpha != null ? opts.alpha : DEFAULT_BASE_ALPHA;
    const flowAlpha = opts.flowAlpha != null ? opts.flowAlpha : DEFAULT_FLOW_ALPHA;
    const bubbleAlpha =
      opts.bubbleAlpha != null ? opts.bubbleAlpha : DEFAULT_BUBBLE_ALPHA;
    const bubblePulse =
      opts.bubblePulse != null ? opts.bubblePulse : DEFAULT_BUBBLE_PULSE;
    const palette =
      opts.palette && opts.palette.length ? opts.palette : PALETTE;

    ctx.save();
    const box = beginClip(ctx, pathOrBounds);

    if (opts.base) {
      ctx.fillStyle = opts.base;
      ctx.fill();
    }

    if (!box) {
      ctx.restore();
      return;
    }

    const { cx, cy, rx, ry } = box;
    ctx.fillStyle = `rgba(255, 248, 240, ${baseAlpha})`;
    ctx.fillRect(cx - rx, cy - ry, rx * 2, ry * 2);
    paintFlowBands(ctx, cx, cy, rx, ry, key, t, flowAlpha, palette);

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
      ctx.beginPath();
      ctx.arc(px, py, size * (0.75 + 0.25 * pulse), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${bubbleAlpha + bubblePulse * pulse})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px - size * 0.28, py - size * 0.28, size * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.22 * pulse})`;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 沿封闭轮廓描流动彩虹描边（色相沿包围盒渐变并随时间漂移）。
   * pathFn 可挂 `.bounds()`；椭圆可用 {cx,cy,rx,ry}；无 bounds 时用 opts.bounds。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @param {string|number} seed
   * @param {{
   *   lineWidth?: number,
   *   palette?: number[][],
   *   alpha?: number,
   *   speed?: number,
   *   bounds?: { cx: number, cy: number, rx: number, ry: number }
   * }} [opts]
   */
  function strokeFlowingOutline(ctx, pathOrBounds, seed, opts = {}) {
    if (!ctx || pathOrBounds == null) return;
    const key = String(seed);
    const t = nowSec();
    const palette =
      opts.palette && opts.palette.length ? opts.palette : PALETTE;
    const alpha = opts.alpha != null ? opts.alpha : DEFAULT_OUTLINE_ALPHA;
    const speed = opts.speed != null ? opts.speed : 1.15;
    const lineWidth = opts.lineWidth != null ? opts.lineWidth : 2;
    const box = resolveBounds(pathOrBounds) || opts.bounds || null;
    if (!box) return;

    ctx.save();
    ctx.beginPath();
    if (typeof pathOrBounds === 'function') {
      pathOrBounds(ctx);
    } else {
      ctx.ellipse(box.cx, box.cy, box.rx, box.ry, 0, 0, Math.PI * 2);
    }
    ctx.lineWidth = lineWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = flowingOutlineGradient(
      ctx,
      box,
      key,
      t,
      palette,
      alpha,
      speed
    );
    ctx.stroke();
    // 外层淡彩光晕，增强「泡泡轮廓」感（不参与命中）。
    ctx.lineWidth = lineWidth * 1.85;
    ctx.strokeStyle = flowingOutlineGradient(
      ctx,
      box,
      key + ':glow',
      t * 0.92 + 0.4,
      palette,
      alpha * 0.28,
      speed * 0.85
    );
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 圆形封闭区便捷填充。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {string|number} seed
   * @param {{ count?: number, base?: string, alpha?: number, flowAlpha?: number, bubbleAlpha?: number }} [opts]
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
   * @param {{ count?: number, base?: string, alpha?: number, flowAlpha?: number, bubbleAlpha?: number }} [opts]
   */
  function fillEllipse(ctx, x, y, rx, ry, seed, opts = {}) {
    if (!(rx > 0) || !(ry > 0)) return;
    drawBubbleFill(ctx, { cx: x, cy: y, rx, ry }, 0, seed, opts);
  }

  /**
   * 任意封闭 path 便捷填充（pathFn 可挂 .bounds()）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function} pathFn
   * @param {string|number} seed
   * @param {{ count?: number, base?: string, alpha?: number, flowAlpha?: number, bubbleAlpha?: number, palette?: number[][] }} [opts]
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
   * @param {{ lineWidth?: number, palette?: number[][], alpha?: number, speed?: number }} [opts]
   */
  function strokeFlowingCircle(ctx, x, y, r, seed, opts = {}) {
    if (!(r > 0)) return;
    strokeFlowingOutline(ctx, { cx: x, cy: y, rx: r, ry: r }, seed, opts);
  }

  /** 清空时钟标记（波次 reset / 调试）。 */
  function reset() {
    timeSec = 0;
    framed = false;
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
