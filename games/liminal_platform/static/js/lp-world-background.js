/**
 * 世界背景层：阈限 / 心理恐怖调性的深空场 + 稀疏棱彩泡边。
 * 与保龄球/气球怪共享泡泡描边语汇，但压暗、稀疏、偏冷病色；绘于轨道/车厢之下，FOV 同宽。
 */
(() => {
  /** FOV 外延（世界像素量级；无 Spec 时用固定边距）。 */
  const FOV_MARGIN = 120;
  /** 稀疏「远景泡」数量（整段 FOV 内）。 */
  const BUBBLE_COUNT = 7;
  /** 极淡棱彩丝带条数。 */
  const RIBBON_COUNT = 2;
  /**
   * 冷病调色盘（与 mob 彩虹同源思路，压饱和、偏青紫病绿）。
   * @type {number[][]}
   */
  const PALETTE = [
    [72, 88, 118],
    [58, 110, 108],
    [96, 72, 118],
    [68, 92, 86],
    [110, 78, 92],
    [52, 78, 102],
  ];

  let timeSec = 0;

  /**
   * 稳定哈希 → (0,1)。
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
   * 推进背景时钟（秒）；主循环可选调用。
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
   * 从当前世界变换求可见世界矩形（FOV + 边距）；与 LpTrack 同思路。
   * @param {CanvasRenderingContext2D} ctx
   * @returns {{ left: number, right: number, top: number, bot: number } | null}
   */
  function viewRectFromTransform(ctx) {
    const m = ctx.getTransform();
    const sx = m.a;
    const sy = m.d;
    if (!(sx > 0) || !(sy > 0) || !ctx.canvas) return null;
    const marginX = FOV_MARGIN;
    const marginY = FOV_MARGIN;
    return {
      left: (0 - m.e) / sx - marginX,
      right: (ctx.canvas.width - m.e) / sx + marginX,
      top: (0 - m.f) / sy - marginY,
      bot: (ctx.canvas.height - m.f) / sy + marginY,
    };
  }

  /**
   * 铺软深空场：近黑虚空 + 极弱竖直冷晕，避免纯黑死板与原先蓝灰冲突。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   */
  function paintVoidField(ctx, rect) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    if (!(w > 0) || !(h > 0)) return;

    const g = ctx.createLinearGradient(0, top, 0, bot);
    g.addColorStop(0, '#06070a');
    g.addColorStop(0.28, '#080a0e');
    g.addColorStop(0.55, '#0a0c11');
    g.addColorStop(0.78, '#07080c');
    g.addColorStop(1, '#040508');
    ctx.fillStyle = g;
    ctx.fillRect(left, top, w, h);

    /* 上半屏极淡青紫晕：阈限「灯管后」感，不抢车厢对比 */
    const haze = ctx.createRadialGradient(
      left + w * 0.42,
      top + h * 0.18,
      h * 0.05,
      left + w * 0.5,
      top + h * 0.35,
      h * 0.72
    );
    haze.addColorStop(0, 'rgba(48, 62, 88, 0.11)');
    haze.addColorStop(0.45, 'rgba(36, 48, 58, 0.05)');
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = haze;
    ctx.fillRect(left, top, w, h);

    /* 下沿更深虚空，贴合轨下地面 */
    const well = ctx.createLinearGradient(0, top + h * 0.62, 0, bot);
    well.addColorStop(0, 'rgba(0, 0, 0, 0)');
    well.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
    ctx.fillStyle = well;
    ctx.fillRect(left, top + h * 0.62, w, h * 0.38);
  }

  /**
   * 画极淡棱彩丝带（慢漂，病色，几乎不可读）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   */
  function paintRibbons(ctx, rect, t) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    for (let i = 0; i < RIBBON_COUNT; i += 1) {
      const phase = hash01('ribbon', i) * Math.PI * 2;
      const yBase = top + h * (0.22 + hash01('ribbon-y', i) * 0.38);
      const amp = h * (0.012 + hash01('ribbon-a', i) * 0.018);
      const rgb = PALETTE[i % PALETTE.length];
      ctx.beginPath();
      const steps = 18;
      for (let s = 0; s <= steps; s += 1) {
        const u = s / steps;
        const x = left + u * w;
        const y =
          yBase +
          Math.sin(u * Math.PI * 1.4 + t * 0.22 + phase) * amp +
          Math.sin(u * Math.PI * 0.6 - t * 0.11 + phase * 0.4) * amp * 0.45;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.045)`;
      ctx.lineWidth = Math.max(1.5, h * 0.008);
      ctx.lineCap = 'round';
      ctx.stroke();
    }
  }

  /**
   * 稀疏远景泡：半透明体 + 病色流动描边，慢漂；不挡玩法区对比。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ left: number, right: number, top: number, bot: number }} rect
   * @param {number} t
   */
  function paintSparseBubbles(ctx, rect, t) {
    const { left, right, top, bot } = rect;
    const w = right - left;
    const h = bot - top;
    const Bub = window.LpMobBubbleFill;

    for (let i = 0; i < BUBBLE_COUNT; i += 1) {
      const a = hash01('bg-bub', i);
      const b = hash01('bg-bub', i + 19);
      const c = hash01('bg-bub', i + 41);
      /* 主要落在上半与远景带，避开车厢/轨面高度 */
      const baseX = left + ((a + b * 0.15) % 1) * w;
      const baseY = top + h * (0.08 + c * 0.42);
      const driftX = Math.sin(t * (0.08 + a * 0.06) + b * 6) * w * 0.012;
      const driftY = Math.cos(t * (0.06 + b * 0.05) + a * 4) * h * 0.01;
      const cx = baseX + driftX;
      const cy = baseY + driftY;
      const rx = Math.max(18, h * (0.035 + a * 0.055));
      const ry = rx * (0.78 + b * 0.28);
      const seed = `world-bg:${i}`;
      const rgb = PALETTE[Math.floor(a * PALETTE.length) % PALETTE.length];

      if (Bub?.drawBubbleFill) {
        Bub.drawBubbleFill(
          ctx,
          { cx, cy, rx, ry },
          0,
          seed,
          {
            count: 3,
            alpha: 0.015,
            flowAlpha: 0.02,
            bubbleAlpha: 0.04,
            bubblePulse: 0.03,
            palette: PALETTE,
          }
        );
        Bub.strokeFlowingOutline?.(ctx, { cx, cy, rx, ry }, seed, {
          lineWidth: Math.max(1, rx * 0.04),
          alpha: 0.22,
          speed: 0.35,
          palette: PALETTE,
        });
      } else {
        ctx.beginPath();
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.04)`;
        ctx.fill();
        ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.12)`;
        ctx.lineWidth = Math.max(1, rx * 0.035);
        ctx.stroke();
      }
    }
  }

  /**
   * 在世界变换下绘制背景（须在 LpTrack / 车厢之前调用）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (!ctx) return;
    const rect = viewRectFromTransform(ctx);
    if (!rect) return;
    if (!(timeSec > 0)) timeSec = performance.now() * 0.001;
    const t = timeSec;

    ctx.save();
    paintVoidField(ctx, rect);
    paintRibbons(ctx, rect, t);
    paintSparseBubbles(ctx, rect, t);
    ctx.restore();
  }

  window.LpWorldBackground = {
    tick,
    draw,
    PALETTE,
  };
})();
