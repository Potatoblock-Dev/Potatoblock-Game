/**
 * 动力车厢「自动驾驶」状态机。
 * 由驾驶台开关接通/释放；接通时独占节流阀（巡航→接近减速→近站急刹→到站停车→汽笛上升沿离站）。
 * 月台距离由 LpPlatform → LpAutoSensors.setPlatformStub 写入；读 getPlatformSensor。
 * 汽笛：动力驾驶台绳索 → LpWhistleAudio.isSounding()；停靠态上升沿起 3s 后再做全员在车检测，通过则 beginDepart。
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
  /** 汽笛上升沿后，等待此时长再跑 canDepart / beginDepart。 */
  const WHISTLE_DEPART_DELAY_SEC = 3;

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
   * 汽笛上升沿武装发车检测的时刻（performance.now）；null 表示未等待。
   * 等待中不再因每帧汽笛状态重武装。
   */
  let departCheckArmedAtMs = null;

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

  /** 取消汽笛发车等待（离站 / 关自动驾驶 / 离开停靠态）。 */
  function clearDepartArm() {
    departCheckArmedAtMs = null;
  }

  /**
   * 武装 3s 发车检测；已在等待则忽略（避免每帧或重复拉笛重置）。
   */
  function armDepartCheck() {
    if (departCheckArmedAtMs != null) return;
    departCheckArmedAtMs = performance.now();
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
    clearDepartArm();
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
   * 跑发车校验：全员在车厢则离站并恢复巡航；否则 toast 并保持停车。
   * 在汽笛上升沿武装后满 WHISTLE_DEPART_DELAY_SEC 才调用。
   * @returns {boolean} 是否已发车
   */
  function tryWhistleDepart() {
    clearDepartArm();
    const plat = window.LpPlatform;
    if (plat && !plat.canDepart?.()) {
      const reason = plat.getDepartBlockReason?.() || '还有玩家在月台上';
      window.LiminalInteract?.showToast?.(reason, 1400);
      return false;
    }
    /* 立刻离站，避免下一帧仍读到 atPlatform 又急刹回去 */
    if (plat?.beginDepart && !plat.beginDepart()) {
      window.LiminalInteract?.showToast?.('还有玩家在月台上', 1400);
      return false;
    }
    phase = 'cruise';
    releaseStationBrake();
    applyThrottle(CRUISE_THROTTLE);
    window.LiminalInteract?.showToast?.('自动驾驶：驶向下一个月台', 1200);
    return true;
  }

  /**
   * 停靠态：汽笛上升沿武装等待；满延时后跑 tryWhistleDepart。
   * 离站 / 离开月台则取消等待。
   * @param {{ atPlatform?: boolean }} plat
   * @param {boolean} whistleEdge
   */
  function tickStoppedDepart(plat, whistleEdge) {
    applyThrottle(0);
    if (!plat.atPlatform) {
      clearDepartArm();
      return;
    }
    if (whistleEdge) {
      armDepartCheck();
    }
    if (departCheckArmedAtMs == null) return;
    const elapsedSec = (performance.now() - departCheckArmedAtMs) / 1000;
    if (elapsedSec >= WHISTLE_DEPART_DELAY_SEC) {
      tryWhistleDepart();
    }
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
      tickStoppedDepart(plat, whistleEdge);
      return true;
    }

    clearDepartArm();

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
      departCheckArmed: departCheckArmedAtMs != null,
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
      if (next !== 'stopped') clearDepartArm();
    }
  }

  window.LpAutoAutopilot = {
    CRUISE_THROTTLE,
    DIST_STOP,
    DIST_CREEP,
    DIST_SLOW,
    DIST_EMERGENCY,
    WHISTLE_DEPART_DELAY_SEC,
    isEngaged,
    setEngaged,
    toggleEngaged,
    tick,
    getState,
    setPhaseForDebug,
  };
})();
