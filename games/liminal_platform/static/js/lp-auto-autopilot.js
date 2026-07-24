/**
 * 动力车厢「自动驾驶」状态机。
 * 由驾驶台开关接通/释放；接通时独占节流阀（巡航→接近减速→到站停车→汽笛上升沿恢复）。
 * 月台传感未落地前 platformAhead/atPlatform 恒假，故常驻巡航；钩子已接好。
 * 汽笛：动力驾驶台绳索 → LpWhistleAudio.isSounding()；停车态上升沿恢复。
 */
(() => {
  /** 满档前进（LpTrainDrive 最高正档）。 */
  const CRUISE_THROTTLE = 5;
  /** 接近月台但距离未知时的中档。 */
  const APPROACH_THROTTLE_DEFAULT = 3;
  /** distanceAhead（世界单位）→ 节流档映射阈值。 */
  const DIST_STOP = 50;
  const DIST_CREEP = 200;
  const DIST_SLOW = 500;

  /**
   * @typedef {'cruise'|'approach'|'stopped'} AutopilotPhase
   */

  /** @type {AutopilotPhase} */
  let phase = 'cruise';
  /** 驾驶台开关：true 时每帧写节流。 */
  let engaged = false;
  /** 上一帧汽笛是否在鸣（上升沿检测）。 */
  let whistleWasSounding = false;

  /**
   * 按距月台距离选取减速档；无距离时用默认中档。
   * @param {number|null|undefined} distanceAhead
   */
  function approachThrottle(distanceAhead) {
    if (distanceAhead == null || !Number.isFinite(Number(distanceAhead))) {
      return APPROACH_THROTTLE_DEFAULT;
    }
    const d = Number(distanceAhead);
    if (d <= DIST_STOP) return 0;
    if (d <= DIST_CREEP) return 1;
    if (d <= DIST_SLOW) return 3;
    return CRUISE_THROTTLE;
  }

  /** 读取月台 stub 传感（经 LpAutoSensors；未实现时恒假/null）。 */
  function readPlatform() {
    const s = window.LpAutoSensors;
    if (!s?.getPlatformSensor) {
      return { platformAhead: false, atPlatform: false, distanceAhead: null };
    }
    return s.getPlatformSensor();
  }

  /** 当前汽笛是否在鸣（驾驶台拉绳）。 */
  function whistleSounding() {
    return Boolean(window.LpWhistleAudio?.isSounding?.());
  }

  /**
   * 向驾驶系统写节流；急刹中由 LpTrainDrive 自行锁停。
   * @param {number} notch
   */
  function applyThrottle(notch) {
    const drive = window.LpTrainDrive;
    if (typeof drive?.setThrottle !== 'function') return;
    drive.setThrottle(notch);
  }

  /** 是否已接通自动驾驶（节流由本模块接管）。 */
  function isEngaged() {
    return engaged;
  }

  /**
   * 接通或释放自动驾驶。
   * 释放时不改当前节流（交还手动拉杆）；接通时从巡航相位开始。
   * @param {boolean} on
   * @returns {boolean} 接通后状态
   */
  function setEngaged(on) {
    const next = Boolean(on);
    if (next === engaged) return engaged;
    engaged = next;
    if (engaged) {
      phase = 'cruise';
      whistleWasSounding = whistleSounding();
    } else {
      phase = 'cruise';
      whistleWasSounding = false;
    }
    window.dispatchEvent(
      new CustomEvent('liminal:autopilot', { detail: getState() })
    );
    return engaged;
  }

  /** 切换接通状态；返回切换后是否接通。 */
  function toggleEngaged() {
    return setEngaged(!engaged);
  }

  /**
   * 每帧推进：仅在接通时写节流；关闭时为 no-op。
   * @returns {boolean} 本帧是否执行了自动驾驶
   */
  function tick() {
    if (!engaged) return false;

    const plat = readPlatform();
    const sounding = whistleSounding();
    const whistleEdge = sounding && !whistleWasSounding;
    whistleWasSounding = sounding;

    if (phase === 'stopped') {
      applyThrottle(0);
      if (whistleEdge) {
        phase = 'cruise';
        applyThrottle(CRUISE_THROTTLE);
      }
      return true;
    }

    if (plat.atPlatform) {
      phase = 'stopped';
      applyThrottle(0);
      return true;
    }

    if (plat.platformAhead) {
      phase = 'approach';
      applyThrottle(approachThrottle(plat.distanceAhead));
      return true;
    }

    phase = 'cruise';
    applyThrottle(CRUISE_THROTTLE);
    return true;
  }

  /** 只读快照（调试 / UI）。 */
  function getState() {
    return {
      engaged,
      /** @deprecated 同 engaged；旧 UI 兼容 */
      active: engaged,
      phase,
      whistleSounding: whistleSounding(),
      platform: readPlatform(),
    };
  }

  /**
   * 调试：强制相位（不写节流；下一帧 tick 会覆盖）。
   * @param {AutopilotPhase} next
   */
  function setPhaseForDebug(next) {
    if (next === 'cruise' || next === 'approach' || next === 'stopped') {
      phase = next;
    }
  }

  window.LpAutoAutopilot = {
    CRUISE_THROTTLE,
    DIST_STOP,
    DIST_CREEP,
    DIST_SLOW,
    isEngaged,
    setEngaged,
    toggleEngaged,
    tick,
    getState,
    setPhaseForDebug,
  };
})();
