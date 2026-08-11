/**
 * 进站 / 离站承重柱掠过 FX：短暂遮挡屏幕，并与 LpWorldBackground 月台/轨面主题交叉切换。
 * 不锁输入；典型时长 ~1s。事件：liminal:platform-arrive / depart / platform-scene。
 */
(() => {
  /** 柱列掠过总时长（秒）。 */
  const DURATION_SEC = 1.05;
  /** 主题在柱列遮挡峰值附近切换（0–1 进度）。 */
  const THEME_SWAP_AT = 0.42;
  /** 场景切入月台时稍短一截。 */
  const SCENE_DURATION_SEC = 0.72;
  /** 柱条数量（软边竖带，非硬 AABB）。 */
  const PILLAR_COUNT = 6;
  /** 单柱相对屏宽。 */
  const PILLAR_WIDTH_FRAC = 0.11;
  /** 柱间距相对屏宽。 */
  const PILLAR_GAP_FRAC = 0.065;

  /** @type {'idle'|'playing'} */
  let phase = 'idle';
  /** 进度 0→1。 */
  let progress = 0;
  let durationSec = DURATION_SEC;
  /** @type {'arrive'|'depart'|'scene'} */
  let kind = 'arrive';
  /** 目标主题：1=月台感，0=轨面虚空。 */
  let targetMix = 0;
  /** 切换前主题；swap 后跳到 target。 */
  let fromMix = 0;
  /** 是否已在本段 FX 内完成主题切换。 */
  let swapped = false;
  /** 当前对外主题混合（供背景读取）。 */
  let stationMix = 0;
  /** 柱列水平扫掠方向：+1 向右，-1 向左。 */
  let sweepSign = 1;
  let seeded = false;

  /**
   * 钳制到 [0,1]。
   * @param {number} v
   * @returns {number}
   */
  function clamp01(v) {
    if (!(v > 0)) return 0;
    if (v >= 1) return 1;
    return v;
  }

  /**
   * 平滑步进（柱列显隐与主题交叉）。
   * @param {number} t
   * @returns {number}
   */
  function smoothstep(t) {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
  }

  /**
   * 解析世界种子供柱宽抖动。
   * @returns {number}
   */
  function resolveSeed() {
    const live = window.LpPlatform?.getWorldSeed?.();
    if (Number.isFinite(live)) return live >>> 0;
    return 0x51a710;
  }

  /**
   * 按当前停靠 / 场景推断稳态主题（无 FX 时）。
   * @returns {number}
   */
  function steadyMixFromWorld() {
    if (window.LpPlatform?.getScene?.() === 'platform') return 1;
    if (window.LpPlatform?.isAtPlatform?.()) return 1;
    return 0;
  }

  /**
   * 扫掠方向：优先列车前进感（离站向右掠过），进站反向。
   * @param {'arrive'|'depart'|'scene'} k
   * @returns {number}
   */
  function pickSweepSign(k) {
    if (k === 'depart') return 1;
    if (k === 'arrive') return -1;
    return 1;
  }

  /**
   * 把当前混合推到背景模块。
   */
  function pushMixToBackground() {
    window.LpWorldBackground?.setStationMix?.(stationMix);
  }

  /**
   * 开始一段柱列 FX，并在峰值切换背景主题。
   * @param {'arrive'|'depart'|'scene'} nextKind
   * @param {{ duration?: number, skipIfSame?: boolean }} [opts]
   */
  function play(nextKind, opts = {}) {
    const k = nextKind === 'depart' || nextKind === 'scene' ? nextKind : 'arrive';
    const want =
      k === 'depart' ? 0 : 1;
    if (opts.skipIfSame && Math.abs(stationMix - want) < 0.04 && phase === 'idle') {
      stationMix = want;
      pushMixToBackground();
      return;
    }
    kind = k;
    fromMix = stationMix;
    targetMix = want;
    durationSec =
      Number.isFinite(opts.duration) && opts.duration > 0
        ? opts.duration
        : k === 'scene'
          ? SCENE_DURATION_SEC
          : DURATION_SEC;
    progress = 0;
    swapped = false;
    sweepSign = pickSweepSign(k);
    phase = 'playing';
    seeded = true;
    pushMixToBackground();
  }

  /**
   * 无动画直接对齐主题（首屏 ?dock=1 等）。
   * @param {number} mix
   */
  function setMixImmediate(mix) {
    stationMix = clamp01(mix);
    phase = 'idle';
    progress = 0;
    swapped = false;
    pushMixToBackground();
  }

  /**
   * 推进 FX；不阻塞输入。
   * @param {number} [dt]
   */
  function tick(dt) {
    if (!seeded) {
      seeded = true;
      setMixImmediate(steadyMixFromWorld());
    }
    if (phase !== 'playing') return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(0.05, dt) : 1 / 60;
    progress = clamp01(progress + step / durationSec);
    if (!swapped && progress >= THEME_SWAP_AT) {
      swapped = true;
      stationMix = targetMix;
      pushMixToBackground();
    }
    if (progress >= 1) {
      phase = 'idle';
      progress = 1;
      stationMix = targetMix;
      pushMixToBackground();
    }
  }

  /**
   * 柱列遮挡强度：中间段最强，两端淡出。
   * @param {number} p
   * @returns {number}
   */
  function occlusionEnvelope(p) {
    const a = smoothstep(p / 0.22);
    const b = 1 - smoothstep((p - 0.72) / 0.28);
    return clamp01(Math.min(a, b));
  }

  /**
   * 屏幕空间绘制承重柱掠过（须在 identity transform 下调用）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ width: number, height: number, dpr?: number }} meta
   */
  function draw(ctx, meta) {
    if (!ctx || phase !== 'playing') return;
    const w = meta?.width || ctx.canvas?.width || 0;
    const h = meta?.height || ctx.canvas?.height || 0;
    if (!(w > 0) || !(h > 0)) return;

    const env = occlusionEnvelope(progress);
    if (env < 0.01) return;

    const seed = resolveSeed();
    const pillarW = w * PILLAR_WIDTH_FRAC;
    const gap = w * PILLAR_GAP_FRAC;
    const band = PILLAR_COUNT * (pillarW + gap);
    /* 整组从屏外扫入再扫出 */
    const travel = w + band + pillarW;
    const t = smoothstep(progress);
    const origin =
      sweepSign > 0
        ? -band + t * travel
        : w + band - t * travel;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    for (let i = 0; i < PILLAR_COUNT; i += 1) {
      const jitter =
        ((Math.imul(seed ^ (i * 0x9e3779b9), 0x85ebca6b) >>> 0) % 1000) / 1000;
      const pw = pillarW * (0.78 + jitter * 0.45);
      const x =
        origin +
        i * (pillarW + gap) * (sweepSign > 0 ? 1 : -1) -
        (sweepSign > 0 ? 0 : pw);
      if (x > w + pw || x + pw < -pw) continue;

      const peak = (0.55 + jitter * 0.28) * env;
      const g = ctx.createLinearGradient(x, 0, x + pw, 0);
      g.addColorStop(0, 'rgba(6, 7, 10, 0)');
      g.addColorStop(0.18, `rgba(10, 11, 14, ${peak * 0.55})`);
      g.addColorStop(0.5, `rgba(8, 9, 12, ${peak})`);
      g.addColorStop(0.82, `rgba(10, 11, 14, ${peak * 0.55})`);
      g.addColorStop(1, 'rgba(6, 7, 10, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - pw * 0.15, 0, pw * 1.3, h);

      /* 顶棚压暗：柱顶一带略深，增强「站内结构」感 */
      const canopy = ctx.createLinearGradient(0, 0, 0, h * 0.22);
      canopy.addColorStop(0, `rgba(4, 5, 8, ${peak * 0.35})`);
      canopy.addColorStop(1, 'rgba(4, 5, 8, 0)');
      ctx.fillStyle = canopy;
      ctx.fillRect(x - pw * 0.1, 0, pw * 1.2, h * 0.22);
    }

    ctx.restore();
  }

  /**
   * 当前月台主题混合 0=轨面虚空，1=月台感。
   * @returns {number}
   */
  function getStationMix() {
    return stationMix;
  }

  /**
   * 是否正在播放柱列 FX。
   * @returns {boolean}
   */
  function isPlaying() {
    return phase === 'playing';
  }

  /**
   * 响应离站：柱列掠过 → 切回轨面虚空。
   */
  function onDepart() {
    play('depart');
  }

  /**
   * 响应进站停靠：柱列掠过 → 切月台主题。
   */
  function onArrive() {
    play('arrive');
  }

  /**
   * 响应本机场景切换：进月台播短柱列；回车若仍停靠则保持站感。
   * @param {CustomEvent} ev
   */
  function onPlatformScene(ev) {
    const scene = ev?.detail?.scene;
    if (scene === 'platform') {
      play('scene');
      return;
    }
    if (scene === 'train') {
      if (window.LpPlatform?.isAtPlatform?.()) {
        setMixImmediate(1);
      } else if (phase !== 'playing') {
        setMixImmediate(0);
      }
    }
  }

  window.addEventListener('liminal:platform-depart', onDepart);
  window.addEventListener('liminal:platform-arrive', onArrive);
  window.addEventListener('liminal:platform-scene', onPlatformScene);

  window.LpStationTransit = {
    tick,
    draw,
    play,
    setMixImmediate,
    getStationMix,
    isPlaying,
  };
})();
