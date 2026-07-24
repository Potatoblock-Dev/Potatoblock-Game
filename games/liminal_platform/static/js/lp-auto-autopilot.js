/**
 * 动力车厢「自动驾驶」状态机。
 * 由驾驶台开关接通/释放；接通时独占节流阀（巡航→接近减速→近站急刹→到站停车→汽笛上升沿恢复）。
 * 月台距离由 LpPlatform → LpAutoSensors.setPlatformStub 写入；读 getPlatformSensor。
 * 汽笛：动力驾驶台绳索 → LpWhistleAudio.isSounding()；停车态上升沿恢复。
 */
(() => {
  /** 满档前进（LpTrainDrive 最高正档）。 */
  const CRUISE_THROTTLE = 5;
  /** 接近月台但距离未知时的中档。 */
  const APPROACH_THROTTLE_DEFAULT = 3;
  /**
   * distanceAhead（与 LpPlatform 路线单位同量纲）→ 节流档映射阈值。
   * 须与 LpPlatform.DOCK_DIST / AHEAD 配套：近站必须主动刹停，不能只靠惰行。
   */
  const DIST_STOP = 120;
  const DIST_CREEP = 320;
  const DIST_SLOW = 700;
  /** 进入此距离后触发急刹，避免冲过停靠窗。 */
  const DIST_EMERGENCY = 280;

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

  /** 读取月台传感（经 LpAutoSensors，由 LpPlatform 每帧刷新）。 */
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

  /** 近站主动急刹（惰行刹不住，会冲过 DOCK 窗）。 */
  function applyStationBrake() {
    const drive = window.LpTrainDrive;
    if (typeof drive?.triggerEmergencyBrake === 'function') {
      drive.triggerEmergencyBrake();
      return;
    }
    applyThrottle(0);
    drive?.setBrake?.(1, { fromUser: true });
  }

  /** 离站恢复：松开制动拉杆（急刹闩锁在停稳后会自行解除）。 */
  function releaseStationBrake() {
    const drive = window.LpTrainDrive;
    drive?.setBrake?.(0, { fromUser: true });
  }

  /**
   * 是否应在接近阶段使用急刹。
   * @param {number|null|undefined} distanceAhead
   */
  function shouldEmergencyForApproach(distanceAhead) {
    if (distanceAhead == null || !Number.isFinite(Number(distanceAhead))) {
      return false;
    }
    return Number(distanceAhead) <= DIST_EMERGENCY;
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
        /* 仍有人在月台时不许发车：保持停车 */
        if (window.LpPlatform && !window.LpPlatform.canDepart?.()) {
          const reason = window.LpPlatform.getDepartBlockReason?.();
          if (reason) window.LiminalInteract?.showToast?.(reason, 1400);
          return true;
        }
        phase = 'cruise';
        releaseStationBrake();
        applyThrottle(CRUISE_THROTTLE);
      }
      return true;
    }

    if (plat.atPlatform) {
      phase = 'stopped';
      applyStationBrake();
      return true;
    }

    if (plat.platformAhead) {
      phase = 'approach';
      const notch = approachThrottle(plat.distanceAhead);
      if (notch <= 0 || shouldEmergencyForApproach(plat.distanceAhead)) {
        applyStationBrake();
      } else {
        applyThrottle(notch);
      }
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
    DIST_EMERGENCY,
    isEngaged,
    setEngaged,
    toggleEngaged,
    tick,
    getState,
    setPhaseForDebug,
  };
})();
