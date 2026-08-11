/**
 * 列车下方铁路轨道（纯视觉）：轨下地面 + 停靠月台白标 + 道砟 + 轨枕 + 双轨头，随车速卷动。
 * 仅绘制相机 FOV 内（含边距）的轨带，保证视口左右不断轨；不改碰撞 / 协议 / 走道。
 * 绘轨车厢玩法仍是雷达探测，与此视觉轨无关。
 */
(() => {
  /**
   * 与 lp-boiler-panel 车速表同源：|speed|/SPEED_REF → 0…DISPLAY_KMH_AT_REF km/h。
   * 世界尺度：一节 MODULE_W ≈ CAR_LENGTH_M 米 → 1 speed 单位 = 一致的世界 px/s。
   * 旧占位 SCROLL_PX_PER_SPEED=48（满速仅 240 px/s）相对 120 km/h 读数过慢。
   */
  const SPEED_REF = 5;
  const DISPLAY_KMH_AT_REF = 120;
  const CAR_LENGTH_M = 20;
  /** Spec 未就绪时的 MODULE_W 回退（2250×WORLD_SCALE 0.88）。 */
  const MODULE_W_FALLBACK = 1980;
  /** FOV 左右外延（源图像素 → 世界），避免轨枕/锈斑在边沿弹出。 */
  const ART_FOV_MARGIN = 96;
  /** 轨枕间距 / 尺寸（源图像素）。 */
  const ART_SLEEPER_GAP = 56;
  const ART_SLEEPER_W = 40;
  const ART_SLEEPER_H = 16;
  /** 双轨竖直间距（侧视近/远轨，源图像素）。 */
  const ART_GAUGE = 18;
  /** 轨头厚度（源图像素）。 */
  const ART_RAIL_H = 3.5;
  /**
   * 轨下地面顶边相对下轨的偏移（源图像素）。
   * 明确低于 TRACK_Y / 双轨，给弹壳、碎屑提供可见落点参照。
   */
  const ART_GROUND_BELOW_LOWER_RAIL = 14;
  /** 轨下地面带高度（源图像素）。 */
  const ART_GROUND_H = 128;

  let scrollX = 0;
  /** 上一帧轨枕卷动增量（世界像素；正速度时为正，轨面向 −X 退）。 */
  let lastScrollDelta = 0;
  /**
   * 月台白标轨面锚点：track = world + scrollX（与 applyTrackScroll / 尘土同相）。
   * 进站上升沿锁定；离站后仍画到滚出 FOV 再清。
   */
  let dockMarkerTrackLeft = null;
  let dockMarkerTrackRight = null;
  let dockMarkerWasDocked = false;

  /** 读取规格；缺省时不绘制。 */
  function spec() {
    return window.LiminalCarriageSpec || null;
  }

  /**
   * 1 LpTrainDrive.speed 单位 → 轨枕沿轨卷动的世界像素/秒。
   * 公式：(DISPLAY_KMH_AT_REF/SPEED_REF) × (1000/3600 m/s per km/h) × (MODULE_W/CAR_LENGTH_M)。
   * 典型值 ≈ 660（MODULE_W=1980）；正速度增加 scrollX，绘制时轨面向左退。
   */
  function scrollPxPerSpeedUnit(S) {
    const moduleW = Number(S?.MODULE_W) > 0 ? S.MODULE_W : MODULE_W_FALLBACK;
    const kmhPerUnit = DISPLAY_KMH_AT_REF / SPEED_REF;
    const pxPerM = moduleW / CAR_LENGTH_M;
    return kmhPerUnit * (1000 / 3600) * pxPerM;
  }

  /**
   * 从当前世界变换矩阵求可见世界 X 跨度（FOV + 边距）。
   * 依赖 drawFrame 已 setTransform(zoom*dpr, …, offset*dpr)；不按编组长裁切，避免镜头领先时断轨。
   */
  function trackSpanFromView(ctx, S) {
    const m = ctx.getTransform();
    const sx = m.a;
    if (!(sx > 0) || !ctx.canvas) return null;
    const margin = S.scaleArt(ART_FOV_MARGIN);
    return {
      left: (0 - m.e) / sx - margin,
      right: (ctx.canvas.width - m.e) / sx + margin,
    };
  }

  /**
   * 按车速推进轨枕相位；正速度（前进 / +X）时轨面向左退，模拟列车前行。
   * 同步写入 lastScrollDelta，供轨面/地面碎屑与轨同相平移。
   * @param {number} dt
   */
  function tick(dt) {
    const speed = Number(window.LpTrainDrive?.getState?.()?.speed) || 0;
    const rate = scrollPxPerSpeedUnit(spec());
    lastScrollDelta = speed * rate * Math.max(0, dt);
    scrollX += lastScrollDelta;
  }

  /**
   * 将轨面坐标系物体随本帧卷动平移（车厢固定、轨卷动模型下与轨枕同相）。
   * 正速度时世界 X 减小，使碎屑相对轨枕不滑动。
   * @param {{ x: number }} entity
   */
  function applyTrackScroll(entity) {
    if (!entity) return;
    entity.x -= lastScrollDelta;
  }

  /**
   * 本帧随轨平移（与 applyTrackScroll / 尘土 / 白标同相）。
   * 轨面怪、地面掉落、未来轨面元素统一走此入口。
   * @param {{ x: number }} entity
   */
  function scrollWithTrack(entity) {
    applyTrackScroll(entity);
  }

  /**
   * 把实体钉到轨面坐标（track = world + scrollX），供静止或慢变轨面物复用。
   * 之后每帧用 syncWorldFromTrackAnchor，或继续用 scrollWithTrack 等价推进。
   * @param {{ x: number, trackX?: number }} entity
   */
  function latchTrackAnchor(entity) {
    if (!entity) return;
    entity.trackX = entity.x + scrollX;
  }

  /**
   * 由轨面锚点写回世界 X：world = track − scrollX（与月台白标同式）。
   * @param {{ x: number, trackX?: number }} entity
   */
  function syncWorldFromTrackAnchor(entity) {
    if (!entity || entity.trackX == null) return;
    entity.x = entity.trackX - scrollX;
  }

  /**
   * 进站上升沿把月台白标钉到轨面坐标；离站保留锚点直至滚出视野。
   * track = world + scrollX，与轨枕相位 / applyTrackScroll 同相，避免贴编组不动。
   */
  function syncDockMarkerTrackAnchor() {
    const span = window.LpPlatform?.getDockTrackMarkerSpan?.();
    const docked = Boolean(span);
    if (docked && !dockMarkerWasDocked) {
      dockMarkerTrackLeft = span.left + scrollX;
      dockMarkerTrackRight = span.right + scrollX;
    }
    dockMarkerWasDocked = docked;
  }

  /**
   * 在轨带上画半透明白色长矩形（月台视觉标）。
   * 锚在轨面 scroll 空间，随轨平移；离站后滚出 FOV 再消失；低 alpha 不挡玩法。
   */
  function drawDockPlatformMarker(ctx, S, yRail, gauge, viewLeft, viewRight) {
    syncDockMarkerTrackAnchor();
    if (dockMarkerTrackLeft == null || dockMarkerTrackRight == null) return;

    const worldLeft = dockMarkerTrackLeft - scrollX;
    const worldRight = dockMarkerTrackRight - scrollX;
    if (worldRight <= viewLeft || worldLeft >= viewRight) {
      if (!dockMarkerWasDocked) {
        dockMarkerTrackLeft = null;
        dockMarkerTrackRight = null;
      }
      return;
    }

    const left = Math.max(worldLeft, viewLeft);
    const right = Math.min(worldRight, viewRight);
    if (!(right > left)) return;

    /* 盖住道砟顶到下轨略下：侧视下像贴轨的月台板 */
    const top = yRail - S.scaleArt(8);
    const bot = yRail + gauge + S.scaleArt(22);
    const h = bot - top;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';
    ctx.fillRect(left, top, right - left, h);
    /* 顶缘略亮，标出月台面 */
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(left, top, right - left, Math.max(1, S.scaleArt(3)));
  }

  /**
   * 绘制轨下地面带（深色工业砂土/混凝土）：在道砟与轨之前，FOV 同宽。
   * 顶边低于下轨，供弹壳 / 碎屑有可见参照面；不参与碰撞与协议。
   */
  function drawGround(ctx, S, left, right, yRail, gauge) {
    const width = right - left;
    const groundTop = yRail + gauge + S.scaleArt(ART_GROUND_BELOW_LOWER_RAIL);
    const groundH = S.scaleArt(ART_GROUND_H);
    const groundBot = groundTop + groundH;

    /* 主体：近黑褐 → 更深，贴合阈限工业夜景，避免高对比噪点 */
    const fill = ctx.createLinearGradient(0, groundTop, 0, groundBot);
    fill.addColorStop(0, 'rgba(32, 28, 26, 0.96)');
    fill.addColorStop(0.35, 'rgba(24, 21, 20, 0.98)');
    fill.addColorStop(0.75, 'rgba(16, 14, 14, 0.94)');
    fill.addColorStop(1, 'rgba(10, 9, 12, 0.35)');
    ctx.fillStyle = fill;
    ctx.fillRect(left, groundTop, width, groundH);

    /* 地面顶缘：略亮的边缘线，标出「落点平面」 */
    ctx.fillStyle = 'rgba(48, 42, 38, 0.7)';
    ctx.fillRect(left, groundTop, width, Math.max(1, S.scaleArt(2.5)));
    ctx.fillStyle = 'rgba(18, 14, 12, 0.45)';
    ctx.fillRect(left, groundTop + S.scaleArt(2.5), width, Math.max(1, S.scaleArt(1.5)));

    /* 稀疏砾石 / 混凝土斑：弱对比、静态相位，避免闪烁 */
    const gritStep = S.scaleArt(28);
    const gritStart = Math.floor(left / gritStep) * gritStep;
    for (let gx = gritStart; gx < right; gx += gritStep) {
      const cell = Math.floor(gx / gritStep);
      const gy =
        groundTop +
        S.scaleArt(10) +
        ((cell * 13) % 7) * S.scaleArt(8) +
        ((cell * 7) % 3) * S.scaleArt(2);
      if (gy > groundBot - S.scaleArt(18)) continue;
      ctx.fillStyle =
        cell % 3 === 0 ? 'rgba(58, 50, 44, 0.28)' : 'rgba(40, 36, 34, 0.22)';
      ctx.fillRect(
        gx + ((cell * 5) % 4) * S.scaleArt(1.5),
        gy,
        S.scaleArt(3 + (cell % 3)),
        S.scaleArt(2 + (cell % 2))
      );
    }

    /* 淡水平接缝，暗示混凝土板 / 夯土带 */
    ctx.strokeStyle = 'rgba(12, 10, 10, 0.22)';
    ctx.lineWidth = Math.max(1, S.scaleArt(1));
    const seamGap = S.scaleArt(36);
    for (let sy = groundTop + seamGap; sy < groundBot - S.scaleArt(24); sy += seamGap) {
      ctx.beginPath();
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
      ctx.stroke();
    }

    return { top: groundTop, bot: groundBot };
  }

  /**
   * 在世界变换下绘制轨道（应在车厢贴图之前调用）；仅覆盖当前 FOV。
   * 层序：地面 → 道砟 → 轨枕 → 轨头（均在车厢之下）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    const S = spec();
    if (!S || !ctx) return;
    const span = trackSpanFromView(ctx, S);
    if (!span) return;

    const yRail = S.TRACK_Y;
    const gauge = S.scaleArt(ART_GAUGE);
    const railH = S.scaleArt(ART_RAIL_H);
    const sleeperGap = S.scaleArt(ART_SLEEPER_GAP);
    const sleeperW = S.scaleArt(ART_SLEEPER_W);
    const sleeperH = S.scaleArt(ART_SLEEPER_H);
    const bedTop = yRail - S.scaleArt(10);
    const bedBot = yRail + gauge + S.scaleArt(28);
    const { left, right } = span;
    const width = right - left;
    if (!(width > 0)) return;

    ctx.save();

    drawGround(ctx, S, left, right, yRail, gauge);
    /* 停靠月台标：地面之上、道砟/轨枕之下 */
    drawDockPlatformMarker(ctx, S, yRail, gauge, left, right);

    /* 道砟带：深色阈限底，略压暗背景 */
    const bed = ctx.createLinearGradient(0, bedTop, 0, bedBot);
    bed.addColorStop(0, 'rgba(18, 16, 28, 0)');
    bed.addColorStop(0.18, 'rgba(22, 18, 32, 0.72)');
    bed.addColorStop(0.55, 'rgba(28, 24, 36, 0.92)');
    bed.addColorStop(1, 'rgba(12, 10, 18, 0.55)');
    ctx.fillStyle = bed;
    ctx.fillRect(left, bedTop, width, bedBot - bedTop);

    /* 道砟颗粒：稀疏噪点，不随卷动（避免闪烁过强） */
    ctx.fillStyle = 'rgba(55, 48, 62, 0.35)';
    const gritStep = S.scaleArt(22);
    for (let gx = left; gx < right; gx += gritStep) {
      const gy = bedTop + S.scaleArt(14) + ((Math.floor(gx / gritStep) * 17) % 5) * S.scaleArt(3);
      ctx.fillRect(gx, gy, S.scaleArt(3), S.scaleArt(2.5));
    }

    /* 轨枕：随 scrollX 卷动（相位相对世界 X，与镜头 left 无关，保轮轨对齐） */
    const phase =
      ((scrollX % sleeperGap) + sleeperGap) % sleeperGap;
    const sleeperY = yRail + gauge * 0.15;
    ctx.fillStyle = '#2c211c';
    ctx.strokeStyle = 'rgba(18, 12, 10, 0.55)';
    ctx.lineWidth = Math.max(1, S.scaleArt(1));
    /* 从对齐到 sleeperGap 网格的起点铺轨枕，保证左右边连续 */
    const sleeperStart =
      Math.floor((left - phase) / sleeperGap) * sleeperGap + phase;
    for (let x = sleeperStart - sleeperGap; x < right + sleeperGap; x += sleeperGap) {
      const sx = x;
      if (sx + sleeperW < left || sx > right) continue;
      ctx.fillRect(sx, sleeperY, sleeperW, sleeperH);
      ctx.strokeRect(sx + 0.5, sleeperY + 0.5, sleeperW - 1, sleeperH - 1);
      /* 木纹高光一条 */
      ctx.fillStyle = 'rgba(70, 54, 42, 0.45)';
      ctx.fillRect(sx + S.scaleArt(2), sleeperY + S.scaleArt(3), sleeperW - S.scaleArt(4), S.scaleArt(2));
      ctx.fillStyle = '#2c211c';
    }

    /** 画一根轨头（阴影 + 亮边）。 */
    function drawRail(y) {
      ctx.fillStyle = '#1f2933';
      ctx.fillRect(left, y, width, railH + S.scaleArt(1.5));
      ctx.fillStyle = '#6b7585';
      ctx.fillRect(left, y, width, railH);
      ctx.fillStyle = 'rgba(180, 190, 205, 0.55)';
      ctx.fillRect(left, y, width, Math.max(1, railH * 0.35));
      /* 稀疏锈斑 */
      ctx.fillStyle = 'rgba(92, 58, 40, 0.28)';
      const rustStep = S.scaleArt(90);
      const rustPhase = ((scrollX * 0.35) % rustStep + rustStep) % rustStep;
      const rustStart =
        Math.floor((left - rustPhase) / rustStep) * rustStep + rustPhase;
      for (let rx = rustStart; rx < right; rx += rustStep) {
        ctx.fillRect(rx, y + railH * 0.25, S.scaleArt(10), Math.max(1, railH * 0.5));
      }
    }

    drawRail(yRail);
    drawRail(yRail + gauge);

    /* 轨间微暗，压出轨距 */
    ctx.fillStyle = 'rgba(8, 6, 12, 0.22)';
    ctx.fillRect(left, yRail + railH, width, gauge - railH);

    ctx.restore();
  }

  /**
   * 轨下地面顶边世界 Y（下轨 + ART_GROUND_BELOW_LOWER_RAIL）；无 Spec 时返回 null。
   */
  function getGroundTopY() {
    const S = spec();
    if (!S) return null;
    return (
      S.TRACK_Y +
      S.scaleArt(ART_GAUGE) +
      S.scaleArt(ART_GROUND_BELOW_LOWER_RAIL)
    );
  }

  window.LpTrack = {
    tick,
    draw,
    applyTrackScroll,
    scrollWithTrack,
    latchTrackAnchor,
    syncWorldFromTrackAnchor,
    /** 调试：当前轨枕卷动相位（世界像素）。 */
    getScrollX() {
      return scrollX;
    },
    /** 上一帧卷动增量（世界像素；正 = 轨面向 −X）。 */
    getLastScrollDelta() {
      return lastScrollDelta;
    },
    /** 调试：当前 1 speed 单位对应的卷动速率（世界 px/s）。 */
    getScrollPxPerSpeed() {
      return scrollPxPerSpeedUnit(spec());
    },
    getGroundTopY,
  };
})();
