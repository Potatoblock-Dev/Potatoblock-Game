/**
 * 车厢贴图行驶颠簸（客户端纯视觉）：每节独立用本机 Math.random() 抽签，
 * 命中则播短颠簸包络；仅 canvas 偏移，不改世界坐标。
 * 读 LpTrainDrive.speed；不触碰 LpTrainAudio。
 * 不联网、不共享房间种子；各客户端颠簸不必一致。
 */
(() => {
  /** 与车速表/雷达一致：低于此视为静止。 */
  const SPEED_EPS = 0.08;
  /** 与 LpTrainDrive.MAX_SPEED 对齐，用于振幅归一。 */
  const SPEED_REF = 5;
  /** 强度向目标速度包络的指数阻尼（越大停得越快）。 */
  const INTENSITY_DAMP = 7.5;
  /** 倾转枢轴相对 MODULE_H 的高度比（近底盘）。 */
  const ROLL_PIVOT_Y = 0.72;

  /** 每节车厢抽签间隔（秒，满速附近略缩短）。 */
  const ROLL_INTERVAL = 0.48;
  /** 抽签命中区间：[0, TRIGGER_CHANCE)；满速有效约 20%。 */
  const TRIGGER_CHANCE = 0.2;
  /** 单次颠簸包络时长（秒）。 */
  const JOLT_DURATION = 0.14;
  /** 满速竖直峰值（世界像素）。 */
  const JOLT_AMP = 1.05;
  /** 满速微倾峰值（弧度，约 0.1°）。 */
  const ROLL_AMP = 0.0018;

  let intensity = 0;

  /**
   * 每节车厢独立状态：下次抽签倒计时、颠簸进度、方向与幅度缩放。
   * @type {Map<number, { rollCd: number, joltAge: number, sign: number, amp: number }>}
   */
  const cars = new Map();

  /**
   * 懒创建车厢状态；首次 rollCd 用本机随机错开，避免全列同步颠簸。
   * @param {number} carIndex
   */
  function ensureCar(carIndex) {
    const i = Number(carIndex) || 0;
    let s = cars.get(i);
    if (!s) {
      s = {
        rollCd: Math.random() * ROLL_INTERVAL,
        joltAge: -1,
        sign: 1,
        amp: 1,
      };
      cars.set(i, s);
    }
    return s;
  }

  /**
   * 推进强度包络，并为各节车厢本机抽签 / 推进颠簸包络；静止时清零。
   * @param {number} dt
   */
  function tick(dt) {
    const speed = Number(window.LpTrainDrive?.getState?.()?.speed) || 0;
    const abs = Math.abs(speed);
    const target = abs < SPEED_EPS ? 0 : Math.min(1, abs / SPEED_REF);
    const k = 1 - Math.exp(-INTENSITY_DAMP * Math.max(0, dt));
    intensity += (target - intensity) * k;
    if (intensity < 1e-4) {
      intensity = 0;
      for (const s of cars.values()) {
        s.joltAge = -1;
        s.rollCd = Math.random() * ROLL_INTERVAL;
      }
      return;
    }

    const dtClamped = Math.max(0, dt);
    const n = window.LiminalCarriageSpec?.CARRIAGES?.length || 0;
    for (let i = 0; i < n; i++) ensureCar(i);

    /** 低速时降低触发率；满速接近 TRIGGER_CHANCE。 */
    const chance = TRIGGER_CHANCE * (0.4 + 0.6 * intensity);
    /** 略随车速加快抽签。 */
    const interval = ROLL_INTERVAL * (1.12 - 0.12 * target);

    for (const s of cars.values()) {
      if (s.joltAge >= 0) {
        s.joltAge += dtClamped;
        if (s.joltAge >= JOLT_DURATION) s.joltAge = -1;
      }
      s.rollCd -= dtClamped;
      while (s.rollCd <= 0) {
        s.rollCd += interval;
        if (s.joltAge < 0 && Math.random() < chance) {
          s.joltAge = 0;
          s.sign = Math.random() < 0.5 ? -1 : 1;
          s.amp = 0.75 + Math.random() * 0.35;
        }
      }
    }
  }

  /**
   * 采样单节车厢当前绘制偏移（世界 Y 下移为正、roll 为 canvas 顺时针）。
   * @param {number} carIndex
   * @returns {{ y: number, roll: number }}
   */
  function sample(carIndex) {
    if (intensity <= 0) return { y: 0, roll: 0 };
    const s = ensureCar(carIndex);
    if (s.joltAge < 0 || s.joltAge >= JOLT_DURATION) return { y: 0, roll: 0 };
    const u = s.joltAge / JOLT_DURATION;
    const env = Math.sin(Math.PI * u);
    const mag = env * s.amp * intensity;
    return {
      y: s.sign * mag * JOLT_AMP,
      roll: s.sign * mag * ROLL_AMP * 0.85,
    };
  }

  /**
   * 对单节车厢贴图施加视觉-only 变换后调用 drawFn；保证 restore。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ worldX: number }} car
   * @param {number} carIndex
   * @param {() => void} drawFn
   */
  function withCarDraw(ctx, car, carIndex, drawFn) {
    const Spec = window.LiminalCarriageSpec;
    const { y, roll } = sample(carIndex);
    ctx.save();
    if (Spec && (y !== 0 || roll !== 0)) {
      const cx = car.worldX + Spec.MODULE_W * 0.5;
      const cy = Spec.MODULE_H * ROLL_PIVOT_Y;
      ctx.translate(cx, cy + y);
      ctx.rotate(roll);
      ctx.translate(-cx, -cy);
    }
    drawFn();
    ctx.restore();
  }

  /**
   * 卫兵炮管绘制用：与 guard 车厢同一套偏移，避免贴图错位。
   * @returns {{ y: number, roll: number }}
   */
  function sampleGuard() {
    const Spec = window.LiminalCarriageSpec;
    const idx = Spec?.CARRIAGES?.findIndex?.((c) => c.id === 'guard');
    return sample(idx >= 0 ? idx : 0);
  }

  /**
   * 在已有世界变换下套一层 guard 颠簸（仅绘制）；调用方负责外层 save/restore 亦可再套一层。
   * @param {CanvasRenderingContext2D} ctx
   * @param {() => void} drawFn
   */
  function withGuardDraw(ctx, drawFn) {
    const Spec = window.LiminalCarriageSpec;
    const car = Spec?.carriageById?.('guard');
    if (!car || !Spec) {
      drawFn();
      return;
    }
    withCarDraw(ctx, car, Spec.CARRIAGES.findIndex((c) => c.id === 'guard'), drawFn);
  }

  window.LpCarriageBob = {
    tick,
    sample,
    sampleGuard,
    withCarDraw,
    withGuardDraw,
    /** 当前强度 0–1（本机调试用，非网络同步）。 */
    getIntensity() {
      return intensity;
    },
  };
})();
