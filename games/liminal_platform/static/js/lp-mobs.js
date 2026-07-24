/**
 * 小怪占位（圆形）：地面沿轨跑到车头/车尾再跳入车厢，空中经连接处进入后在舱内漂浮；本地 AI，触碰击飞由宿主处理。
 * 视觉轨见 LpTrack（TRACK_Y）；本模块只读 Spec / 轨高做寻路，不改绘轨层序。
 * 命中半径即 profile.radius（弹道 / 玩家碰撞随放大同步）。
 */
(() => {
  const GROUND = {
    kind: 'ground',
    radius: 24,
    color: '#c45c26',
    stroke: '#7a3010',
    speed: 95,
    /** 轨面起跳 → 舱内落地的时长（秒）。 */
    jumpDuration: 0.58,
    /** 抛物线顶点相对起落连线的抬升（贴图像素，经 scaleArt）。 */
    jumpPeakArt: 110,
    hp: 18,
    damage: 12,
    knock: 420,
  };
  const AIR = {
    kind: 'air',
    radius: 17,
    color: '#5b8def',
    stroke: '#1e3a8a',
    speed: 120,
    diveSpeed: 95,
    hp: 10,
    damage: 8,
    knock: 360,
  };

  /**
   * 波次导演：密集产出一段时间，再平静一段时间，循环。
   * 调这里即可改节奏；平静期内不刷怪（场上已有怪继续行动）。
   */
  const WAVE = {
    /** 密集产出时长（秒）。 */
    duration: 16,
    /** 平静（不刷）时长（秒）。 */
    calmDuration: 22,
    /** 波内两次尝试刷怪的间隔下限（秒）。 */
    spawnIntervalMin: 0.5,
    /** 波内间隔上限（秒）；实际取 [min, max] 随机。 */
    spawnIntervalMax: 0.95,
    /** 场上地面怪上限。 */
    maxGround: 4,
    /** 场上空中怪上限。 */
    maxAir: 3,
    /** 开局 / reset 后先进入的阶段：'wave' | 'calm'。 */
    startPhase: 'wave',
    /** 进入 wave 后首次刷怪前的短延迟（秒）。 */
    waveLeadIn: 0.35,
  };

  const HIT_COOLDOWN = 0.85;
  /** 受击闪白时长（秒）。 */
  const HIT_FLASH_LIFE = 0.12;
  /** 轨面圆心相对 TRACK_Y 上移（半圆贴轨）。 */
  const RAIL_CENTER_LIFT = 0;
  /** 刷怪相对视野再外扩的半径倍率，避免边缘半露。 */
  const SPAWN_VIEW_PAD = 1.35;

  /** @type {Array<ReturnType<typeof createMob>>} */
  let mobs = [];
  let nextId = 1;
  /** @type {'wave' | 'calm'} */
  let wavePhase = WAVE.startPhase === 'calm' ? 'calm' : 'wave';
  /** 当前阶段剩余秒数。 */
  let phaseTimer = WAVE.startPhase === 'calm' ? WAVE.calmDuration : WAVE.duration;
  /** 波内下一次刷怪尝试倒计时（秒）；平静期忽略。 */
  let spawnTimer = WAVE.waveLeadIn;
  /**
   * 最近一帧相机世界视野（由宿主 tick/reset 写入）。
   * @type {{ left: number, right: number, top: number, bottom: number } | null}
   */
  let lastViewWorld = null;

  /** 读取车厢规格。 */
  function spec() {
    return window.LiminalCarriageSpec || null;
  }

  /** 轨面世界 Y（与 LpTrack / 弹道地面同高）。 */
  function railY(S) {
    return S.TRACK_Y - RAIL_CENTER_LIFT;
  }

  /**
   * 由相机参数换算世界视野矩形（屏幕四角 → 世界）。
   * @param {{ zoom: number, offsetX: number, offsetY: number } | null | undefined} view
   * @param {number} viewW
   * @param {number} viewH
   * @returns {{ left: number, right: number, top: number, bottom: number } | null}
   */
  function viewWorldRect(view, viewW, viewH) {
    if (!view || !(view.zoom > 0) || !(viewW > 0) || !(viewH > 0)) return null;
    const z = view.zoom;
    return {
      left: (0 - view.offsetX) / z,
      right: (viewW - view.offsetX) / z,
      top: (0 - view.offsetY) / z,
      bottom: (viewH - view.offsetY) / z,
    };
  }

  /**
   * 记住宿主传入的视野，供地面/空中刷怪使用。
   * @param {{ view?: object, viewW?: number, viewH?: number } | null | undefined} ctx
   */
  function rememberView(ctx) {
    if (!ctx) return lastViewWorld;
    const rect = viewWorldRect(ctx.view, Number(ctx.viewW) || 0, Number(ctx.viewH) || 0);
    if (rect) lastViewWorld = rect;
    return lastViewWorld;
  }

  /**
   * 圆（中心 + 半径外扩）是否完全在视野外。
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {{ left: number, right: number, top: number, bottom: number } | null} rect
   */
  function isFullyOutsideView(x, y, radius, rect) {
    if (!rect) return true;
    const pad = radius * SPAWN_VIEW_PAD;
    return (
      x + pad < rect.left ||
      x - pad > rect.right ||
      y + pad < rect.top ||
      y - pad > rect.bottom
    );
  }

  /**
   * 编组左右外沿世界 X（再外扩 pad），供地面怪屏外刷点（仍须沿轨跑到车头/车尾再跳入）。
   * @param {object} S
   * @param {number} pad
   */
  function trainFlankXs(S, pad) {
    const cars = S.CARRIAGES;
    return {
      left: cars[0].worldX - pad,
      right: cars[cars.length - 1].worldX + S.MODULE_W + pad,
    };
  }

  /**
   * 相邻车厢走道之间的连接缝（空中小怪入口）。
   * @returns {Array<{ x: number, left: number, right: number, floorY: number, carLeftId: string, carRightId: string }>}
   */
  function listCouplerGaps(S) {
    const gaps = [];
    const cars = S.CARRIAGES;
    for (let i = 0; i < cars.length - 1; i += 1) {
      const a = cars[i];
      const b = cars[i + 1];
      const left = a.worldX + S.WALK_RIGHT;
      const right = b.worldX + S.WALK_LEFT;
      if (right <= left) continue;
      gaps.push({
        x: (left + right) * 0.5,
        left,
        right,
        floorY: S.FLOOR_Y,
        carLeftId: a.id,
        carRightId: b.id,
      });
    }
    return gaps;
  }

  /**
   * 地面小怪进入点：仅编组车尾（世界 X 最小）或车头（世界 X 最大；前进 +X）。
   * 返回轨面起跳 X 与舱内落点；禁止从中段车厢侧面进入。
   * @param {'tail'|'head'|null|undefined} [preferEnd]
   */
  function pickGroundEntry(S, preferEnd) {
    const cars = S.CARRIAGES;
    if (!cars.length) return null;
    const useTail =
      preferEnd === 'tail' || (preferEnd !== 'head' && Math.random() < 0.5);
    const car = useTail ? cars[0] : cars[cars.length - 1];
    const inset = S.scaleArt(72);
    const jumpX = useTail ? car.worldX + S.WALK_LEFT : car.worldX + S.WALK_RIGHT;
    const floorX = useTail
      ? Math.min(car.worldX + S.WALK_RIGHT - inset, jumpX + inset)
      : Math.max(car.worldX + S.WALK_LEFT + inset, jumpX - inset);
    return {
      carId: car.id,
      end: useTail ? 'tail' : 'head',
      jumpX,
      floorX,
      floorY: S.FLOOR_Y,
    };
  }

  /** 创建一只小怪实体。 */
  function createMob(profile, x, y, extra = {}) {
    return {
      id: `mob-${nextId++}`,
      kind: profile.kind,
      x,
      y,
      radius: profile.radius,
      color: profile.color,
      stroke: profile.stroke,
      speed: profile.speed,
      hp: profile.hp,
      maxHp: profile.hp,
      damage: profile.damage,
      knock: profile.knock,
      phase: extra.phase || 'approach',
      targetX: extra.targetX ?? x,
      targetY: extra.targetY ?? y,
      climbSpeed: profile.climbSpeed || profile.diveSpeed || profile.speed,
      jumpDuration: profile.jumpDuration || 0.58,
      jumpPeakArt: profile.jumpPeakArt || 110,
      hitCd: 0,
      hitFlash: 0,
      bob: Math.random() * Math.PI * 2,
      alive: true,
      /** 本帧世界速度（px/s）；供炮塔提前量。 */
      vx: 0,
      vy: 0,
      /** 护甲 stub（锁定「护甲最高/最低」用；暂无减伤）。 */
      armor: 0,
      ...extra,
    };
  }

  /**
   * 线段与圆相交：返回沿线段参数 t∈[0,1] 的最近点；未命中返回 null。
   * @returns {{ t: number, x: number, y: number } | null}
   */
  function segmentCircleHit(x0, y0, x1, y1, cx, cy, radius) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const fx = x0 - cx;
    const fy = y0 - cy;
    const a = dx * dx + dy * dy;
    if (a < 1e-10) {
      if (fx * fx + fy * fy > radius * radius) return null;
      return { t: 0, x: x0, y: y0 };
    }
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - radius * radius;
    let disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    disc = Math.sqrt(disc);
    const inv = 0.5 / a;
    const t1 = (-b - disc) * inv;
    const t2 = (-b + disc) * inv;
    let t = null;
    if (t1 >= 0 && t1 <= 1) t = t1;
    if (t2 >= 0 && t2 <= 1 && (t == null || t2 < t)) t = t2;
    if (t == null) return null;
    return { t, x: x0 + dx * t, y: y0 + dy * t };
  }

  /**
   * 弹道线段探测最近存活怪（不扣血）；供战斗层与地面冲击比远近。
   * @returns {{ id: string, t: number, x: number, y: number, mob: object } | null}
   */
  function probeSegmentHit(x0, y0, x1, y1) {
    let best = null;
    for (const m of mobs) {
      if (!isMobCombatActive(m)) continue;
      const hit = segmentCircleHit(x0, y0, x1, y1, m.x, m.y, m.radius);
      if (!hit) continue;
      if (!best || hit.t < best.t) {
        best = { id: m.id, t: hit.t, x: hit.x, y: hit.y, mob: m };
      }
    }
    return best;
  }

  /**
   * 地面怪：轨面 Y，X 在编组左/右屏外；入口固定为同侧车尾/车头。
   * @param {object} S
   */
  function spawnGround(S) {
    const cars = S.CARRIAGES;
    if (!cars.length) return null;
    const spanPad = S.scaleArt(180);
    const flanks = trainFlankXs(S, spanPad);
    const rect = lastViewWorld;
    const margin = GROUND.radius * SPAWN_VIEW_PAD + S.scaleArt(24);
    const fromLeft = Math.random() < 0.5;
    const entry = pickGroundEntry(S, fromLeft ? 'tail' : 'head');
    if (!entry) return null;
    let x = fromLeft ? flanks.left : flanks.right;
    if (rect) {
      x = fromLeft
        ? Math.min(x, rect.left - margin)
        : Math.max(x, rect.right + margin);
    }
    const y = railY(S);
    return createMob(GROUND, x, y, {
      phase: 'rail',
      targetX: entry.jumpX,
      targetY: y,
      jumpX: entry.jumpX,
      floorX: entry.floorX,
      floorY: entry.floorY,
      carId: entry.carId,
      entryEnd: entry.end,
    });
  }

  /**
   * 空中怪：以连接缝为入舱目标，出生点在视野外（优先屏上缘，必要时左右侧）。
   * @param {object} S
   */
  function spawnAir(S) {
    const gaps = listCouplerGaps(S);
    if (!gaps.length) return null;
    const gap = gaps[Math.floor(Math.random() * gaps.length)];
    const side = Math.random() < 0.5 ? -1 : 1;
    let x = gap.x + side * S.scaleArt(40 + Math.random() * 120);
    let hoverY = S.FLOOR_Y - S.scaleArt(220) - Math.random() * S.scaleArt(80);
    const rect = lastViewWorld;
    const margin = AIR.radius * SPAWN_VIEW_PAD + S.scaleArt(24);
    if (rect) {
      hoverY = Math.min(hoverY, rect.top - margin - Math.random() * S.scaleArt(60));
      if (!isFullyOutsideView(x, hoverY, AIR.radius, rect)) {
        x = Math.random() < 0.5 ? rect.left - margin : rect.right + margin;
        hoverY = Math.min(hoverY, rect.top - margin);
      }
    }
    const band = cabinAirBand(S, AIR.radius);
    const diveY = band.highY + (band.lowY - band.highY) * 0.4;
    return createMob(AIR, x, hoverY, {
      phase: 'dive',
      targetX: gap.x,
      targetY: diveY,
      gapLeft: gap.left,
      gapRight: gap.right,
      floorY: gap.floorY,
      enterX: gap.x + (Math.random() - 0.5) * Math.min(40, (gap.right - gap.left) * 0.4),
      carLeftId: gap.carLeftId,
      carRightId: gap.carRightId,
    });
  }

  /** 统计存活某类数量。 */
  function countKind(kind) {
    let n = 0;
    for (const m of mobs) {
      if (isMobCombatActive(m) && m.kind === kind) n += 1;
    }
    return n;
  }

  /** 波内下一次刷怪间隔（秒）。 */
  function nextSpawnInterval() {
    const lo = WAVE.spawnIntervalMin;
    const hi = Math.max(lo, WAVE.spawnIntervalMax);
    return lo + Math.random() * (hi - lo);
  }

  /** 进入指定波次阶段并重置该阶段计时。 */
  function enterWavePhase(phase) {
    wavePhase = phase === 'calm' ? 'calm' : 'wave';
    phaseTimer = wavePhase === 'calm' ? WAVE.calmDuration : WAVE.duration;
    spawnTimer = wavePhase === 'wave' ? WAVE.waveLeadIn : 0;
  }

  /**
   * 波次导演：推进 wave/calm，仅在 wave 内按间隔尝试刷怪（受 caps 限制）。
   * @param {object} S
   * @param {number} dt
   */
  function tickWaveDirector(S, dt) {
    phaseTimer -= dt;
    if (phaseTimer <= 0) {
      enterWavePhase(wavePhase === 'wave' ? 'calm' : 'wave');
    }
    if (wavePhase !== 'wave') return;

    spawnTimer -= dt;
    if (spawnTimer > 0) return;
    spawnTimer = nextSpawnInterval();

    if (countKind('ground') < WAVE.maxGround) {
      const g = spawnGround(S);
      if (g) mobs.push(g);
    }
    if (countKind('air') < WAVE.maxAir) {
      const a = spawnAir(S);
      if (a) mobs.push(a);
    }
  }

  /** 向目标点匀速靠近；到达返回 true。 */
  function moveToward(m, tx, ty, speed, dt) {
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 1.5) {
      m.x = tx;
      m.y = ty;
      return true;
    }
    const step = Math.min(dist, speed * dt);
    m.x += (dx / dist) * step;
    m.y += (dy / dist) * step;
    return dist - step <= 1.5;
  }

  /**
   * 进入跳入阶段：记录起落点，用抛物线弧进舱（非侧面爬升）。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   */
  function beginGroundJump(m, S) {
    const landY = m.floorY - m.radius * 0.15;
    m.phase = 'jump';
    m.jumpT = 0;
    m.jumpFromX = m.x;
    m.jumpFromY = m.y;
    m.jumpToX = m.floorX;
    m.jumpToY = landY;
    m.jumpPeak = S.scaleArt(m.jumpPeakArt || GROUND.jumpPeakArt);
    m.targetX = m.jumpToX;
    m.targetY = landY;
  }

  /**
   * 推进跳入抛物线；落地后切 inside 并在本车走道游荡。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {number} dt
   * @returns {boolean} 是否已落地进舱
   */
  function tickGroundJump(m, S, dt) {
    const dur = Math.max(0.12, m.jumpDuration || GROUND.jumpDuration);
    m.jumpT = (m.jumpT || 0) + dt / dur;
    const t = Math.min(1, m.jumpT);
    const peak = m.jumpPeak || S.scaleArt(GROUND.jumpPeakArt);
    m.x = m.jumpFromX + (m.jumpToX - m.jumpFromX) * t;
    const baseY = m.jumpFromY + (m.jumpToY - m.jumpFromY) * t;
    m.y = baseY - peak * 4 * t * (1 - t);
    if (t < 1) return false;

    m.x = m.jumpToX;
    m.y = m.jumpToY;
    m.phase = 'inside';
    const car = S.carriageById?.(m.carId) || S.CARRIAGES[0];
    m.targetX =
      car.worldX + S.WALK_LEFT + Math.random() * (S.WALK_RIGHT - S.WALK_LEFT);
    m.targetY = S.FLOOR_Y - m.radius * 0.15;
    return true;
  }

  /**
   * 地面：轨面横移到车头/车尾 → 跳入走道 → 舱内游荡。
   * @param {ReturnType<typeof createMob>} m
   */
  function tickGround(m, S, dt) {
    const ry = railY(S);
    if (m.phase === 'rail') {
      m.y = ry;
      if (moveToward(m, m.jumpX, ry, m.speed, dt)) {
        beginGroundJump(m, S);
      }
      return;
    }
    if (m.phase === 'jump') {
      tickGroundJump(m, S, dt);
      return;
    }
    /* inside：在走道内左右爬 */
    m.bob += dt * 6;
    const bobY = S.FLOOR_Y - m.radius * 0.15 + Math.sin(m.bob) * 1.5;
    if (moveToward(m, m.targetX, bobY, m.speed * 0.85, dt)) {
      const car = S.carriageById?.(m.carId) || S.CARRIAGES[0];
      m.targetX =
        car.worldX +
        S.WALK_LEFT +
        Math.random() * (S.WALK_RIGHT - S.WALK_LEFT);
    }
  }

  /**
   * 车厢舱内漂浮高度带（Y 向下为正）：偏高端靠近天花板，偏低端仍离地。
   * @returns {{ highY: number, lowY: number }}
   */
  function cabinAirBand(S, radius) {
    const highY = S.FLOOR_Y - S.scaleArt(240);
    const lowY = S.FLOOR_Y - S.scaleArt(72) - radius * 0.2;
    return { highY, lowY: Math.max(highY + 8, lowY) };
  }

  /** 在指定车厢走道水平范围内随机选一个舱内漂浮点。 */
  function pickCabinAirWander(m, S, car) {
    const band = cabinAirBand(S, m.radius);
    m.targetX =
      car.worldX +
      S.WALK_LEFT +
      Math.random() * (S.WALK_RIGHT - S.WALK_LEFT);
    m.targetY = band.highY + Math.random() * (band.lowY - band.highY);
  }

  /**
   * 空中：飞向连接缝 → 钻入舱空 → 在相邻车厢空气里漂浮游荡（不贴地）。
   * @param {ReturnType<typeof createMob>} m
   */
  function tickAir(m, S, dt) {
    m.bob += dt * 4.5;
    if (m.phase === 'dive') {
      const hover = m.targetY + Math.sin(m.bob) * 6;
      if (moveToward(m, m.targetX, hover, m.speed, dt)) {
        m.phase = 'enter';
        m.targetX = m.enterX;
        const band = cabinAirBand(S, m.radius);
        m.targetY = band.highY + (band.lowY - band.highY) * 0.45;
      }
      return;
    }
    if (m.phase === 'enter') {
      const band = cabinAirBand(S, m.radius);
      const enterY = band.highY + (band.lowY - band.highY) * 0.45 + Math.sin(m.bob) * 5;
      if (moveToward(m, m.enterX, enterY, m.climbSpeed, dt)) {
        m.phase = 'inside';
        const pickId = Math.random() < 0.5 ? m.carLeftId : m.carRightId;
        const car =
          S.carriageById?.(pickId) ||
          S.CARRIAGES[Math.floor(Math.random() * S.CARRIAGES.length)];
        m.carId = car.id;
        pickCabinAirWander(m, S, car);
      }
      return;
    }
    /* inside：舱内水平 + 高度游荡，正弦微漂 */
    const floatY = m.targetY + Math.sin(m.bob) * 7;
    if (moveToward(m, m.targetX, floatY, m.speed * 0.65, dt)) {
      const car = S.carriageById?.(m.carId) || S.CARRIAGES[0];
      pickCabinAirWander(m, S, car);
    }
  }

  /**
   * 与本地玩家圆-盒粗判；仅存活且舱内阶段可命中，否则不造成伤害/击退。
   * @param {{ x: number, y: number, halfW: number, height: number, invuln?: boolean }} player
   * @param {(hit: object) => void} [onHit]
   */
  function collidePlayer(m, player, onHit) {
    if (!canMobContactPlayer(m) || !player || m.hitCd > 0 || player.invuln) return;
    const px = player.x;
    const py = player.y - player.height * 0.45;
    const dx = m.x - px;
    const dy = m.y - py;
    const rx = m.radius + player.halfW;
    const ry = m.radius + player.height * 0.45;
    if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) return;

    const knockDir = dx === 0 && dy === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(-dx) || 1;
    m.hitCd = HIT_COOLDOWN;
    onHit?.({
      mobId: m.id,
      kind: m.kind,
      damage: m.damage,
      knockVx: knockDir * m.knock,
      knockVy: -Math.abs(m.knock) * 0.55,
      fromX: m.x,
      fromY: m.y,
    });
  }

  /**
   * 推进波次导演、AI、碰撞；并把敌方列表喂给自动化传感器。
   * @param {number} dt
   * @param {{ player?: object, onHit?: Function, view?: object, viewW?: number, viewH?: number }} [ctx]
   */
  function tick(dt, ctx = {}) {
    const S = spec();
    if (!S?.CARRIAGES?.length) return;
    rememberView(ctx);
    purgeDeadMobs();
    tickWaveDirector(S, dt);

    const player = ctx.player || null;
    const onHit = ctx.onHit;

    for (const m of mobs) {
      if (!isMobCombatActive(m)) continue;
      if (m.hitCd > 0) m.hitCd -= dt;
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
      const px = m.x;
      const py = m.y;
      if (m.kind === 'ground') tickGround(m, S, dt);
      else tickAir(m, S, dt);
      if (dt > 1e-6) {
        m.vx = (m.x - px) / dt;
        m.vy = (m.y - py) / dt;
      }
      collidePlayer(m, player, onHit);
    }

    purgeDeadMobs();
    window.LpAutoSensors?.setHostiles?.(listHostiles());
  }

  /** 在怪头顶画一截 HP 点条（满/损）。 */
  function drawHpPip(ctx, m) {
    const maxHp = Math.max(1, m.maxHp || m.hp || 1);
    const ratio = Math.max(0, Math.min(1, m.hp / maxHp));
    const w = Math.max(10, m.radius * 1.35);
    const h = 2.5;
    const x = m.x - w * 0.5;
    const y = m.y - m.radius - 6;
    ctx.fillStyle = 'rgba(15,23,42,0.55)';
    ctx.fillRect(x - 0.5, y - 0.5, w + 1, h + 1);
    ctx.fillStyle = '#334155';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = ratio > 0.35 ? '#4ade80' : '#f87171';
    ctx.fillRect(x, y, w * ratio, h);
  }

  /** 绘制圆形占位怪（世界坐标；应在车厢贴图之后调用以便可见）。 */
  function draw(ctx) {
    if (!ctx) return;
    for (const m of mobs) {
      if (!isMobCombatActive(m)) continue;
      ctx.save();
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.radius, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      if (m.hitFlash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${0.55 * (m.hitFlash / HIT_FLASH_LIFE)})`;
        ctx.fill();
      }
      ctx.lineWidth = Math.max(1.5, m.radius * 0.12);
      ctx.strokeStyle = m.stroke;
      ctx.stroke();
      /* 简易高光区分地面 / 空中 */
      ctx.beginPath();
      ctx.arc(
        m.x - m.radius * 0.28,
        m.y - m.radius * 0.28,
        m.radius * 0.28,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fill();
      drawHpPip(ctx, m);
      ctx.restore();
    }
  }

  /**
   * 是否视为「车厢内」：跳入/钻入/舱内游荡（轨面 / 空中俯冲中不算）。
   * @param {ReturnType<typeof createMob>} m
   */
  function isMobInsideCabin(m) {
    const p = m?.phase;
    return p === 'inside' || p === 'jump' || p === 'enter';
  }

  /**
   * 存活且仍有血：死亡/尸体不得参与碰撞、伤害、击退、弹道与锁定列表。
   * @param {ReturnType<typeof createMob> | null | undefined} m
   */
  function isMobCombatActive(m) {
    return Boolean(m && m.alive === true && m.hp > 0);
  }

  /**
   * 可对玩家造成接触伤害：必须存活，且处于跳入/钻入/舱内（避免轨面/俯冲穿地板幽灵击退）。
   * @param {ReturnType<typeof createMob> | null | undefined} m
   */
  function canMobContactPlayer(m) {
    return isMobCombatActive(m) && isMobInsideCabin(m);
  }

  /**
   * 立刻从列表剔除死亡怪，避免跳入/钻入阶段留下隐形碰撞体直到 tick 末尾；
   * 若有剔除则同步传感器，避免 setHostiles 残留死目标。
   */
  function purgeDeadMobs() {
    const before = mobs.length;
    mobs = mobs.filter((m) => isMobCombatActive(m));
    if (mobs.length !== before) {
      window.LpAutoSensors?.setHostiles?.(listHostiles());
    }
  }

  /** 供传感器 / 锁定 / 提前量：存活敌方摘要（含速度与护甲 stub）。 */
  function listHostiles() {
    return mobs
      .filter((m) => isMobCombatActive(m))
      .map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y,
        kind: m.kind,
        hp: m.hp,
        radius: m.radius,
        vx: m.vx || 0,
        vy: m.vy || 0,
        armor: m.armor || 0,
        phase: m.phase,
        inCabin: isMobInsideCabin(m),
      }));
  }

  /**
   * 清空小怪并重启波次（调试 / 开局）；波开始时各刷一对作开场压力。
   * @param {{ view?: object, viewW?: number, viewH?: number }} [ctx] 可选相机视野，保证开场刷怪也在屏外
   */
  function reset(ctx) {
    mobs = [];
    rememberView(ctx);
    enterWavePhase(WAVE.startPhase === 'calm' ? 'calm' : 'wave');
    const S = spec();
    if (!S || wavePhase !== 'wave') return;
    for (let i = 0; i < 2; i += 1) {
      const g = spawnGround(S);
      if (g) mobs.push(g);
    }
    for (let i = 0; i < 2; i += 1) {
      const a = spawnAir(S);
      if (a) mobs.push(a);
    }
  }

  /** 调试只读：当前波次阶段与剩余时间。 */
  function getWaveState() {
    return {
      phase: wavePhase,
      phaseTimer,
      spawnTimer,
      config: { ...WAVE },
    };
  }

  /**
   * 对指定怪造成伤害；触发受击闪白；hp≤0 立刻标记死亡并从列表剔除（防跳入/钻入幽灵碰撞）。
   * @returns {{ ok: boolean, killed: boolean, hp: number, maxHp: number } | null}
   */
  function damageMob(id, amount) {
    const m = mobs.find((mob) => mob.id === id && isMobCombatActive(mob));
    if (!m) return null;
    const dmg = Math.max(0, Number(amount) || 0);
    m.hp -= dmg;
    m.hitFlash = HIT_FLASH_LIFE;
    if (m.hp <= 0) {
      m.hp = 0;
      m.alive = false;
      m.hitCd = 0;
      purgeDeadMobs();
    }
    return {
      ok: true,
      killed: !m.alive,
      hp: m.hp,
      maxHp: m.maxHp,
    };
  }

  window.LpMobs = {
    tick,
    draw,
    reset,
    listHostiles,
    damageMob,
    probeSegmentHit,
    getWaveState,
    /** 可调波次参数（就地改数字即可热调；改 duration 等需等下阶段切换生效）。 */
    WAVE,
    /** 调试只读。 */
    getMobs: () => mobs.slice(),
  };
})();
