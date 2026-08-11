/**
 * 小怪：地面「保龄球」沿轨跑到车头/车尾再跳入车厢；巨型投掷保龄沿轨追车并向舱内投球（不进舱）；
 * 空中「气球」经连接处进入后在舱内漂浮。
 * 轨面怪经 LpTrack.scrollWithTrack 与轨同相；相对地速另加卷动补偿以保持对火车的接近感。
 * 封闭图形填充经 LpMobBubbleFill；视觉轨见 LpTrack（TRACK_Y）；本模块只读 Spec / 轨高做寻路。
 * 命中半径即 profile.radius（弹道 / 玩家碰撞随放大同步）。kind 仍为 ground|air（战斗/传感）。
 * 月台前后缓冲（LpPlatform.isNearPlatformMobSafeZone）：轨面/俯冲不朝火车靠拢，波次不刷列车怪；地牢追逐不受影响。
 * 列车行程 WAVE_PACKS：每程 seed⊕离站站序抽 mixed / bowling / balloon（boss 占位）；allowGround 含投掷种；地牢不受此表约束。
 * 地牢：敌房刷保龄球（贴地穿门追）+ 气球（房内漂浮）；走 LpDungeon.resolveBody，不穿实心墙。
 */
(() => {
  /** 地面保龄球：战斗角色 ground；显示名 / 物种 id 供雷达与调试。 */
  const GROUND = {
    kind: 'ground',
    species: 'bowling',
    label: '保龄球',
    radius: 26,
    color: '#2c2438',
    stroke: '#120e18',
    speed: 95,
    /** 轨面起跳 → 舱内落地的时长（秒）。 */
    jumpDuration: 0.58,
    /** 抛物线顶点相对起落连线的抬升（贴图像素，经 scaleArt）。 */
    jumpPeakArt: 110,
    hp: 18,
    damage: 12,
    knock: 420,
    canEnterCabin: true,
    scrollWithTrack: true,
  };
  /**
   * 巨型追车投掷保龄：更大造型；相对地速高于满巡航卷动，可从后方追上；
   * 向车厢内投掷小球；永不进舱（canEnterCabin=false）。
   */
  const THROWER = {
    kind: 'ground',
    species: 'bowling_thrower',
    label: '巨型保龄球',
    radius: 44,
    color: '#3a2430',
    stroke: '#1a0e14',
    /**
     * 相对地面的追车余速（px/s）；再叠加卷动补偿后，满巡航仍可从后方合拢。
     * 约 0.22×满巡航卷动（~3300）→ 余速 ~720。
     */
    speed: 720,
    jumpDuration: 0.58,
    jumpPeakArt: 110,
    hp: 48,
    damage: 14,
    knock: 480,
    canEnterCabin: false,
    scrollWithTrack: true,
    /** 两次投掷间隔（秒）。 */
    throwInterval: 2.1,
    /** 投出小球半径。 */
    throwRadius: 12,
    /** 投球水平初速量级（px/s）；实际按目标距离微调。 */
    throwSpeed: 640,
    /** 可贴车抛射的侧翼外距（世界 px）。 */
    throwStandoff: 70,
  };
  /** 空中气球：战斗角色 air（kind 稳定；species/label 供显示）。 */
  const AIR = {
    kind: 'air',
    species: 'balloon',
    label: '气球',
    radius: 18,
    color: '#1a2a4a',
    stroke: '#0c1528',
    speed: 120,
    diveSpeed: 95,
    hp: 10,
    damage: 8,
    knock: 360,
    canEnterCabin: true,
    scrollWithTrack: false,
  };

  /** 保龄球 / 气球泡泡色板（偏暖 vs 偏冷；RGB 供 LpMobBubbleFill）。 */
  const BOWLING_PALETTE = [
    [255, 107, 157],
    [255, 209, 102],
    [255, 159, 28],
    [199, 125, 255],
    [6, 214, 160],
    [247, 37, 133],
  ];
  const BALLOON_PALETTE = [
    [76, 201, 240],
    [128, 237, 153],
    [199, 125, 255],
    [144, 224, 239],
    [247, 37, 133],
    [255, 209, 102],
  ];

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
    /**
     * 场上地面怪上限。
     * 原 4；抬到 7 以容纳近车压力 + 中/远距雷达簇（每簇常 2 只）。
     */
    maxGround: 7,
    /**
     * 场上空中怪上限。
     * 原 3；抬到 5，同上。
     */
    maxAir: 5,
    /** 场上巨型投掷保龄上限（计入 maxGround）。 */
    maxThrower: 2,
    /** 地面簇主刷抽成投掷种的概率。 */
    throwerChance: 0.22,
    /** 开局 / reset 后先进入的阶段：'wave' | 'calm'。 */
    startPhase: 'wave',
    /** 进入 wave 后首次刷怪前的短延迟（秒）。 */
    waveLeadIn: 0.35,
  };

  /** 投掷保龄球弹道（飞向舱内；不随轨卷动）。 */
  /** @type {Array<{ x: number, y: number, vx: number, vy: number, r: number, damage: number, knock: number, life: number, fromId: string }>} */
  let thrownBalls = [];

  /**
   * 列车行程波次包（站→站一程一种组成）。
   * allowGround / allowAir 门控刷种；weight 相对权重抽选；boss 占位 weight:0，日后加 weight + tickBossPack 即可。
   */
  const WAVE_PACKS = {
    mixed: {
      id: 'mixed',
      label: '混合',
      allowGround: true,
      allowAir: true,
      weight: 50,
    },
    bowling: {
      id: 'bowling',
      label: '仅保龄球',
      allowGround: true,
      allowAir: false,
      weight: 25,
    },
    balloon: {
      id: 'balloon',
      label: '仅气球',
      allowGround: false,
      allowAir: true,
      weight: 25,
    },
    boss: {
      id: 'boss',
      label: 'Boss',
      allowGround: false,
      allowAir: false,
      weight: 0,
      reserved: true,
    },
  };

  /** 与 WAVE_PACKS 抽选混用的流盐（避免与地牢/雷达同 hash 撞车）。 */
  const WAVE_PACK_STREAM = 0x57415645;

  /** @type {typeof WAVE_PACKS[keyof typeof WAVE_PACKS]} */
  let activeWavePack = WAVE_PACKS.mixed;
  /** 当前包所绑定的离站站序；-1 表示尚未锁定。 */
  let activeWavePackLeg = -1;

  /**
   * 刷怪距编组侧翼的外扩（世界 px）与雷达环带权重。
   * 原点参考：绘轨站心（见 LpRadarScope）；默认量程 4800、锁定 6000。
   * 原先几乎只在侧翼/屏缘（≈ near），雷达上挤在编组附近；现偏中/外环。
   */
  const SPAWN_RANGE = {
    /** 近距外扩 [min,max]：贴侧翼，保近车压力（原行为 ≈ 0～数百）。 */
    nearExtraMin: 60,
    nearExtraMax: 320,
    /** 中距外扩：雷达中环。 */
    midExtraMin: 1600,
    midExtraMax: 3000,
    /** 远距外扩：雷达外环（仍落在默认/锁定量程内可辨）。 */
    farExtraMin: 3400,
    farExtraMax: 5400,
    /** 抽带权重（近/中/远）；合计不必为 1，按相对权重归一。 */
    nearWeight: 0.22,
    midWeight: 0.38,
    farWeight: 0.4,
    /**
     * 中/远距同簇伴侣数（主刷 + companions；≥ LpRadarScope MOB_CLUSTER_MIN=2 才成点）。
     * 近距不强制组簇，避免近车瞬时过挤。
     */
    midCompanions: 1,
    farCompanions: 1,
    /** 同簇相对主刷点的轴向抖动上限（须 < 雷达链接距 300）。 */
    clusterJitter: 110,
  };

  const HIT_COOLDOWN = 0.85;
  /** 受击闪白时长（秒）。 */
  const HIT_FLASH_LIFE = 0.12;
  /** 轨面圆心相对 TRACK_Y 上移（半圆贴轨）。 */
  const RAIL_CENTER_LIFT = 0;
  /** 刷怪相对视野再外扩的半径倍率，避免边缘半露。 */
  const SPAWN_VIEW_PAD = 1.35;

  /**
   * 地牢刷怪：相对相机 / 玩家的安全距与激活门槛。
   * 布局点只作候选；真正落点在接近时再算，避免进站视野中央 pop-in。
   */
  const DUNGEON_SPAWN = {
    /** 相对玩家脚点的最小水平间距（世界 px）。 */
    playerClearance: 160,
    /** 同房已刷怪之间的最小水平间距。 */
    minPeerGap: 72,
    /** 场上地牢怪上限（含未激活排队不占；激活时再检）。 */
    maxAlive: 12,
    /** 玩家到房间 AABB 的距离低于此则允许激活。 */
    activatePlayerDist: 620,
    /** 房间与视野相交检测时的外扩（世界 px）。 */
    activateViewPad: 96,
    /** 候选采样数（左右缘 + 布局点 + 随机）。 */
    candidateTries: 10,
  };

  /** 保龄球三脚爬行：周期频率（Hz，静止基速）；移动时再乘速度增益。 */
  const CRAWL_HZ = 1.35;
  /** 单脚前后跨步相对半径。 */
  const CRAWL_STRIDE = 0.22;
  /** 抬腿高度相对半径。 */
  const CRAWL_LIFT = 0.16;
  /** 脚球半径相对主体半径。 */
  const CRAWL_FOOT_R = 0.26;
  /** 三脚沿身基线间距（朝向局部 x，相对半径）。 */
  const CRAWL_BASE_X = [0.28, -0.05, -0.4];
  /** 三脚基线 y 偏置（相对半径；贴主体下方）。 */
  const CRAWL_BASE_Y = [0.5, 0.52, 0.48];

  /** 气球四卫星环绕角速度（rad/s）。 */
  const ORBIT_SPEED = 1.55;
  /** 环绕椭圆半轴（相对主体半径）。 */
  const ORBIT_RX = 0.98;
  const ORBIT_RY = 0.52;
  /** 卫星球半径相对主体半径。 */
  const ORBIT_SAT_R = 0.32;

  /**
   * 气球惯性漂浮：朝期望速度平滑加速（非瞬时转向）。
   * velSmooth / damp 越小越「飘」；arrive* 保证舱内换点与进舱不会卡死。
   */
  const AIR_MOVE = {
    /** 速度跟期望的响应（1/s）；原 moveToward 等价于无穷大（瞬时对准）。 */
    velSmooth: 2.4,
    /** 额外速度阻尼（1/s）；偏低保留滑行惯性。 */
    damp: 0.25,
    /** 近目标减速半径（px）。 */
    slowRadius: 52,
    /** 到达判定距离（px）；原 moveToward 为 1.5。 */
    arriveDist: 14,
    /** 到达时允许的最大速率（px/s）。 */
    arriveSpeed: 40,
  };

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
  /**
   * 地牢待激活刷点（进站只入队；接近房间 / 视野边缘再物化）。
   * @type {Array<{
   *   spot: object,
   *   room: object | null,
   *   floorY: number,
   *   ceilingY: number,
   *   species: string,
   * }>}
   */
  let pendingDungeonSpawns = [];

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

  /** 最近一帧 dt（供 draw → bubble fill beginFrame）。 */
  let lastDt = 1 / 60;

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
   * 圆是否与视野矩形相交（含半径垫）。
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {{ left: number, right: number, top: number, bottom: number } | null} rect
   */
  function intersectsView(x, y, radius, rect) {
    if (!rect) return false;
    const pad = radius * SPAWN_VIEW_PAD;
    return !(
      x + pad < rect.left ||
      x - pad > rect.right ||
      y + pad < rect.top ||
      y - pad > rect.bottom
    );
  }

  /**
   * 列车波次偏好侧翼：卷动前进时偏车头（右），否则偏更靠屏外的一侧。
   * @param {object} S
   * @returns {boolean} true = 从左侧翼刷
   */
  function preferTrainSpawnFromLeft(S) {
    const dScroll = Number(window.LpTrack?.getLastScrollDelta?.()) || 0;
    /* 正卷动：轨面向 −X，旅行朝 +X → 车头/右侧更像「前方」。 */
    if (dScroll > 0.35) return false;
    if (dScroll < -0.35) return true;
    const rect = lastViewWorld;
    if (!rect || !S?.CARRIAGES?.length) return Math.random() < 0.5;
    const flanks = trainFlankXs(S, S.scaleArt(180));
    const leftOutside = rect.left - flanks.left;
    const rightOutside = flanks.right - rect.right;
    if (Math.abs(leftOutside - rightOutside) < 40) return Math.random() < 0.5;
    return leftOutside >= rightOutside;
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

  /** 创建一只小怪实体（含显示名 / 物种；种籽供泡泡 VFX 稳定）。 */
  function createMob(profile, x, y, extra = {}) {
    const uid = nextId++;
    return {
      id: `mob-${uid}`,
      kind: profile.kind,
      species: profile.species || profile.kind,
      label: profile.label || profile.kind,
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
      /** 是否允许跳入/钻入车厢；投掷种为 false。 */
      canEnterCabin: profile.canEnterCabin !== false,
      /**
       * 轨面锚定：本帧随 LpTrack.scrollWithTrack 平移（与尘土/白标同相）。
       * 进舱后应关掉；地牢房内默认 false。
       */
      scrollWithTrack: !!profile.scrollWithTrack,
      throwInterval: profile.throwInterval || 0,
      throwRadius: profile.throwRadius || 12,
      throwSpeed: profile.throwSpeed || 0,
      throwStandoff: profile.throwStandoff || 70,
      throwCd: 0,
      hitCd: 0,
      hitFlash: 0,
      bob: Math.random() * Math.PI * 2,
      /** 泡泡填充确定性种籽。 */
      vfxSeed: uid * 17.13 + Math.random() * 8,
      alive: true,
      /** 本帧世界速度（px/s）；供炮塔提前量。 */
      vx: 0,
      vy: 0,
      /** 气球惯性积分速度（仅 air / glideToward 使用）。 */
      gx: 0,
      gy: 0,
      /** 护甲 stub（锁定「护甲最高/最低」用；暂无减伤）。 */
      armor: 0,
      ...extra,
    };
  }

  /**
   * 当前轨面卷动速率（世界 px/s）；火车前进时为正，锚定物世界 X 每秒减少该值。
   * @returns {number}
   */
  function trackScrollSpeedPx() {
    const spd = Number(window.LpTrainDrive?.getState?.()?.speed) || 0;
    const rate = Number(window.LpTrack?.getScrollPxPerSpeed?.()) || 0;
    return spd * rate;
  }

  /**
   * 朝目标奔跑时抵消轨面卷动所需的速度补偿（仅对抗方向）。
   * 与 scrollWithTrack 联用，使 profile.speed 仍表示「相对火车」的合拢余速。
   * @param {number} fromX
   * @param {number} toX
   * @returns {number}
   */
  function trackScrollAssistToward(fromX, toX) {
    const scrollSpd = trackScrollSpeedPx();
    if (!(Math.abs(scrollSpd) > 1e-3)) return 0;
    if (toX > fromX && scrollSpd > 0) return scrollSpd;
    if (toX < fromX && scrollSpd < 0) return Math.abs(scrollSpd);
    return 0;
  }

  /**
   * 轨面锚定怪本帧随轨平移（LpTrack.scrollWithTrack）。
   * @param {ReturnType<typeof createMob>} m
   */
  function applyMobTrackScroll(m) {
    if (!m?.scrollWithTrack) return;
    const fn = window.LpTrack?.scrollWithTrack || window.LpTrack?.applyTrackScroll;
    fn?.(m);
  }

  /**
   * 轨面相对奔跑速度 = 物种余速 + 卷动对抗补偿。
   * @param {ReturnType<typeof createMob>} m
   * @param {number} targetX
   * @param {number} [mul]
   * @returns {number}
   */
  function railRunSpeed(m, targetX, mul = 1) {
    const base = (Number(m.speed) || 0) * mul;
    return base + trackScrollAssistToward(m.x, targetX);
  }

  /** 是否为永不进舱的轨面投掷种。 */
  function isRailThrower(m) {
    return m?.species === 'bowling_thrower' || m?.canEnterCabin === false;
  }

  /** 统计存活某物种数量。 */
  function countSpecies(species) {
    let n = 0;
    for (const m of mobs) {
      if (isMobCombatActive(m) && m.species === species) n += 1;
    }
    return n;
  }

  /**
   * 保龄球轨面/舱内地心 Y：脚球贴地，主体略抬高（相对命中圆心）。
   * @param {number} floorOrRailY
   * @param {number} radius
   */
  function bowlingCenterY(floorOrRailY, radius) {
    return floorOrRailY - radius * 0.42;
  }

  /**
   * 侧视朝向：优先水平速度，否则朝目标点。
   * @param {ReturnType<typeof createMob>} m
   * @returns {1|-1}
   */
  function facingSign(m) {
    if (Math.abs(m.vx) > 12) return m.vx > 0 ? 1 : -1;
    if (m.targetX != null && Math.abs(m.targetX - m.x) > 4) {
      return m.targetX > m.x ? 1 : -1;
    }
    return 1;
  }

  /**
   * 视觉动画时钟（秒）；与泡泡帧时钟解耦，仅驱动爬行/环绕。
   * @returns {number}
   */
  function animTimeSec() {
    return performance.now() * 0.001;
  }

  /**
   * 保龄球三脚爬行位姿：相位错开 120°，抬腿前送、着地后蹬（侧视可读）。
   * 不改 m.x/m.y / bowlingCenterY / 命中半径，只返回绘制坐标。
   * @param {ReturnType<typeof createMob>} m
   * @param {number} r
   * @param {1|-1} f
   * @returns {{ x: number, y: number, rad: number, i: number }[]}
   */
  function bowlingCrawlFeet(m, r, f) {
    const speedGain = Math.min(1.85, 0.55 + Math.abs(m.vx || 0) / 85);
    const t =
      animTimeSec() * CRAWL_HZ * speedGain * Math.PI * 2 + (m.vfxSeed || 0);
    const footR = r * CRAWL_FOOT_R;
    /** @type {{ x: number, y: number, rad: number, i: number }[]} */
    const feet = [];
    for (let i = 0; i < 3; i += 1) {
      const phase = t + (i * Math.PI * 2) / 3;
      const swing = Math.sin(phase);
      const lift = Math.max(0, Math.cos(phase)) * r * CRAWL_LIFT;
      const stride = swing * r * CRAWL_STRIDE;
      feet.push({
        x: m.x + f * (CRAWL_BASE_X[i] * r + stride),
        y: m.y + CRAWL_BASE_Y[i] * r - lift,
        rad: footR * (i === 1 ? 0.95 : 1),
        i,
      });
    }
    // 抬起（更小 y）先画，着地后画。
    feet.sort((a, b) => a.y - b.y);
    return feet;
  }

  /**
   * 气球四卫星环绕位姿：十字等分相位 + 扁椭圆；按 depth 从后往前排。
   * 纯外观；命中仍用主体 m.radius。
   * @param {ReturnType<typeof createMob>} m
   * @param {number} r
   * @param {number} cy 主体中心 Y（含 bob）
   * @returns {{ x: number, y: number, rad: number, depth: number, i: number }[]}
   */
  function balloonOrbitSats(m, r, cy) {
    const t = animTimeSec() * ORBIT_SPEED + (m.vfxSeed || 0) * 0.37;
    const satR = r * ORBIT_SAT_R;
    const rx = r * ORBIT_RX;
    const ry = r * ORBIT_RY;
    /** @type {{ x: number, y: number, rad: number, depth: number, i: number }[]} */
    const sats = [];
    for (let i = 0; i < 4; i += 1) {
      const ang = t + (i * Math.PI) / 2;
      const depth = Math.sin(ang);
      sats.push({
        x: m.x + Math.cos(ang) * rx,
        y: cy + depth * ry,
        rad: satR * (0.88 + 0.12 * (0.5 + 0.5 * Math.cos(ang))),
        depth,
        i,
      });
    }
    sats.sort((a, b) => a.depth - b.depth);
    return sats;
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
   * 按 SPAWN_RANGE 权重抽近/中/远距带，并给出侧翼外扩距离与同簇伴侣数。
   * @returns {{ band: 'near'|'mid'|'far', extra: number, companions: number }}
   */
  function pickSpawnRangePlan() {
    const wNear = Math.max(0, SPAWN_RANGE.nearWeight);
    const wMid = Math.max(0, SPAWN_RANGE.midWeight);
    const wFar = Math.max(0, SPAWN_RANGE.farWeight);
    const total = wNear + wMid + wFar || 1;
    const r = Math.random() * total;
    /** @type {'near'|'mid'|'far'} */
    let band = 'near';
    let lo = SPAWN_RANGE.nearExtraMin;
    let hi = SPAWN_RANGE.nearExtraMax;
    let companions = 0;
    if (r < wNear) {
      band = 'near';
      lo = SPAWN_RANGE.nearExtraMin;
      hi = SPAWN_RANGE.nearExtraMax;
      companions = 0;
    } else if (r < wNear + wMid) {
      band = 'mid';
      lo = SPAWN_RANGE.midExtraMin;
      hi = SPAWN_RANGE.midExtraMax;
      companions = Math.max(0, SPAWN_RANGE.midCompanions | 0);
    } else {
      band = 'far';
      lo = SPAWN_RANGE.farExtraMin;
      hi = SPAWN_RANGE.farExtraMax;
      companions = Math.max(0, SPAWN_RANGE.farCompanions | 0);
    }
    const span = Math.max(0, hi - lo);
    const extra = lo + Math.random() * span;
    return { band, extra, companions };
  }

  /**
   * 编组侧翼再外扩 extra 的轨面 X；可选沿轨抖动（同簇伴侣）。
   * @param {object} S
   * @param {boolean} fromLeft
   * @param {number} extra
   * @param {number} [jitterX]
   */
  function flankSpawnX(S, fromLeft, extra, jitterX) {
    const spanPad = S.scaleArt(180);
    const flanks = trainFlankXs(S, spanPad);
    const j = Number(jitterX) || 0;
    return fromLeft ? flanks.left - extra + j : flanks.right + extra + j;
  }

  /**
   * 地面怪：轨面 Y，X = 侧翼外扩（近/中/远）并保证在视野外；入口固定同侧车尾/车头。
   * 可选投掷种（更大、不进舱）；默认按 WAVE.throwerChance 抽取。
   * @param {object} S
   * @param {{ fromLeft?: boolean, extra?: number, jitterX?: number, thrower?: boolean } | null | undefined} [opts]
   */
  function spawnGround(S, opts) {
    const cars = S.CARRIAGES;
    if (!cars.length) return null;
    const fromLeft =
      opts?.fromLeft != null ? !!opts.fromLeft : preferTrainSpawnFromLeft(S);
    const extra =
      opts?.extra != null && Number.isFinite(opts.extra)
        ? Math.max(0, opts.extra)
        : pickSpawnRangePlan().extra;
    const wantThrower =
      opts?.thrower === true ||
      (opts?.thrower !== false &&
        countSpecies('bowling_thrower') < (WAVE.maxThrower || 0) &&
        Math.random() < (WAVE.throwerChance || 0));
    const profile = wantThrower ? THROWER : GROUND;
    const entry = pickGroundEntry(S, fromLeft ? 'tail' : 'head');
    if (!entry) return null;
    const rect = lastViewWorld;
    const margin = profile.radius * SPAWN_VIEW_PAD + S.scaleArt(24);
    let x = flankSpawnX(S, fromLeft, extra, opts?.jitterX);
    if (rect) {
      x = fromLeft
        ? Math.min(x, rect.left - margin)
        : Math.max(x, rect.right + margin);
    }
    const y = bowlingCenterY(railY(S), profile.radius);
    return createMob(profile, x, y, {
      phase: 'rail',
      scrollWithTrack: true,
      targetX: entry.jumpX,
      targetY: y,
      jumpX: entry.jumpX,
      floorX: entry.floorX,
      floorY: entry.floorY,
      carId: entry.carId,
      entryEnd: entry.end,
      spawnBandExtra: extra,
      throwCd: wantThrower ? 0.6 + Math.random() * 0.8 : 0,
    });
  }

  /**
   * 空中怪：侧翼外扩的屏外高空出生，再俯冲指定（或随机）连接缝入舱。
   * @param {object} S
   * @param {{ fromLeft?: boolean, extra?: number, jitterX?: number, gap?: object } | null | undefined} [opts]
   */
  function spawnAir(S, opts) {
    const gaps = listCouplerGaps(S);
    if (!gaps.length) return null;
    const gap =
      opts?.gap || gaps[Math.floor(Math.random() * gaps.length)];
    const fromLeft =
      opts?.fromLeft != null ? !!opts.fromLeft : preferTrainSpawnFromLeft(S);
    const extra =
      opts?.extra != null && Number.isFinite(opts.extra)
        ? Math.max(0, opts.extra)
        : pickSpawnRangePlan().extra;
    let x = flankSpawnX(S, fromLeft, extra, opts?.jitterX);
    let hoverY = S.FLOOR_Y - S.scaleArt(280) - Math.random() * S.scaleArt(120);
    const rect = lastViewWorld;
    const margin = AIR.radius * SPAWN_VIEW_PAD + S.scaleArt(24);
    if (rect) {
      hoverY = Math.min(
        hoverY,
        rect.top - margin - Math.random() * S.scaleArt(60)
      );
      if (!isFullyOutsideView(x, hoverY, AIR.radius, rect)) {
        x = fromLeft ? rect.left - margin : rect.right + margin;
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
      enterX:
        gap.x +
        (Math.random() - 0.5) * Math.min(40, (gap.right - gap.left) * 0.4),
      carLeftId: gap.carLeftId,
      carRightId: gap.carRightId,
      spawnBandExtra: extra,
    });
  }

  /**
   * 按距带刷一簇地面怪（主刷 + 中/远伴侣），受 maxGround 限制；供雷达外环成簇。
   * @param {object} S
   * @param {{ band?: string, extra?: number, companions?: number } | null | undefined} [forcedPlan]
   * @returns {number} 实际推入数量
   */
  function spawnGroundCluster(S, forcedPlan) {
    const plan = forcedPlan || pickSpawnRangePlan();
    const fromLeft = preferTrainSpawnFromLeft(S);
    const room = WAVE.maxGround - countKind('ground');
    if (room <= 0) return 0;
    const companions = Math.max(0, plan.companions | 0);
    const want = Math.min(room, 1 + companions);
    let n = 0;
    for (let i = 0; i < want; i += 1) {
      const jitter =
        i === 0
          ? 0
          : (Math.random() * 2 - 1) * SPAWN_RANGE.clusterJitter;
      const g = spawnGround(S, {
        fromLeft,
        extra: plan.extra,
        jitterX: jitter,
        /* 同簇伴侣不抽投掷种，避免侧翼挤两只巨球 */
        thrower: i === 0 ? undefined : false,
      });
      if (!g) break;
      mobs.push(g);
      n += 1;
    }
    return n;
  }

  /**
   * 按距带刷一簇空中怪（同缝入舱），受 maxAir 限制。
   * @param {object} S
   * @param {{ band?: string, extra?: number, companions?: number } | null | undefined} [forcedPlan]
   * @returns {number} 实际推入数量
   */
  function spawnAirCluster(S, forcedPlan) {
    const gaps = listCouplerGaps(S);
    if (!gaps.length) return 0;
    const plan = forcedPlan || pickSpawnRangePlan();
    const fromLeft = preferTrainSpawnFromLeft(S);
    const gap = gaps[Math.floor(Math.random() * gaps.length)];
    const room = WAVE.maxAir - countKind('air');
    if (room <= 0) return 0;
    const companions = Math.max(0, plan.companions | 0);
    const want = Math.min(room, 1 + companions);
    let n = 0;
    for (let i = 0; i < want; i += 1) {
      const jitter =
        i === 0
          ? 0
          : (Math.random() * 2 - 1) * SPAWN_RANGE.clusterJitter;
      const a = spawnAir(S, {
        fromLeft,
        extra: plan.extra,
        jitterX: jitter,
        gap,
      });
      if (!a) break;
      mobs.push(a);
      n += 1;
    }
    return n;
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

  /**
   * 混合 worldSeed 与站序（优先复用 LpDungeon.hash2，保证与房间其它派生一致）。
   * @param {number} worldSeed
   * @param {number} stationIndex
   * @returns {number}
   */
  function hashSeedStation(worldSeed, stationIndex) {
    const D = window.LpDungeon;
    if (D?.hash2) return D.hash2(Number(worldSeed), stationIndex | 0) >>> 0;
    let h = (Number(worldSeed) >>> 0) ^ Math.imul((stationIndex | 0) + 1, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return h >>> 0;
  }

  /**
   * 由世界种子与离站站序确定性抽选本程波次包 id（忽略 weight≤0 的占位，如 boss）。
   * @param {number} worldSeed
   * @param {number} stationIndex
   * @returns {string}
   */
  function pickWavePackId(worldSeed, stationIndex) {
    const entries = Object.values(WAVE_PACKS).filter((p) => (p.weight | 0) > 0);
    if (!entries.length) return 'mixed';
    let total = 0;
    for (const e of entries) total += e.weight | 0;
    const h = (hashSeedStation(worldSeed, stationIndex) ^ WAVE_PACK_STREAM) >>> 0;
    let r = h % total;
    for (const e of entries) {
      r -= e.weight | 0;
      if (r < 0) return e.id;
    }
    return entries[entries.length - 1].id;
  }

  /**
   * 锁定本程波次包（离站站序）；副作用：写入 activeWavePack / activeWavePackLeg。
   * @param {number} stationIndex
   * @returns {typeof WAVE_PACKS[keyof typeof WAVE_PACKS]}
   */
  function beginTravelLeg(stationIndex) {
    const seed = window.LpPlatform?.getWorldSeed?.() ?? 0;
    const id = pickWavePackId(seed, stationIndex | 0);
    activeWavePack = WAVE_PACKS[id] || WAVE_PACKS.mixed;
    activeWavePackLeg = stationIndex | 0;
    return activeWavePack;
  }

  /**
   * 行驶中若站序变化（或尚未锁定）则刷新本程包；停靠时仅 force 才预锁定（便于开局/调试）。
   * @param {boolean} [force]
   */
  function syncTravelWavePack(force) {
    const station = window.LpPlatform?.getStationIndex?.() ?? 0;
    if (window.LpPlatform?.isAtPlatform?.()) {
      if (force) beginTravelLeg(station);
      return;
    }
    if (!force && activeWavePackLeg === (station | 0)) return;
    beginTravelLeg(station);
  }

  /**
   * 预留：boss 程刷怪钩子（当前 pack.weight=0，不会进入）。
   * 日后在此生成 boss，并让 tickWaveDirector 在 pack.id==='boss' 时调用。
   * @param {object} _S
   * @param {number} _dt
   */
  function tickBossPack(_S, _dt) {
    /* reserved */
  }

  /** 进入指定波次阶段并重置该阶段计时。 */
  function enterWavePhase(phase) {
    wavePhase = phase === 'calm' ? 'calm' : 'wave';
    phaseTimer = wavePhase === 'calm' ? WAVE.calmDuration : WAVE.duration;
    spawnTimer = wavePhase === 'wave' ? WAVE.waveLeadIn : 0;
  }

  /** 清除列车波次怪（保留地牢怪）。 */
  function clearTrainWaveMobs() {
    thrownBalls = [];
    const kept = mobs.filter((m) => m.dungeon);
    if (!mobs.length) return;
    if (!kept.length) {
      mobs = [];
      window.LpAutoSensors?.setHostiles?.([]);
      return;
    }
    if (kept.length === mobs.length) return;
    mobs = kept;
    window.LpAutoSensors?.setHostiles?.(listHostiles());
  }

  /** 清除地牢怪与待激活刷点。 */
  function clearDungeonMobs() {
    pendingDungeonSpawns = [];
    const before = mobs.length;
    mobs = mobs.filter((m) => !m.dungeon);
    if (mobs.length !== before) {
      window.LpAutoSensors?.setHostiles?.(listHostiles());
    }
  }

  /**
   * 房间可走内区 X 界（避开侧墙 + 怪半径）。
   * @param {object | null | undefined} room
   * @param {number} radius
   * @returns {{ left: number, right: number } | null}
   */
  function dungeonRoomWalkX(room, radius) {
    const left = Number(room?.left);
    const right = Number(room?.right);
    if (!Number.isFinite(left) || !Number.isFinite(right) || right - left < 8) {
      return null;
    }
    const wall = window.LpDungeon?.WALL_THICK ?? 20;
    const pad = wall + Math.max(12, radius * 0.85);
    const innerL = left + pad;
    const innerR = right - pad;
    if (innerR <= innerL) return null;
    return { left: innerL, right: innerR };
  }

  /**
   * 地牢怪相对房间可走内区的左右界（避开侧墙厚度）。
   * @param {ReturnType<typeof createMob>} m
   * @returns {{ left: number, right: number } | null}
   */
  function dungeonRoomInnerX(m) {
    return dungeonRoomWalkX(
      { left: m.roomLeft, right: m.roomRight },
      m.radius
    );
  }

  /**
   * 点到轴对齐房间的近似距离（在内为 0）。
   * @param {object} room
   * @param {number} px
   * @param {number} py
   */
  function distToRoomAabb(room, px, py) {
    const cx = Math.min(room.right, Math.max(room.left, px));
    const cy = Math.min(room.floorY, Math.max(room.ceilingY, py));
    const dx = px - cx;
    const dy = py - cy;
    return Math.hypot(dx, dy);
  }

  /**
   * 房间是否已接近到该激活待刷点（玩家靠近或即将入镜）。
   * @param {object} room
   * @param {{ x: number, y: number } | null} player
   * @param {{ left: number, right: number, top: number, bottom: number } | null} rect
   */
  function dungeonRoomReadyToActivate(room, player, rect) {
    if (!room) return true;
    if (player && Number.isFinite(player.x)) {
      const py = Number.isFinite(player.y) ? player.y : room.floorY;
      if (distToRoomAabb(room, player.x, py) <= DUNGEON_SPAWN.activatePlayerDist) {
        return true;
      }
    }
    if (!rect) return false;
    const pad = DUNGEON_SPAWN.activateViewPad;
    return !(
      room.right < rect.left - pad ||
      room.left > rect.right + pad ||
      room.floorY < rect.top - pad ||
      room.ceilingY > rect.bottom + pad
    );
  }

  /**
   * 在房内为地牢怪挑落点：优先屏外 / 远玩家 / 与同伴错开，绝不贴脚。
   * @param {object | null} room
   * @param {number} preferX 布局建议 X
   * @param {number} y 圆心 Y（用于视野判定）
   * @param {number} radius
   * @param {{ x: number, y: number } | null} player
   * @param {{ left: number, right: number, top: number, bottom: number } | null} rect
   * @returns {number}
   */
  function pickDungeonSpawnX(room, preferX, y, radius, player, rect) {
    const walk = dungeonRoomWalkX(room, radius);
    if (!walk) return preferX;
    const peers = [];
    for (const m of mobs) {
      if (!m.dungeon || !isMobCombatActive(m)) continue;
      if (room?.id != null && m.roomId != null && String(m.roomId) !== String(room.id)) {
        continue;
      }
      peers.push(m.x);
    }
    /** @type {number[]} */
    const candidates = [preferX, walk.left + 4, walk.right - 4];
    if (player && Number.isFinite(player.x)) {
      candidates.push(
        player.x < (walk.left + walk.right) * 0.5 ? walk.right - 8 : walk.left + 8
      );
    }
    if (rect) {
      candidates.push(rect.left - radius * 2, rect.right + radius * 2);
    }
    const span = walk.right - walk.left;
    for (let i = 0; i < DUNGEON_SPAWN.candidateTries; i += 1) {
      candidates.push(walk.left + Math.random() * span);
    }

    let bestX = Math.min(walk.right, Math.max(walk.left, preferX));
    let bestScore = -Infinity;
    for (const raw of candidates) {
      const x = Math.min(walk.right, Math.max(walk.left, raw));
      let score = 0;
      if (isFullyOutsideView(x, y, radius, rect)) score += 120;
      else if (!intersectsView(x, y, radius, rect)) score += 40;
      else score -= 80;
      if (player && Number.isFinite(player.x)) {
        const d = Math.abs(x - player.x);
        if (d < DUNGEON_SPAWN.playerClearance) score -= 200;
        else score += Math.min(90, d * 0.12);
      }
      let peerOk = true;
      for (const px of peers) {
        if (Math.abs(x - px) < DUNGEON_SPAWN.minPeerGap) {
          peerOk = false;
          break;
        }
      }
      if (!peerOk) score -= 150;
      if (room?.id != null && window.LpDungeonFow?.isRoomExplored) {
        if (!window.LpDungeonFow.isRoomExplored(room.id)) score += 12;
      }
      if (score > bestScore) {
        bestScore = score;
        bestX = x;
      }
    }
    return bestX;
  }

  /**
   * 统计场上地牢存活怪数量。
   * @returns {number}
   */
  function countDungeonAlive() {
    let n = 0;
    for (const m of mobs) {
      if (m.dungeon && isMobCombatActive(m)) n += 1;
    }
    return n;
  }

  /**
   * 将一条地牢刷点物化为实体（落点经 FOV/玩家安全挑选）。
   * @param {{
   *   spot: object,
   *   room: object | null,
   *   floorY: number,
   *   ceilingY: number,
   *   species: string,
   * }} entry
   * @param {{ x: number, y: number } | null} player
   * @returns {boolean}
   */
  function materializeDungeonSpawn(entry, player) {
    if (countDungeonAlive() >= DUNGEON_SPAWN.maxAlive) return false;
    const { room, floorY, ceilingY, species, spot } = entry;
    const isBalloon = species === 'balloon' || species === 'air';
    const profile = isBalloon ? AIR : GROUND;
    const y = isBalloon
      ? dungeonBalloonHoverY(floorY, ceilingY, profile.radius)
      : bowlingCenterY(floorY, profile.radius);
    const preferX = Number(spot.x) || (room ? (room.left + room.right) * 0.5 : 0);
    const x = pickDungeonSpawnX(
      room,
      preferX,
      y,
      profile.radius,
      player,
      lastViewWorld
    );
    if (
      player &&
      Number.isFinite(player.x) &&
      Math.abs(x - player.x) < DUNGEON_SPAWN.playerClearance * 0.55 &&
      Math.abs((player.y || floorY) - floorY) < 120
    ) {
      return false;
    }
    if (lastViewWorld && intersectsView(x, y, profile.radius, lastViewWorld)) {
      const viewW = lastViewWorld.right - lastViewWorld.left;
      const midL = lastViewWorld.left + viewW * 0.22;
      const midR = lastViewWorld.right - viewW * 0.22;
      if (x > midL && x < midR) return false;
    }
    const m = createMob(profile, x, y, {
      phase: 'dungeon',
      dungeon: true,
      floorY,
      ceilingY,
      roomId: spot.roomId || room?.id || null,
      roomLeft: room?.left ?? null,
      roomRight: room?.right ?? null,
      targetX: x,
      targetY: y,
      vfxSeed: (spot.x || 0) * 0.13 + (spot.floorY || 0) * 0.07,
    });
    mobs.push(m);
    return true;
  }

  /**
   * 推进待激活地牢刷点：接近房间或即将入镜时再物化，避免中央 pop-in。
   * @param {{ x: number, y: number } | null | undefined} player
   */
  function tickPendingDungeonSpawns(player) {
    if (!pendingDungeonSpawns.length) return;
    const pl =
      player && Number.isFinite(player.x)
        ? { x: player.x, y: Number(player.y) || 0 }
        : null;
    const rect = lastViewWorld;
    let changed = false;
    const rest = [];
    for (const entry of pendingDungeonSpawns) {
      if (countDungeonAlive() >= DUNGEON_SPAWN.maxAlive) {
        rest.push(entry);
        continue;
      }
      const room = entry.room;
      if (room && !dungeonRoomReadyToActivate(room, pl, rect)) {
        rest.push(entry);
        continue;
      }
      if (materializeDungeonSpawn(entry, pl)) {
        changed = true;
      } else {
        rest.push(entry);
      }
    }
    pendingDungeonSpawns = rest;
    if (changed) {
      window.LpAutoSensors?.setHostiles?.(listHostiles());
    }
  }

  /**
   * 地牢怪位移后与实心墙解算（与玩家同一套 LpDungeon.resolveBody）。
   * @param {ReturnType<typeof createMob>} m
   */
  function resolveDungeonMobWalls(m) {
    const dungeon = window.LpPlatform?.getDungeon?.();
    if (!dungeon?.walls?.length || !window.LpDungeon?.resolveBody) return;
    const floorY = Number(m.floorY);
    if (!Number.isFinite(floorY)) return;
    const halfW = Math.max(8, m.radius * 0.72);
    const height = Math.max(24, m.radius * 1.55);
    let physicsY = 0;
    if (m.kind === 'air') {
      const feet = m.y + m.radius * 0.85;
      physicsY = feet - floorY;
    }
    const out = window.LpDungeon.resolveBody(dungeon, {
      x: m.x,
      physicsY,
      vy: 0,
      floorY,
      halfW,
      height,
    });
    m.x = out.x;
    if (m.kind === 'air') {
      const feet = floorY + out.physicsY;
      m.y = feet - m.radius * 0.85;
    }
  }

  /**
   * 气球悬停高度：房间净空约 38% 处（门洞之上，仍在房内）。
   * @param {number} floorY
   * @param {number} ceilingY
   * @param {number} radius
   */
  function dungeonBalloonHoverY(floorY, ceilingY, radius) {
    const top = Number.isFinite(ceilingY) ? ceilingY : floorY - (window.LpDungeon?.ROOM_H || 634);
    const span = Math.max(80, floorY - top);
    return top + span * 0.38 + radius * 0.2;
  }

  /**
   * 按地牢布局入队敌房刷点（不立刻物化；接近时再按 FOV 落点）。
   * 物种混合与布局坐标保留；压力仍按物化后的 mob id 一次计。
   * @param {object} layout LpDungeon.generate 结果
   */
  function spawnDungeonFromLayout(layout) {
    clearDungeonMobs();
    clearTrainWaveMobs();
    if (!layout?.spawns?.length) return;
    const roomById = new Map();
    for (const room of layout.rooms || []) {
      if (room?.id != null) roomById.set(String(room.id), room);
    }
    for (const spot of layout.spawns) {
      const room = roomById.get(String(spot.roomId || '')) || null;
      const floorY =
        Number(spot.floorY) ||
        Number(room?.floorY) ||
        layout.baseFloorY ||
        720;
      const ceilingY =
        Number(spot.ceilingY) ||
        Number(room?.ceilingY) ||
        floorY - (window.LpDungeon?.ROOM_H || 634);
      pendingDungeonSpawns.push({
        spot,
        room,
        floorY,
        ceilingY,
        species: String(spot.species || 'bowling'),
      });
    }
  }

  /**
   * 地牢怪：保龄球贴地穿门追；气球锁房漂浮追；均经墙体解算。
   * @param {ReturnType<typeof createMob>} m
   * @param {number} dt
   * @param {object|null} player
   */
  function tickDungeon(m, dt, player) {
    const floorY = m.floorY != null ? m.floorY : m.y + m.radius * 0.42;
    if (!player) {
      if (m.kind === 'ground' || m.species === 'bowling') {
        m.y = bowlingCenterY(floorY, m.radius);
      }
      return;
    }
    const tx = player.x;
    if (m.kind === 'air' || m.species === 'balloon') {
      const hover = dungeonBalloonHoverY(
        floorY,
        m.ceilingY,
        m.radius
      );
      const bobY = hover + Math.sin(m.bob) * 6;
      m.bob += dt * 1.7;
      m.targetX = tx;
      m.targetY = hover;
      glideToward(m, tx, bobY, m.speed * 0.72, dt, tx, hover);
      const inner = dungeonRoomInnerX(m);
      if (inner && inner.right > inner.left) {
        m.x = Math.min(inner.right, Math.max(inner.left, m.x));
      }
      resolveDungeonMobWalls(m);
      return;
    }
    m.y = bowlingCenterY(floorY, m.radius);
    m.targetX = tx;
    m.targetY = m.y;
    moveToward(m, tx, m.y, m.speed * 0.85, dt);
    resolveDungeonMobWalls(m);
    m.y = bowlingCenterY(floorY, m.radius);
  }

  /**
   * 波次导演：推进 wave/calm，仅在 wave 内按间隔尝试刷怪（受 caps + 本程 WAVE_PACK 限制）。
   * 每次尝试按 SPAWN_RANGE 权重在近/中/远刷簇，偏雷达中外环。
   * 月台前后缓冲区内不刷列车接近怪（场上已有怪由 AI 门控改缓退）。
   * @param {object} S
   * @param {number} dt
   */
  function tickWaveDirector(S, dt) {
    /* 停靠月台：清列车波次；大型全程暂停；小型仅在列车侧暂停（地牢怪另管） */
    if (window.LpPlatform?.isAtPlatform?.()) {
      const onSmallDungeon =
        window.LpPlatform?.getScene?.() === 'platform' &&
        window.LpPlatform?.getPlatformKind?.() === 'small';
      if (!onSmallDungeon) {
        clearTrainWaveMobs();
      } else {
        /* 去掉非地牢怪，保留 dungeon 标记 */
        const kept = mobs.filter((m) => m.dungeon);
        if (kept.length !== mobs.length) {
          mobs = kept;
          window.LpAutoSensors?.setHostiles?.(listHostiles());
        }
      }
      return;
    }

    syncTravelWavePack(false);

    phaseTimer -= dt;
    if (phaseTimer <= 0) {
      enterWavePhase(wavePhase === 'wave' ? 'calm' : 'wave');
    }
    if (wavePhase !== 'wave') return;

    /* 月台前后缓冲：推进波次时钟但不刷接近火车的怪 */
    if (inPlatformTrainSafeZone()) return;

    /* 预留 boss 程：不走普通地面/空中簇 */
    if (activeWavePack.id === 'boss') {
      tickBossPack(S, dt);
      return;
    }

    spawnTimer -= dt;
    if (spawnTimer > 0) return;
    spawnTimer = nextSpawnInterval();

    const pack = activeWavePack;
    if (pack.allowGround && countKind('ground') < WAVE.maxGround) {
      spawnGroundCluster(S);
    }
    if (pack.allowAir && countKind('air') < WAVE.maxAir) {
      spawnAirCluster(S);
    }
  }

  /**
   * 列车是否处于月台前后禁近区（LpPlatform.MOB_TRAIN_SAFE_DIST）。
   * @returns {boolean}
   */
  function inPlatformTrainSafeZone() {
    return !!window.LpPlatform?.isNearPlatformMobSafeZone?.();
  }

  /**
   * 编组中心世界 X（侧翼中点），供禁近区缓退方向。
   * @param {object} S
   * @returns {number}
   */
  function trainMidX(S) {
    const flanks = trainFlankXs(S, 0);
    return (flanks.left + flanks.right) * 0.5;
  }

  /**
   * 轨面禁近：不朝车头/车尾跳点移动，沿轨缓慢远离编组。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {number} dt
   */
  function tickGroundRailSafeHold(m, S, dt) {
    applyMobTrackScroll(m);
    const ry = bowlingCenterY(railY(S), m.radius);
    m.y = ry;
    m.bob += dt * 3.4;
    const away = m.x < trainMidX(S) ? -1 : 1;
    const retreatX = m.x + away * S.scaleArt(120);
    moveToward(m, retreatX, ry, railRunSpeed(m, retreatX, 0.32), dt);
    m.y = ry;
  }

  /**
   * 空中禁近：取消俯冲进缝，原地高度微漂并缓慢外飘。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {number} dt
   */
  function tickAirDiveSafeHold(m, S, dt) {
    if (m.holdY == null) m.holdY = m.targetY != null ? m.targetY : m.y;
    const away = m.x < trainMidX(S) ? -1 : 1;
    const tx = m.x + away * S.scaleArt(90);
    const hover = m.holdY + Math.sin(m.bob) * 9;
    glideToward(m, tx, hover, m.speed * 0.28, dt);
  }

  /** 向目标点匀速靠近（瞬时转向）；到达返回 true。保龄球等仍用此路径。 */
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
   * 气球惯性靠近：速度平滑追上期望方向，带近距减速；够近且够慢时返回 true。
   * @param {ReturnType<typeof createMob>} m
   * @param {number} tx 转向目标 X
   * @param {number} ty 转向目标 Y（可含 bob）
   * @param {number} speed 巡航期望速率（px/s）
   * @param {number} dt
   * @param {number} [arriveX] 到达判定 X（默认 tx；舱内应传无 bob 的稳定点）
   * @param {number} [arriveY] 到达判定 Y（默认 ty）
   * @returns {boolean}
   */
  function glideToward(m, tx, ty, speed, dt, arriveX, arriveY) {
    if (m.gx == null) m.gx = 0;
    if (m.gy == null) m.gy = 0;
    const ax = arriveX == null ? tx : arriveX;
    const ay = arriveY == null ? ty : arriveY;
    const adist = Math.hypot(ax - m.x, ay - m.y);
    const spd = Math.hypot(m.gx, m.gy);

    if (adist <= AIR_MOVE.arriveDist && spd <= AIR_MOVE.arriveSpeed) {
      m.gx = 0;
      m.gy = 0;
      m.x = ax;
      m.y = ay;
      return true;
    }

    const dx = tx - m.x;
    const dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    let wantSpd = speed;
    if (adist < AIR_MOVE.slowRadius) {
      wantSpd = speed * Math.max(0.12, adist / AIR_MOVE.slowRadius);
    }
    let wantVx = 0;
    let wantVy = 0;
    if (dist > 0.5) {
      wantVx = (dx / dist) * wantSpd;
      wantVy = (dy / dist) * wantSpd;
    }

    const blend = 1 - Math.exp(-AIR_MOVE.velSmooth * dt);
    m.gx += (wantVx - m.gx) * blend;
    m.gy += (wantVy - m.gy) * blend;
    const drag = Math.exp(-AIR_MOVE.damp * dt);
    m.gx *= drag;
    m.gy *= drag;

    m.x += m.gx * dt;
    m.y += m.gy * dt;
    return false;
  }

  /**
   * 进入跳入阶段：记录起落点，用抛物线弧进舱（非侧面爬升）。
   * 同时解除轨面锚定（改钉车厢空间）。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   */
  function beginGroundJump(m, S) {
    if (m.canEnterCabin === false) return;
    const landY = bowlingCenterY(m.floorY, m.radius);
    m.phase = 'jump';
    m.scrollWithTrack = false;
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
   * 投掷种贴车外站位 X：停在编组侧翼外，不越过车头/车尾入口。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @returns {number}
   */
  function throwerHoldX(m, S) {
    const standoff = Number(m.throwStandoff) || THROWER.throwStandoff;
    const flanks = trainFlankXs(S, m.radius + standoff);
    const mid = trainMidX(S);
    return m.x < mid ? flanks.left : flanks.right;
  }

  /**
   * 选取舱内投掷落点：优先玩家（若在走道舱内），否则随机一节走道点。
   * @param {object} S
   * @param {object|null} player
   * @returns {{ x: number, y: number } | null}
   */
  function pickCabinThrowTarget(S, player) {
    const cars = S.CARRIAGES;
    if (!cars?.length) return null;
    if (player && S.carriageAt?.(player.x)) {
      return {
        x: player.x,
        y: bowlingCenterY(S.FLOOR_Y, 10),
      };
    }
    const car = cars[Math.floor(Math.random() * cars.length)];
    return {
      x: car.worldX + S.WALK_LEFT + Math.random() * (S.WALK_RIGHT - S.WALK_LEFT),
      y: bowlingCenterY(S.FLOOR_Y, 10),
    };
  }

  /**
   * 从投掷种生成一枚飞向舱内的保龄弹（弧线；不随轨卷动）。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {object|null} player
   */
  function throwBowlingIntoCabin(m, S, player) {
    const target = pickCabinThrowTarget(S, player);
    if (!target) return;
    const x0 = m.x;
    const y0 = m.y - m.radius * 0.35;
    const dx = target.x - x0;
    const dy = target.y - y0;
    const dist = Math.hypot(dx, dy) || 1;
    const flight = Math.max(0.45, Math.min(1.35, dist / Math.max(280, m.throwSpeed || THROWER.throwSpeed)));
    const vx = dx / flight;
    const grav = 980;
    const vy = dy / flight - 0.5 * grav * flight;
    thrownBalls.push({
      x: x0,
      y: y0,
      vx,
      vy,
      r: Number(m.throwRadius) || THROWER.throwRadius,
      damage: m.damage,
      knock: m.knock * 0.85,
      life: flight + 0.85,
      fromId: m.id,
      grav,
    });
  }

  /**
   * 巨型投掷保龄：轨面锚定追到侧翼外站位，向舱内投球，永不跳入。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {number} dt
   * @param {object|null} player
   */
  function tickGroundThrower(m, S, dt, player) {
    const ry = bowlingCenterY(railY(S), m.radius);
    m.y = ry;
    m.bob += dt * 4.4;
    m.phase = 'rail';
    m.scrollWithTrack = true;
    m.canEnterCabin = false;

    if (inPlatformTrainSafeZone()) {
      tickGroundRailSafeHold(m, S, dt);
      return;
    }

    applyMobTrackScroll(m);
    const holdX = throwerHoldX(m, S);
    m.targetX = holdX;
    m.jumpX = holdX;
    moveToward(m, holdX, ry, railRunSpeed(m, holdX), dt);
    m.y = ry;

    /* 挡在舱界外：禁止越过侧翼入口进入走道 X */
    const flanks = trainFlankXs(S, 0);
    if (m.x > flanks.left && m.x < flanks.right) {
      m.x = m.x < trainMidX(S) ? flanks.left : flanks.right;
    }

    m.throwCd = Math.max(0, (m.throwCd || 0) - dt);
    const near =
      Math.abs(m.x - holdX) < S.scaleArt(220) ||
      Math.abs(m.x - flanks.left) < S.scaleArt(280) ||
      Math.abs(m.x - flanks.right) < S.scaleArt(280);
    if (m.throwCd <= 0 && near) {
      throwBowlingIntoCabin(m, S, player);
      m.throwCd = Number(m.throwInterval) || THROWER.throwInterval;
    }
  }

  /**
   * 推进投掷弹：抛物线飞行，命中玩家（舱内）则回调 onHit。
   * @param {number} dt
   * @param {object|null} player
   * @param {Function|undefined} onHit
   */
  function tickThrownBalls(dt, player, onHit) {
    for (let i = thrownBalls.length - 1; i >= 0; i -= 1) {
      const b = thrownBalls[i];
      b.life -= dt;
      b.vy += (b.grav || 980) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      let hit = false;
      if (player && !player.invuln) {
        const px = player.x;
        const py = player.y - player.height * 0.45;
        const dx = b.x - px;
        const dy = b.y - py;
        const rx = b.r + player.halfW;
        const ry = b.r + player.height * 0.45;
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) {
          const knockDir = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(-dx) || 1;
          onHit?.({
            mobId: b.fromId,
            kind: 'ground',
            species: 'bowling_thrower',
            damage: b.damage,
            knockVx: knockDir * b.knock,
            knockVy: -Math.abs(b.knock) * 0.55,
            fromX: b.x,
            fromY: b.y,
          });
          hit = true;
        }
      }
      const floorY = spec()?.FLOOR_Y;
      if (hit || b.life <= 0 || (floorY != null && b.y - b.r > floorY + 40)) {
        thrownBalls.splice(i, 1);
      }
    }
  }

  /**
   * 绘制投掷中的保龄小球。
   * @param {CanvasRenderingContext2D} ctx
   */
  function drawThrownBalls(ctx) {
    const Bub = window.LpMobBubbleFill;
    for (const b of thrownBalls) {
      ctx.save();
      fillStrokeCircle(
        ctx,
        Bub,
        b.x,
        b.y,
        b.r,
        { color: THROWER.color, stroke: THROWER.stroke, radius: b.r },
        `throw:${b.fromId}:${b.x | 0}`,
        { palette: BOWLING_PALETTE, count: 4 },
        0.14
      );
      ctx.restore();
    }
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
    m.targetY = bowlingCenterY(S.FLOOR_Y, m.radius);
    return true;
  }

  /**
   * 地面：轨面横移到车头/车尾 → 跳入走道 → 舱内游荡。
   * 轨面阶段随轨卷动；投掷种只追侧翼并投球、不进舱。
   * 月台前后缓冲区内轨面阶段不向火车接近（缓退）。
   * @param {ReturnType<typeof createMob>} m
   * @param {object} S
   * @param {number} dt
   * @param {object|null} [player]
   */
  function tickGround(m, S, dt, player) {
    if (isRailThrower(m)) {
      tickGroundThrower(m, S, dt, player || null);
      return;
    }
    const ry = bowlingCenterY(railY(S), m.radius);
    if (m.phase === 'rail') {
      if (inPlatformTrainSafeZone()) {
        tickGroundRailSafeHold(m, S, dt);
        return;
      }
      applyMobTrackScroll(m);
      m.y = ry;
      // 轨面横移时推进 bob，供爬行周期慢速循环。
      m.bob += dt * 5.2;
      if (moveToward(m, m.jumpX, ry, railRunSpeed(m, m.jumpX), dt)) {
        beginGroundJump(m, S);
      }
      return;
    }
    if (m.phase === 'jump') {
      tickGroundJump(m, S, dt);
      return;
    }
    /* inside：在走道内左右爬（已离轨，不再 scrollWithTrack） */
    m.scrollWithTrack = false;
    m.bob += dt * 6;
    const bobY = bowlingCenterY(S.FLOOR_Y, m.radius) + Math.sin(m.bob) * 1.5;
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
   * 位移经 glideToward（惯性），正弦 bob 幅度略大以增强漂浮感。
   * 月台前后缓冲区内俯冲阶段不朝连接缝接近（外飘微漂）。
   * @param {ReturnType<typeof createMob>} m
   */
  function tickAir(m, S, dt) {
    m.bob += dt * 3.6;
    if (m.phase === 'dive') {
      if (inPlatformTrainSafeZone()) {
        tickAirDiveSafeHold(m, S, dt);
        return;
      }
      const hover = m.targetY + Math.sin(m.bob) * 9;
      if (glideToward(m, m.targetX, hover, m.speed, dt)) {
        m.phase = 'enter';
        m.targetX = m.enterX;
        const band = cabinAirBand(S, m.radius);
        m.targetY = band.highY + (band.lowY - band.highY) * 0.45;
      }
      return;
    }
    if (m.phase === 'enter') {
      const band = cabinAirBand(S, m.radius);
      const enterY = band.highY + (band.lowY - band.highY) * 0.45 + Math.sin(m.bob) * 8;
      if (glideToward(m, m.enterX, enterY, m.climbSpeed, dt)) {
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
    /* inside：舱内水平 + 高度游荡，正弦微漂；到达判定用稳定 target，避免 bob 反复触发换点 */
    const floatY = m.targetY + Math.sin(m.bob) * 11;
    if (glideToward(m, m.targetX, floatY, m.speed * 0.58, dt, m.targetX, m.targetY)) {
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
    const dungeonMode =
      window.LpPlatform?.getScene?.() === 'platform' &&
      window.LpPlatform?.getPlatformKind?.() === 'small';
    if (!dungeonMode && !S?.CARRIAGES?.length) return;
    lastDt = dt > 0 ? dt : lastDt;
    rememberView(ctx);
    purgeDeadMobs();
    if (!dungeonMode) tickWaveDirector(S, dt);
    else tickWaveDirector(S, dt); /* 仍走停靠分支清理列车怪 */

    const player = ctx.player || null;
    const onHit = ctx.onHit;
    if (dungeonMode) tickPendingDungeonSpawns(player);

    for (const m of mobs) {
      if (!isMobCombatActive(m)) continue;
      if (m.hitCd > 0) m.hitCd -= dt;
      if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt);
      const px = m.x;
      const py = m.y;
      if (m.dungeon || m.phase === 'dungeon') tickDungeon(m, dt, player);
      else if (m.kind === 'ground') tickGround(m, S, dt, player);
      else tickAir(m, S, dt);
      if (dt > 1e-6) {
        m.vx = (m.x - px) / dt;
        m.vy = (m.y - py) / dt;
      }
      collidePlayer(m, player, onHit);
    }

    tickThrownBalls(dt, player, onHit);

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

  /**
   * 回退：用 mob.stroke 描当前已构建的 path（无 Bub 流动描边时）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof createMob>} m
   * @param {number} lineScale
   */
  function strokeMobOutlineSolid(ctx, m, lineScale) {
    ctx.lineWidth = Math.max(1.5, m.radius * lineScale);
    ctx.strokeStyle = m.stroke;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /**
   * 封闭圆：半透明泡泡填充 + 流动彩虹描边（无 Bub 时纯色+实线）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object | null | undefined} Bub
   * @param {number} x
   * @param {number} y
   * @param {number} rad
   * @param {ReturnType<typeof createMob>} m
   * @param {string|number} seed
   * @param {object} fillOpts
   * @param {number} lineScale
   */
  function fillStrokeCircle(ctx, Bub, x, y, rad, m, seed, fillOpts, lineScale) {
    if (Bub?.fillCircle) {
      Bub.fillCircle(ctx, x, y, rad, seed, fillOpts);
    } else {
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
    }
    const lw = Math.max(1.5, m.radius * lineScale);
    if (Bub?.strokeFlowingCircle) {
      Bub.strokeFlowingCircle(ctx, x, y, rad, seed, {
        lineWidth: lw,
        palette: fillOpts.palette,
      });
    } else if (Bub?.strokeFlowingOutline) {
      Bub.strokeFlowingOutline(ctx, { cx: x, cy: y, rx: rad, ry: rad }, seed, {
        lineWidth: lw,
        palette: fillOpts.palette,
      });
    } else {
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      strokeMobOutlineSolid(ctx, m, lineScale);
    }
  }

  /**
   * 椭圆 / 任意 path：半透明泡泡填充后画流动描边；无 Bub 时实色+实线。
   * @param {CanvasRenderingContext2D} ctx
   * @param {object | null | undefined} Bub
   * @param {ReturnType<typeof createMob>} m
   * @param {string|number} seed
   * @param {Function|{ cx: number, cy: number, rx: number, ry: number }} pathOrBounds
   * @param {object} fillOpts
   * @param {number} lineScale
   * @param {'path'|'ellipse'} mode
   */
  function fillStrokeClosed(ctx, Bub, m, seed, pathOrBounds, fillOpts, lineScale, mode) {
    const lw = Math.max(1.5, m.radius * lineScale);
    if (mode === 'ellipse' && Bub?.fillEllipse) {
      const b = pathOrBounds;
      Bub.fillEllipse(ctx, b.cx, b.cy, b.rx, b.ry, seed, fillOpts);
    } else if (mode === 'path' && Bub?.fillPath) {
      Bub.fillPath(ctx, pathOrBounds, seed, fillOpts);
    } else if (Bub?.drawBubbleFill) {
      Bub.drawBubbleFill(ctx, pathOrBounds, 0, seed, fillOpts);
    } else if (mode === 'ellipse') {
      const b = pathOrBounds;
      ctx.beginPath();
      ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
    } else {
      ctx.beginPath();
      pathOrBounds(ctx);
      ctx.fillStyle = m.color;
      ctx.fill();
    }
    if (Bub?.strokeFlowingOutline) {
      Bub.strokeFlowingOutline(ctx, pathOrBounds, seed, {
        lineWidth: lw,
        palette: fillOpts.palette,
      });
    } else if (mode === 'ellipse') {
      const b = pathOrBounds;
      ctx.beginPath();
      ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
      strokeMobOutlineSolid(ctx, m, lineScale);
    } else {
      ctx.beginPath();
      pathOrBounds(ctx);
      strokeMobOutlineSolid(ctx, m, lineScale);
    }
  }

  /**
   * 侧视保龄球：驼峰主体 + 前头圆 + 3 爬行脚球 + 后钩尾；半透明泡泡 + 流动描边。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof createMob>} m
   * @param {object | null | undefined} Bub
   */
  function drawBowlingBall(ctx, m, Bub) {
    const r = m.radius;
    const f = facingSign(m);
    const bodyRx = r * 0.72;
    const bodyRy = r * 0.62;
    const bodyCx = m.x - f * r * 0.06;
    const bodyCy = m.y - r * 0.08;
    const headR = r * 0.38;
    const headX = m.x + f * r * 0.62;
    const headY = m.y - r * 0.02;
    const feet = bowlingCrawlFeet(m, r, f);
    const sid = m.id || 'bowl';
    // 不传不透明 base，让 clip 内只剩半透明洗/流/泡。
    const fillOpts = {
      palette: BOWLING_PALETTE,
      alpha: 0.04,
      flowAlpha: 0.4,
      bubbleAlpha: 0.14,
      bubblePulse: 0.1,
    };

    const tailCx = m.x - f * r * 0.55;
    const tailCy = m.y - r * 0.42;
    const tailRx = r * 0.22;
    const tailRy = r * 0.18;
    const pathTail = (c) => {
      c.moveTo(tailCx + f * tailRx * 0.2, tailCy + tailRy);
      c.bezierCurveTo(
        tailCx - f * tailRx * 1.1,
        tailCy + tailRy * 0.4,
        tailCx - f * tailRx * 1.2,
        tailCy - tailRy * 0.9,
        tailCx + f * tailRx * 0.15,
        tailCy - tailRy * 0.35
      );
      c.bezierCurveTo(
        tailCx + f * tailRx * 0.85,
        tailCy - tailRy * 0.1,
        tailCx + f * tailRx * 0.7,
        tailCy + tailRy * 0.55,
        tailCx + f * tailRx * 0.2,
        tailCy + tailRy
      );
      c.closePath();
    };
    pathTail.bounds = () => ({
      cx: tailCx,
      cy: tailCy,
      rx: tailRx * 1.15,
      ry: tailRy * 1.1,
    });

    fillStrokeClosed(
      ctx,
      Bub,
      m,
      `${sid}:tail`,
      pathTail,
      { ...fillOpts, count: 3 },
      0.09,
      'path'
    );

    // 爬行球：先画偏后/抬起的，主体后再画偏前的着地球。
    const mid = Math.ceil(feet.length / 2);
    for (let k = 0; k < mid; k += 1) {
      const ft = feet[k];
      fillStrokeCircle(
        ctx,
        Bub,
        ft.x,
        ft.y,
        ft.rad,
        m,
        `${sid}:foot${ft.i}`,
        { ...fillOpts, count: 3 },
        0.1
      );
    }

    fillStrokeClosed(
      ctx,
      Bub,
      m,
      `${sid}:body`,
      { cx: bodyCx, cy: bodyCy, rx: bodyRx, ry: bodyRy },
      { ...fillOpts, count: 8 },
      0.11,
      'ellipse'
    );

    for (let k = mid; k < feet.length; k += 1) {
      const ft = feet[k];
      fillStrokeCircle(
        ctx,
        Bub,
        ft.x,
        ft.y,
        ft.rad,
        m,
        `${sid}:foot${ft.i}`,
        { ...fillOpts, count: 3 },
        0.1
      );
    }

    fillStrokeCircle(
      ctx,
      Bub,
      headX,
      headY,
      headR,
      m,
      `${sid}:head`,
      { ...fillOpts, count: 5 },
      0.11
    );

    if (m.hitFlash > 0) {
      const a = 0.45 * (m.hitFlash / HIT_FLASH_LIFE);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.ellipse(bodyCx, bodyCy, bodyRx, bodyRy, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(headX, headY, headR, 0, Math.PI * 2);
      ctx.fill();
      for (const ft of feet) {
        ctx.beginPath();
        ctx.arc(ft.x, ft.y, ft.rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.beginPath();
      pathTail(ctx);
      ctx.fill();
    }
  }

  /**
   * 侧视气球：主体 + 内核 + 4 环绕卫星球；半透明泡泡 + 流动描边。
   * @param {CanvasRenderingContext2D} ctx
   * @param {ReturnType<typeof createMob>} m
   * @param {object | null | undefined} Bub
   */
  function drawBalloon(ctx, m, Bub) {
    const r = m.radius;
    const bob = Math.sin(m.bob || 0) * r * 0.04;
    const bodyR = r * 0.78;
    const coreR = r * 0.32;
    const cy = m.y + bob;
    const sats = balloonOrbitSats(m, r, cy);
    const sid = m.id || 'balloon';
    const fillOpts = {
      palette: BALLOON_PALETTE,
      alpha: 0.04,
      flowAlpha: 0.42,
      bubbleAlpha: 0.15,
      bubblePulse: 0.11,
    };

    // sats 已按 depth 升序；depth<0 在后，插在主体之前。
    for (const s of sats) {
      if (s.depth >= 0) break;
      fillStrokeCircle(
        ctx,
        Bub,
        s.x,
        s.y,
        s.rad,
        m,
        `${sid}:sat${s.i}`,
        { ...fillOpts, count: 3 },
        0.1
      );
    }

    fillStrokeCircle(
      ctx,
      Bub,
      m.x,
      cy,
      bodyR,
      m,
      `${sid}:body`,
      { ...fillOpts, count: 7 },
      0.12
    );

    fillStrokeCircle(
      ctx,
      Bub,
      m.x + r * 0.06,
      cy - r * 0.04,
      coreR,
      m,
      `${sid}:core`,
      { ...fillOpts, count: 4 },
      0.09
    );

    for (const s of sats) {
      if (s.depth < 0) continue;
      fillStrokeCircle(
        ctx,
        Bub,
        s.x,
        s.y,
        s.rad,
        m,
        `${sid}:sat${s.i}`,
        { ...fillOpts, count: 3 },
        0.1
      );
    }

    if (m.hitFlash > 0) {
      const a = 0.55 * (m.hitFlash / HIT_FLASH_LIFE);
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.beginPath();
      ctx.arc(m.x, cy, bodyR, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(m.x + r * 0.06, cy - r * 0.04, coreR, 0, Math.PI * 2);
      ctx.fill();
      for (const s of sats) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** 绘制小怪（世界坐标；应在车厢贴图之后调用以便可见）。 */
  function draw(ctx) {
    if (!ctx) return;
    const Bub = window.LpMobBubbleFill;
    Bub?.beginFrame?.(lastDt);
    for (const m of mobs) {
      if (!isMobCombatActive(m)) continue;
      ctx.save();
      if (
        m.kind === 'ground' ||
        m.species === 'bowling' ||
        m.species === 'bowling_thrower'
      ) {
        drawBowlingBall(ctx, m, Bub);
      } else {
        drawBalloon(ctx, m, Bub);
      }
      drawHpPip(ctx, m);
      ctx.restore();
    }
    drawThrownBalls(ctx);
  }

  /**
   * 是否视为「车厢内」：跳入/钻入/舱内游荡（轨面 / 空中俯冲 / 投掷种不算）。
   * @param {ReturnType<typeof createMob>} m
   */
  function isMobInsideCabin(m) {
    if (!m || m.canEnterCabin === false || m.species === 'bowling_thrower') {
      return false;
    }
    const p = m.phase;
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
   * 可对玩家造成接触伤害：舱内列车怪，或地牢怪（phase dungeon）。
   * 轨面 / 俯冲中不计，避免穿地板幽灵击退。
   * @param {ReturnType<typeof createMob> | null | undefined} m
   */
  function canMobContactPlayer(m) {
    if (!isMobCombatActive(m)) return false;
    if (m.dungeon || m.phase === 'dungeon') return true;
    return isMobInsideCabin(m);
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

  /** 供传感器 / 锁定 / 提前量：存活敌方摘要（含速度、护甲 stub、显示名）。 */
  function listHostiles() {
    return mobs
      .filter((m) => isMobCombatActive(m))
      .map((m) => ({
        id: m.id,
        x: m.x,
        y: m.y,
        kind: m.kind,
        species: m.species,
        label: m.label,
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
   * 清空小怪并重启波次（调试 / 开局）；开场刷近距压力 + 中/远簇，均受本程 WAVE_PACK 门控。
   * @param {{ view?: object, viewW?: number, viewH?: number }} [ctx] 可选相机视野，保证开场刷怪也在屏外
   */
  function reset(ctx) {
    mobs = [];
    thrownBalls = [];
    pendingDungeonSpawns = [];
    window.LpMobBubbleFill?.reset?.();
    window.LpMobDeathFx?.clear?.();
    rememberView(ctx);
    syncTravelWavePack(true);
    enterWavePhase(WAVE.startPhase === 'calm' ? 'calm' : 'wave');
    const S = spec();
    if (!S || wavePhase !== 'wave') return;
    const pack = activeWavePack;
    if (pack.id === 'boss') return;
    /* 近距开场压力（各最多 2，不组强制簇）；首只优先投掷种。 */
    if (pack.allowGround) {
      for (let i = 0; i < 2; i += 1) {
        const g = spawnGround(S, {
          fromLeft: i === 0,
          thrower: i === 0,
          extra:
            SPAWN_RANGE.nearExtraMin +
            Math.random() *
              (SPAWN_RANGE.nearExtraMax - SPAWN_RANGE.nearExtraMin),
        });
        if (g) mobs.push(g);
      }
    }
    if (pack.allowAir) {
      for (let i = 0; i < 2; i += 1) {
        const a = spawnAir(S, {
          fromLeft: i === 0,
          extra:
            SPAWN_RANGE.nearExtraMin +
            Math.random() *
              (SPAWN_RANGE.nearExtraMax - SPAWN_RANGE.nearExtraMin),
        });
        if (a) mobs.push(a);
      }
    }
    /* 中距 + 远距开场雷达簇（强制距带，避免再抽到 near）。 */
    const midExtra =
      SPAWN_RANGE.midExtraMin +
      Math.random() * (SPAWN_RANGE.midExtraMax - SPAWN_RANGE.midExtraMin);
    const farExtra =
      SPAWN_RANGE.farExtraMin +
      Math.random() * (SPAWN_RANGE.farExtraMax - SPAWN_RANGE.farExtraMin);
    if (pack.allowGround) {
      spawnGroundCluster(S, {
        band: 'mid',
        extra: midExtra,
        companions: SPAWN_RANGE.midCompanions,
      });
    }
    if (pack.allowAir) {
      spawnAirCluster(S, {
        band: 'far',
        extra: farExtra,
        companions: SPAWN_RANGE.farCompanions,
      });
    }
  }

  /** 调试只读：当前波次阶段、剩余时间与本程包。 */
  function getWaveState() {
    return {
      phase: wavePhase,
      phaseTimer,
      spawnTimer,
      packId: activeWavePack.id,
      packLabel: activeWavePack.label,
      packLeg: activeWavePackLeg,
      config: { ...WAVE },
    };
  }

  /** 调试只读：当前行程波次包。 */
  function getActiveWavePack() {
    return { ...activeWavePack, leg: activeWavePackLeg };
  }

  /**
   * 按物种取消散粒子色板（保龄球偏暖 / 气球偏冷）。
   * @param {{ species?: string, kind?: string } | null | undefined} m
   * @returns {number[][]}
   */
  function deathPaletteFor(m) {
    if (m?.species === 'balloon' || m?.kind === 'air') return BALLOON_PALETTE;
    return BOWLING_PALETTE;
  }

  /**
   * 在剔除前触发死亡消散特效（粒子 + 残影）；碰撞仍立刻 purge。
   * @param {ReturnType<typeof createMob>} m
   */
  function spawnDeathFx(m) {
    window.LpMobDeathFx?.spawnDissipate?.(m.x, m.y, {
      radius: m.radius,
      palette: deathPaletteFor(m),
    });
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
      spawnDeathFx(m);
      purgeDeadMobs();
    }
    return {
      ok: true,
      killed: !m.alive,
      hp: m.hp,
      maxHp: m.maxHp,
    };
  }

  window.addEventListener('liminal:platform-depart', (ev) => {
    const from = Number(ev?.detail?.stationIndex);
    beginTravelLeg(Number.isFinite(from) ? from : 0);
    enterWavePhase(WAVE.startPhase === 'calm' ? 'calm' : 'wave');
  });

  window.LpMobs = {
    tick,
    draw,
    reset,
    listHostiles,
    damageMob,
    probeSegmentHit,
    getWaveState,
    getActiveWavePack,
    beginTravelLeg,
    spawnDungeonFromLayout,
    clearDungeonMobs,
    clearTrainWaveMobs,
    /** 可调波次参数（就地改数字即可热调；改 duration 等需等下阶段切换生效）。 */
    WAVE,
    /** 行程波次包表（可热调 weight；改后下一程 beginTravelLeg 生效）。 */
    WAVE_PACKS,
    /** 可调刷怪距带（近/中/远外扩与权重；热调后下次刷怪生效）。 */
    SPAWN_RANGE,
    /** 地牢刷怪 FOV / 密度参数（热调后下一物化生效）。 */
    DUNGEON_SPAWN,
    /** 巨型投掷保龄配置（可就地热调 speed / throwInterval）。 */
    THROWER,
    /** 调试只读。 */
    getMobs: () => mobs.slice(),
    /** 调试：待激活地牢刷点。 */
    getPendingDungeonSpawns: () => pendingDungeonSpawns.slice(),
  };
})();
