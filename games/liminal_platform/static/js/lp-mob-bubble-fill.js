/**
 * 怪体内封闭区彩色泡泡 + 液态流动填充（Canvas clip）。
 * 供 LpMobs 等在每个封闭轮廓内调用；共享帧时钟、种子驱动，泡泡数有上限。
 */
(() => {
  /** 单区默认泡泡数。 */
  const DEFAULT_COUNT = 8;
  /** 单区上限，避免多部位叠画爆帧。 */
  const MAX_COUNT = 12;
  /** 流动色带条数。 */
  const FLOW_BANDS = 3;
  /** 调色盘：高饱和小圆点。 */
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
   */
  function paintFlowBands(ctx, cx, cy, rx, ry, key, t) {
    for (let i = 0; i < FLOW_BANDS; i += 1) {
      const phase = hash01(key, i + 90) * Math.PI * 2;
      const amp = ry * (0.1 + hash01(key, i + 100) * 0.16);
      const y0 = cy - ry * 0.7 + ((i + 0.5) / FLOW_BANDS) * ry * 1.4;
      const rgb = PALETTE[(i + Math.floor(hash01(key, i) * 3)) % PALETTE.length];
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
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.16)`;
      ctx.fill();
    }
  }

  /**
   * 从 pathFn 或椭圆 bounds 解析裁剪区与近似包围盒。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   * @returns {{ cx: number, cy: number, rx: number, ry: number } | null}
   */
  function beginClip(ctx, pathOrBounds) {
    ctx.beginPath();
    if (typeof pathOrBounds === 'function') {
      pathOrBounds(ctx);
      const b = typeof pathOrBounds.bounds === 'function' ? pathOrBounds.bounds() : null;
      ctx.clip();
      if (b && b.rx > 0 && b.ry > 0) return b;
      return null;
    }
    const cx = pathOrBounds.cx;
    const cy = pathOrBounds.cy;
    const rx = Math.max(0.5, pathOrBounds.rx);
    const ry = Math.max(0.5, pathOrBounds.ry != null ? pathOrBounds.ry : rx);
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.clip();
    return { cx, cy, rx, ry };
  }

  /**
   * 在封闭区内画底色 + 流动色带 + 彩色泡泡（clip 到 path / 椭圆）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {Function|{ cx: number, cy: number, rx: number, ry?: number }} pathOrBounds
   *   pathFn 可挂 `.bounds()` 返回 {cx,cy,rx,ry} 供粒子散布。
   * @param {number} [_dt] 保留兼容；实际用 beginFrame 共享时钟
   * @param {string|number} seed 稳定种子（建议 mobId + 部位名）
   * @param {{ count?: number, base?: string, alpha?: number, palette?: number[][] }} [opts]
   */
  function drawBubbleFill(ctx, pathOrBounds, _dt, seed, opts = {}) {
    if (!ctx || pathOrBounds == null) return;
    const key = String(seed);
    const t = nowSec();
    const count = Math.max(
      1,
      Math.min(MAX_COUNT, opts.count != null ? Math.floor(opts.count) : DEFAULT_COUNT)
    );
    const baseAlpha = opts.alpha != null ? opts.alpha : 0.2;
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
    paintFlowBands(ctx, cx, cy, rx, ry, key, t);

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
      ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${0.45 + 0.35 * pulse})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px - size * 0.28, py - size * 0.28, size * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.35 * pulse})`;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * 圆形封闭区便捷填充。
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} r
   * @param {string|number} seed
   * @param {{ count?: number, base?: string, alpha?: number }} [opts]
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
   * @param {{ count?: number, base?: string, alpha?: number }} [opts]
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
   * @param {{ count?: number, base?: string, alpha?: number, palette?: number[][] }} [opts]
   */
  function fillPath(ctx, pathFn, seed, opts = {}) {
    if (typeof pathFn !== 'function') return;
    drawBubbleFill(ctx, pathFn, 0, seed, opts);
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
    reset,
    PALETTE,
  };
})();
