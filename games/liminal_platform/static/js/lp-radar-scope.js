/**
 * 绘轨车厢 · 雷达示波器控制台（战斗机式 PPI）。
 * 搜索雷达：360° 旋转扫描；锁定雷达：扇区角平分线跟随鼠标 / 瞄准摇杆。
 * 方位约定：12 点 / 0° = 列车前进（默认编组右 = 世界 +X）；角度顺时针递增（canvas/PPI）。
 * 当前：本列火车 + 铁轨；预留 contacts 供其它列车 / 大型敌方曲射目标。
 */
(() => {
  const root = document.getElementById('lpRadarScopeRoot');
  const canvas = document.getElementById('lpRadarScopeCanvas');
  const closeBtn = document.getElementById('lpRadarScopeClose');
  const rangeReadout = document.getElementById('lpRadarRangeReadout');
  const modeReadout = document.getElementById('lpRadarModeReadout');
  const rangeTrack = document.getElementById('lpRadarRangeTrack');
  const rangeKnob = document.getElementById('lpRadarRangeKnob');
  const rangeNotches = document.getElementById('lpRadarRangeNotches');
  const aimStick = document.getElementById('lpRadarAimStick');
  const aimKnob = document.getElementById('lpRadarAimKnob');
  if (!root || !canvas) return;

  const ctx = canvas.getContext('2d');

  /** 锁定雷达扇区总张角（度）；可调。 */
  const LOCK_BEAM_WIDTH_DEG = 30;
  const LOCK_HALF_RAD = ((LOCK_BEAM_WIDTH_DEG / 2) * Math.PI) / 180;
  const AIM_DEADZONE = 0.18;

  /** 示波器 PPI 量程下限 / 上限（滚轮不可超过上限）。 */
  const RANGE_WORLD_MIN = 1200;
  const RANGE_WORLD_MAX = 12000;
  /** 量程档位步长（世界单位）；档位为 1200 的整数倍。 */
  const RANGE_GEAR_STEP = 1200;
  /** 量程档位表：1200…12000。 */
  const RANGE_GEARS = (() => {
    const gears = [];
    for (let v = RANGE_WORLD_MIN; v <= RANGE_WORLD_MAX; v += RANGE_GEAR_STEP) {
      gears.push(v);
    }
    return gears;
  })();
  /** 刻度可见数字标签（其余档位仅短刻线，仍可点选）。 */
  const RANGE_GEAR_LABELS = new Set([RANGE_WORLD_MIN, 6000, RANGE_WORLD_MAX]);
  /** 锁定扇区有效世界量程；超出部分不填充，以外弧封闭表示超出锁定量程。 */
  const LOCK_RANGE_WORLD_MAX = 6000;
  /** 示波器量程（世界单位；始终落在 RANGE_GEARS）。 */
  let rangeWorld = 4800;
  /** 量程拉杆拖拽中的 pointerId；null 表示未拖。 */
  let rangeGearPointer = null;
  let open = false;
  let raf = 0;
  let sweepAngle = -Math.PI / 2;
  /** 锁定扇区角平分线（canvas 弧度，0 = 右，顺时针为正）。 */
  let lockAimAngle = -Math.PI / 2;
  let mouseAimActive = false;
  let radarAimPointer = null;
  let radarAimReady = false;
  /** @type {Array<{ id: string, kind: string, x: number, y: number, label?: string }>} */
  let externalContacts = [];
  /**
   * 上次有效前进符号（+1 = 世界 +X / 屏幕右，-1 = 反向）。
   * 静止时沿用，避免 12 点乱跳。
   */
  let lastForwardSign = 1;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /**
   * 读取列车前进符号：有速度用 speed 符号，静止保留上次，缺省 +1（编组右=前进）。
   */
  function resolveForwardSign() {
    const speed = window.LpTrainDrive?.getState?.()?.speed;
    if (typeof speed === 'number' && Math.abs(speed) >= 0.08) {
      lastForwardSign = speed > 0 ? 1 : -1;
    }
    return lastForwardSign;
  }

  /**
   * 前进方向对应的 canvas 弧度（0 = 右，顺时针为正）。
   */
  function forwardCanvasAngle(forwardSign) {
    return forwardSign >= 0 ? 0 : Math.PI;
  }

  /** 未来：其它列车 / 敌方大型目标等接触点（世界坐标）。 */
  function setContacts(list) {
    externalContacts = Array.isArray(list) ? list.slice() : [];
  }

  /** 追加单个接触（不替换整表）。 */
  function upsertContact(contact) {
    if (!contact?.id) return;
    const i = externalContacts.findIndex((c) => c.id === contact.id);
    if (i >= 0) externalContacts[i] = { ...externalContacts[i], ...contact };
    else externalContacts.push({ ...contact });
  }

  /** 本列车厢世界中心 X。 */
  function ownTrainCenters() {
    const Spec = window.LiminalCarriageSpec;
    if (!Spec?.CARRIAGES) return [];
    const mid = (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    return Spec.CARRIAGES.map((car) => ({
      id: car.id,
      label: car.map?.shortLabel || car.label || car.id,
      x: car.worldX + mid,
      y: Spec.FLOOR_Y,
      kind: car.id === 'huigui' ? 'own-scope' : 'own',
    }));
  }

  /** 轨道在示波器上的参考 Y（本车高度附近的「轨面」带）。 */
  function trackY() {
    return window.LiminalCarriageSpec?.TRACK_Y ?? window.LiminalCarriageSpec?.FLOOR_Y ?? 0;
  }

  /** 示波器原点：以绘轨车（或编组中心）为雷达站。 */
  function radarOriginX() {
    const Spec = window.LiminalCarriageSpec;
    const scope = Spec?.carriageById?.('huigui');
    if (scope) return scope.worldX + (Spec.WALK_LEFT + Spec.WALK_RIGHT) / 2;
    const cars = Spec?.CARRIAGES;
    if (!cars?.length) return 0;
    const first = cars[0];
    const last = cars[cars.length - 1];
    return (first.worldX + last.worldX + Spec.MODULE_W) / 2;
  }

  /** 世界 → 示波器局部（站心为 0，+X 前进）。 */
  function worldToScope(wx, wy) {
    const ox = radarOriginX();
    const oy = trackY();
    return { x: wx - ox, y: wy - oy };
  }

  /** 按外壳宽度调整 canvas 像素尺寸，保持 PPI 圆形；右侧量程档预留约 78px。 */
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const shell = root.querySelector('.lp-radar-shell');
    const gear = root.querySelector('.lp-radar-gear');
    const basis = shell?.clientWidth || root.clientWidth;
    const gearW = gear?.offsetWidth || 84;
    const avail = Math.max(200, Math.floor(basis - gearW - 56));
    const css = Math.min(560, Math.max(220, avail));
    canvas.style.width = `${css}px`;
    canvas.style.height = `${css}px`;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /**
   * 由指针相对 PPI 画布中心更新锁定扇区瞄准角（可在画布外调用）。
   * 副作用：设置 mouseAimActive，覆盖摇杆瞄准优先权。
   */
  function aimFromCanvasClient(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - (rect.left + rect.width / 2);
    const y = clientY - (rect.top + rect.height / 2);
    if (Math.hypot(x, y) < 6) return;
    lockAimAngle = Math.atan2(y, x);
    mouseAimActive = true;
  }

  /**
   * 将任意量程吸附到最近档位（RANGE_GEARS）；夹在 [MIN, MAX] 内。
   */
  function snapRangeWorld(value) {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return rangeWorld;
    const clamped = Math.max(RANGE_WORLD_MIN, Math.min(RANGE_WORLD_MAX, raw));
    let best = RANGE_GEARS[0];
    let bestDist = Math.abs(clamped - best);
    for (let i = 1; i < RANGE_GEARS.length; i += 1) {
      const d = Math.abs(clamped - RANGE_GEARS[i]);
      if (d < bestDist) {
        best = RANGE_GEARS[i];
        bestDist = d;
      }
    }
    return best;
  }

  /** 当前量程在 RANGE_GEARS 中的下标（0 = 最近）。 */
  function rangeGearIndex() {
    const i = RANGE_GEARS.indexOf(rangeWorld);
    return i >= 0 ? i : RANGE_GEARS.indexOf(snapRangeWorld(rangeWorld));
  }

  /**
   * 量程档位 → 拉杆垂直比例（上=远/最大量程，下=近/最小量程）。
   */
  function gearIndexToRatio(index) {
    const maxI = RANGE_GEARS.length - 1;
    return (maxI - index) / maxI;
  }

  /**
   * 拉杆垂直比例 → 档位下标（吸附到最近刻度）。
   */
  function ratioToGearIndex(ratio) {
    const maxI = RANGE_GEARS.length - 1;
    const t = Math.max(0, Math.min(1, ratio));
    return Math.round((1 - t) * maxI);
  }

  /**
   * 将量程夹并吸附到档位；打开面板或外部 setRange 时调用。
   * 副作用：同步档位拉杆 UI。
   */
  function clampRangeWorld() {
    rangeWorld = snapRangeWorld(rangeWorld);
    syncRangeGearUi();
  }

  /**
   * 设定量程档位并刷新拉杆/读数；值会吸附到 RANGE_GEARS。
   */
  function setRangeWorld(value) {
    rangeWorld = snapRangeWorld(value);
    syncRangeGearUi();
  }

  /**
   * 按档位步进调量程（+1 更远，-1 更近）；滚轮 / 远近按钮用。
   */
  function stepRangeGear(deltaSteps) {
    const next = Math.max(
      0,
      Math.min(RANGE_GEARS.length - 1, rangeGearIndex() + deltaSteps)
    );
    rangeWorld = RANGE_GEARS[next];
    syncRangeGearUi();
  }

  /**
   * 同步档位拉杆把手位置、刻度高亮与 aria；读数由 drawFrame 写。
   */
  function syncRangeGearUi() {
    const index = rangeGearIndex();
    const ratio = gearIndexToRatio(index);
    if (rangeKnob) rangeKnob.style.top = `${ratio * 100}%`;
    if (rangeTrack) {
      rangeTrack.setAttribute('aria-valuenow', String(rangeWorld));
      rangeTrack.setAttribute('aria-valuetext', `量程 ${rangeWorld}`);
    }
    if (rangeNotches) {
      for (const btn of rangeNotches.querySelectorAll('[data-range-gear]')) {
        const active = Number(btn.dataset.rangeGear) === rangeWorld;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-selected', active ? 'true' : 'false');
      }
    }
  }

  /**
   * 由指针相对量程拉杆轨道写入档位（拖动中连续吸附）。
   */
  function applyRangeGearPointer(clientY) {
    if (!rangeTrack) return;
    const rect = rangeTrack.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    rangeWorld = RANGE_GEARS[ratioToGearIndex(ratio)];
    syncRangeGearUi();
  }

  /** 构建量程刻度按钮（远在上、近在下；仅 1200/6000/12000 显示数字）。 */
  function buildRangeNotches() {
    if (!rangeNotches) return;
    rangeNotches.replaceChildren();
    for (let i = RANGE_GEARS.length - 1; i >= 0; i -= 1) {
      const gear = RANGE_GEARS[i];
      const labeled = RANGE_GEAR_LABELS.has(gear);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.rangeGear = String(gear);
      btn.setAttribute('role', 'option');
      btn.classList.toggle('is-tick-only', !labeled);
      btn.textContent = labeled ? String(gear) : '';
      btn.setAttribute('aria-label', `量程 ${gear}`);
      btn.addEventListener('click', () => {
        if (!open) return;
        setRangeWorld(gear);
      });
      rangeNotches.appendChild(btn);
    }
  }

  /** 复位雷达专用瞄准摇杆外观（保留已锁定方向）。 */
  function resetRadarAimKnob() {
    radarAimPointer = null;
    if (aimKnob) aimKnob.style.transform = 'translate(0, 0)';
  }

  /** 根据触点更新雷达锁定瞄准摇杆。 */
  function updateRadarAimStick(clientX, clientY) {
    if (!aimStick || !aimKnob) return;
    const rect = aimStick.getBoundingClientRect();
    const radius = rect.width * 0.34;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    aimKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / radius;
    const ny = dy / radius;
    const mag = Math.hypot(nx, ny);
    if (mag < AIM_DEADZONE) return;
    lockAimAngle = Math.atan2(ny / mag, nx / mag);
    radarAimReady = true;
    mouseAimActive = false;
  }

  /**
   * 刷新锁定瞄准：鼠标优先；否则保留雷达摇杆角；再否则读全局 look 摇杆。
   * 副作用：可能覆盖 lockAimAngle。
   */
  function refreshLockAimFromSticks() {
    if (mouseAimActive) return;
    if (radarAimReady) return;
    const look = window.LpTouchControls?.getLook?.();
    if (!look?.ready) return;
    const mag = Math.hypot(look.x, look.y);
    if (mag > 0.01) lockAimAngle = Math.atan2(look.y, look.x);
  }

  /**
   * 绘制相对列车前进的钟点与角度标注（12/0° = 前进，顺时针递增）。
   * 在 clip 外调用，避免字被 PPI 圆裁切。
   */
  function paintBearingLabels(cx, cy, radius, forwardSign) {
    const zero = forwardCanvasAngle(forwardSign);
    const tickOuter = radius;
    const tickInnerMajor = radius - 10;
    const tickInnerMinor = radius - 6;
    const clockR = radius + 11;
    const degR = radius - 18;

    ctx.strokeStyle = 'rgba(140, 255, 170, 0.55)';
    ctx.fillStyle = 'rgba(170, 255, 190, 0.92)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let deg = 0; deg < 360; deg += 45) {
      const ang = zero + (deg * Math.PI) / 180;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      const major = deg % 90 === 0;
      const inner = major ? tickInnerMajor : tickInnerMinor;
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + cos * inner, cy + sin * inner);
      ctx.lineTo(cx + cos * tickOuter, cy + sin * tickOuter);
      ctx.stroke();

      ctx.font = major
        ? '10px ui-monospace, SFMono-Regular, Menlo, monospace'
        : '9px ui-monospace, SFMono-Regular, Menlo, monospace';
      const degLabel = deg === 0 ? '0°' : `${deg}°`;
      ctx.fillText(degLabel, cx + cos * degR, cy + sin * degR);
    }

    const clocks = [
      { hour: 12, deg: 0 },
      { hour: 3, deg: 90 },
      { hour: 6, deg: 180 },
      { hour: 9, deg: 270 },
    ];
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(200, 255, 210, 0.95)';
    for (const c of clocks) {
      const ang = zero + (c.deg * Math.PI) / 180;
      ctx.fillText(String(c.hour), cx + Math.cos(ang) * clockR, cy + Math.sin(ang) * clockR);
    }
  }

  /**
   * 绘制锁定雷达扇区（填充 + 两侧亮边 + 外弧封闭 + 角平分线）。
   * 扇区半径为 min(LOCK_RANGE_WORLD_MAX, rangeWorld) 映射像素；量程 > 6000 时外弧停在半途表示超出锁定量程。
   */
  function paintLockSector(cx, cy, scale) {
    const a0 = lockAimAngle - LOCK_HALF_RAD;
    const a1 = lockAimAngle + LOCK_HALF_RAD;
    const lockWorldR = Math.min(LOCK_RANGE_WORLD_MAX, rangeWorld);
    const lockR = lockWorldR * scale;

    ctx.fillStyle = 'rgba(50, 200, 110, 0.14)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, lockR, a0, a1, false);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(170, 255, 190, 0.82)';
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * lockR, cy + Math.sin(a0) * lockR);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a1) * lockR, cy + Math.sin(a1) * lockR);
    ctx.stroke();

    /* 外弧：量程 ≤ 6000 贴 PPI 外缘；> 6000 时停在 6000 对应半径，封闭扇形 */
    ctx.strokeStyle = 'rgba(140, 255, 170, 0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, lockR - 0.5), a0, a1, false);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(210, 255, 220, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(lockAimAngle) * lockR,
      cy + Math.sin(lockAimAngle) * lockR
    );
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 画一帧 PPI。 */
  function drawFrame(now) {
    const cssW = canvas.clientWidth || 360;
    const cssH = canvas.clientHeight || 360;
    const cx = cssW / 2;
    const cy = cssH / 2;
    const radius = Math.min(cx, cy) - 10;
    const scale = radius / rangeWorld;

    refreshLockAimFromSticks();

    ctx.clearRect(0, 0, cssW, cssH);

    /* CRT 底 */
    const bg = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
    bg.addColorStop(0, '#06280a');
    bg.addColorStop(0.7, '#031805');
    bg.addColorStop(1, '#010901');
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    /* 量程环 */
    ctx.strokeStyle = 'rgba(80, 255, 120, 0.28)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 4; i += 1) {
      const r = (radius * i) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* 方位十字 */
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.strokeStyle = 'rgba(80, 255, 120, 0.22)';
    ctx.stroke();

    /* 铁轨：过站心的水平轨带（前进 = +X = 右） */
    const trackHalf = 22 * scale;
    ctx.fillStyle = 'rgba(60, 200, 100, 0.12)';
    ctx.fillRect(cx - radius, cy - trackHalf, radius * 2, trackHalf * 2);
    ctx.strokeStyle = 'rgba(100, 255, 140, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy - trackHalf);
    ctx.lineTo(cx + radius, cy - trackHalf);
    ctx.moveTo(cx - radius, cy + trackHalf);
    ctx.lineTo(cx + radius, cy + trackHalf);
    ctx.stroke();
    ctx.fillStyle = 'rgba(120, 255, 160, 0.45)';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.fillText('TRACK', cx - radius + 8, cy - trackHalf - 4);

    /* 搜索雷达扫描线 */
    sweepAngle = ((now / 1000) * 1.35) % (Math.PI * 2);
    const sweepGrad = ctx.createConicGradient(sweepAngle - Math.PI / 2, cx, cy);
    sweepGrad.addColorStop(0, 'rgba(80, 255, 120, 0.35)');
    sweepGrad.addColorStop(0.08, 'rgba(80, 255, 120, 0)');
    sweepGrad.addColorStop(1, 'rgba(80, 255, 120, 0)');
    ctx.fillStyle = sweepGrad;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, sweepAngle - 0.9, sweepAngle, false);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(180, 255, 190, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(sweepAngle) * radius, cy + Math.sin(sweepAngle) * radius);
    ctx.stroke();

    /* 锁定雷达扇区（在接触点之下，便于读标；有效半径 capped 于 LOCK_RANGE_WORLD_MAX） */
    paintLockSector(cx, cy, scale);

    /** 画接触点；友方车厢为长方形。 */
    function paintContact(c, style) {
      const p = worldToScope(c.x, c.y);
      const sx = cx + p.x * scale;
      const sy = cy + p.y * scale;
      const dist = Math.hypot(p.x, p.y);
      if (dist > rangeWorld * 1.05) return;
      ctx.save();
      ctx.translate(sx, sy);
      if (style === 'own' || style === 'own-scope') {
        const w = style === 'own-scope' ? 12 : 10;
        const h = style === 'own-scope' ? 7 : 6;
        ctx.strokeStyle = style === 'own-scope' ? '#b8ffc8' : '#5dff8a';
        ctx.fillStyle = 'rgba(80, 255, 120, 0.35)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.rect(-w / 2, -h / 2, w, h);
        ctx.fill();
        ctx.stroke();
        if (c.label) {
          ctx.fillStyle = 'rgba(180, 255, 200, 0.9)';
          ctx.font = '9px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(c.label, 0, h / 2 + 11);
        }
      } else if (style === 'hostile') {
        ctx.strokeStyle = '#ff6b4a';
        ctx.lineWidth = 2;
        ctx.strokeRect(-5, -5, 10, 10);
      } else if (style === 'train') {
        ctx.fillStyle = '#7ec8ff';
        ctx.fillRect(-6, -2, 12, 4);
      } else {
        ctx.fillStyle = '#9dffb0';
        ctx.beginPath();
        ctx.arc(0, 0, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    for (const car of ownTrainCenters()) {
      paintContact(car, car.kind);
    }
    for (const c of externalContacts) {
      paintContact(c, c.kind || 'contact');
    }

    /* 站心十字 = 本站（绘轨） */
    ctx.strokeStyle = 'rgba(220, 255, 230, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx - 6, cy);
    ctx.lineTo(cx + 6, cy);
    ctx.moveTo(cx, cy - 6);
    ctx.lineTo(cx, cy + 6);
    ctx.stroke();

    ctx.restore();

    /* 外圈 + 方位/角度标注（12/0° = 列车前进） */
    ctx.strokeStyle = 'rgba(120, 255, 160, 0.65)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    paintBearingLabels(cx, cy, radius, resolveForwardSign());

    if (rangeReadout) {
      rangeReadout.textContent = `量程 ${Math.round(rangeWorld)}`;
    }
    if (modeReadout) {
      modeReadout.textContent = `接触 ${ownTrainCenters().length + externalContacts.length} · PPI`;
    }
  }

  /** 动画循环。 */
  function tick(now) {
    if (!open) return;
    drawFrame(now);
    raf = requestAnimationFrame(tick);
  }

  /** 打开示波器；量程吸附到 RANGE_GEARS 档位。 */
  function openPanel() {
    if (open) return;
    open = true;
    clampRangeWorld();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-radar-panel-open');
    resizeCanvas();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(tick);
  }

  /** 关闭示波器。 */
  function closePanel() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-radar-panel-open');
    cancelAnimationFrame(raf);
    raf = 0;
    resetRadarAimKnob();
  }

  closeBtn?.addEventListener('click', () => closePanel());
  root.querySelector('.lp-radar-backdrop')?.addEventListener('click', () => closePanel());
  window.addEventListener('resize', () => {
    if (open) resizeCanvas();
  });

  /*
   * 桌面：全页 mousemove 驱动锁定扇区（相对 PPI 中心取角）；
   * 搜索 360° 扫描线不跟随鼠标。移动端用下方瞄准摇杆。
   */
  window.addEventListener('mousemove', (event) => {
    if (!open || radarAimPointer !== null) return;
    aimFromCanvasClient(event.clientX, event.clientY);
  });

  /* 滚轮调量程：每格一档，吸附 RANGE_GEARS */
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!open) return;
      event.preventDefault();
      stepRangeGear(event.deltaY > 0 ? -1 : 1);
    },
    { passive: false }
  );

  /* 移动端：双指捏合调量程；松手与移动均吸附最近档 */
  let pinchStartDist = 0;
  let pinchStartRange = rangeWorld;
  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (!open || event.touches.length !== 2) return;
      const a = event.touches[0];
      const b = event.touches[1];
      pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchStartRange = rangeWorld;
    },
    { passive: true }
  );
  canvas.addEventListener(
    'touchmove',
    (event) => {
      if (!open || event.touches.length !== 2 || pinchStartDist < 8) return;
      event.preventDefault();
      const a = event.touches[0];
      const b = event.touches[1];
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const next = pinchStartRange * (pinchStartDist / Math.max(8, dist));
      setRangeWorld(next);
    },
    { passive: false }
  );
  canvas.addEventListener(
    'touchend',
    () => {
      if (pinchStartDist > 0) {
        clampRangeWorld();
        pinchStartDist = 0;
      }
    },
    { passive: true }
  );

  document.getElementById('lpRadarRangeFar')?.addEventListener('click', () => {
    if (open) stepRangeGear(1);
  });
  document.getElementById('lpRadarRangeNear')?.addEventListener('click', () => {
    if (open) stepRangeGear(-1);
  });

  /* 量程档位拉杆：拖拽 / 键盘上下 */
  buildRangeNotches();
  if (rangeTrack) {
    rangeTrack.addEventListener('pointerdown', (event) => {
      if (!open || rangeGearPointer !== null) return;
      event.preventDefault();
      rangeGearPointer = event.pointerId;
      rangeTrack.setPointerCapture(event.pointerId);
      applyRangeGearPointer(event.clientY);
    });
    rangeTrack.addEventListener('pointermove', (event) => {
      if (event.pointerId !== rangeGearPointer) return;
      applyRangeGearPointer(event.clientY);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      rangeTrack.addEventListener(eventName, (event) => {
        if (event.pointerId === rangeGearPointer) {
          rangeGearPointer = null;
          clampRangeWorld();
        }
      });
    }
    rangeTrack.addEventListener('keydown', (event) => {
      if (!open) return;
      if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        stepRangeGear(1);
      } else if (event.key === 'ArrowDown' || event.key === 'PageDown') {
        event.preventDefault();
        stepRangeGear(-1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        setRangeWorld(RANGE_WORLD_MAX);
      } else if (event.key === 'End') {
        event.preventDefault();
        setRangeWorld(RANGE_WORLD_MIN);
      }
    });
  }
  syncRangeGearUi();

  /* 移动端：雷达面板内锁定瞄准摇杆（复用 look 摇杆交互模式） */
  if (aimStick && aimKnob) {
    aimStick.addEventListener('pointerdown', (event) => {
      if (!open || radarAimPointer !== null) return;
      event.preventDefault();
      radarAimPointer = event.pointerId;
      updateRadarAimStick(event.clientX, event.clientY);
      aimStick.setPointerCapture(event.pointerId);
    });
    aimStick.addEventListener('pointermove', (event) => {
      if (event.pointerId === radarAimPointer) {
        updateRadarAimStick(event.clientX, event.clientY);
      }
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      aimStick.addEventListener(eventName, (event) => {
        if (event.pointerId === radarAimPointer) resetRadarAimKnob();
      });
    }
  }

  window.LpRadarScope = {
    isOpen,
    open: openPanel,
    close: closePanel,
    setContacts,
    upsertContact,
    /** 外部接触点副本（供自动化传感器等读取）。 */
    getContacts: () => externalContacts.map((c) => ({ ...c })),
    getRange: () => rangeWorld,
    setRange: (v) => {
      setRangeWorld(Number(v) || rangeWorld);
    },
    /** 量程档位表副本（1200 步进至 PPI 上限）。 */
    getRangeGears: () => RANGE_GEARS.slice(),
    /** 锁定扇区有效半径上限（世界像素）。 */
    getLockRangeMax: () => LOCK_RANGE_WORLD_MAX,
    /** 锁定扇区总张角（度）。 */
    getLockBeamWidthDeg: () => LOCK_BEAM_WIDTH_DEG,
    /** 当前锁定角平分线弧度。 */
    getLockAimAngle: () => lockAimAngle,
  };
})();
