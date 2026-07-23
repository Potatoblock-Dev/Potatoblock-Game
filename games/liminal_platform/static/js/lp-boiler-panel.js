/**
 * 动力车驾驶台：节流阀 + 制动阀 + 汽笛绳（嵌入式机柜 UI）。
 * 拖动时滑块跟手；外部改档 / 松手吸附时滑块缓动就位。
 * 汽笛为本地音效（不下发协议）；下拉 intro→loop，松手 outro 回弹；关面板硬停。
 */
(() => {
  const root = document.getElementById('lpBoilerPanelRoot');
  const throttleTrack = document.getElementById('lpThrottleTrack');
  const throttleKnob = document.getElementById('lpThrottleKnob');
  const brakeTrack = document.getElementById('lpBrakeTrack');
  const brakeKnob = document.getElementById('lpBrakeKnob');
  const throttleReadout = document.getElementById('lpThrottleReadout');
  const brakeReadout = document.getElementById('lpBrakeReadout');
  const speedReadout = document.getElementById('lpSpeedReadout');
  const speedNeedle = document.getElementById('lpSpeedoNeedle');
  const speedDir = document.getElementById('lpSpeedoDir');
  const closeButton = document.getElementById('lpBoilerPanelClose');
  const fuelFill = document.getElementById('lpFuelGaugeFill');
  const cabStencilDesktop = document.getElementById('lpCabStencilDesktop');
  const whistleRope = document.getElementById('lpWhistleRope');
  const whistleReadout = document.getElementById('lpWhistleReadout');

  if (!root || !throttleTrack || !brakeTrack) return;

  const Drive = window.LpTrainDrive;
  const Whistle = window.LpWhistleAudio;
  const SPEED_DISPLAY_MAX = 120;
  /** 节流滑块就位速率（越大越快）。 */
  const THROTTLE_EASE = 14;
  /** 制动非回弹时的就位速率。 */
  const BRAKE_EASE = 16;

  const WHISTLE_MAX_PULL_PX = 88;
  const WHISTLE_SOUND_THRESHOLD = 0.22;

  let open = false;
  let drag = null;
  /** 界面显示用节流值（可与逻辑档位不同，用于缓动）。 */
  let uiThrottle = 0;
  /** 界面显示用制动比例 0…1。 */
  let uiBrake = 0;
  let lastSyncTs = performance.now();

  let whistlePulling = false;
  let whistlePull = 0;
  let whistlePointerId = null;
  let whistleStartY = 0;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 同步桌面离席提示（交互键与 Esc）。 */
  function syncLeaveHint() {
    if (!cabStencilDesktop) return;
    const key = window.LpInputBindings?.formatAction('interact') || 'F';
    cabStencilDesktop.textContent = `拖动拉杆或点刻度 · 下拉汽笛 · ${key} / Esc 离开`;
  }

  /** 更新汽笛绳下拉视觉与「松/鸣」标签。 */
  function paintWhistle() {
    if (!whistleRope) return;
    const sounding = Boolean(Whistle?.isSounding?.());
    const px = Math.round(whistlePull * WHISTLE_MAX_PULL_PX);
    whistleRope.style.setProperty('--lp-whistle-pull', `${px}px`);
    whistleRope.classList.toggle('is-pulling', whistlePulling);
    whistleRope.classList.toggle('is-sounding', sounding);
    whistleRope.setAttribute('aria-pressed', sounding ? 'true' : 'false');
    if (whistleReadout) {
      whistleReadout.textContent = sounding ? '汽笛 · 鸣' : '汽笛 · 松';
    }
  }

  /** 开始汽笛（intro→loop）；异步解锁后补绘一次。 */
  function startWhistleSound() {
    if (!Whistle || Whistle.isSounding()) {
      paintWhistle();
      return;
    }
    paintWhistle();
    const started = Whistle.start();
    if (started && typeof started.then === 'function') {
      started.then(() => paintWhistle()).catch((err) => {
        console.warn('[lp-boiler] whistle start', err);
      });
    }
  }

  /** 松手：绳回弹并播 outro（若曾发声）。 */
  function releaseWhistle() {
    whistlePulling = false;
    whistlePointerId = null;
    whistlePull = 0;
    Whistle?.release?.();
    paintWhistle();
  }

  /** 关面板：绳复位并硬停汽笛（不播 outro）。 */
  function abortWhistle() {
    whistlePulling = false;
    whistlePointerId = null;
    whistlePull = 0;
    Whistle?.stop?.();
    paintWhistle();
  }

  /** 按指针位移更新下拉量；过阈值后 intro→loop 直至松手。 */
  function applyWhistlePointer(clientY) {
    const delta = Math.max(0, clientY - whistleStartY);
    whistlePull = Math.min(1, delta / WHISTLE_MAX_PULL_PX);
    paintWhistle();
    if (whistlePull >= WHISTLE_SOUND_THRESHOLD) startWhistleSound();
  }

  /** 绑定汽笛绳拖拽（本地下拉鸣笛）。 */
  function bindWhistleRope() {
    if (!whistleRope) return;

    whistleRope.addEventListener('pointerdown', (event) => {
      if (!open || event.button != null && event.button !== 0) return;
      whistlePulling = true;
      whistlePointerId = event.pointerId;
      whistleStartY = event.clientY;
      whistleRope.setPointerCapture(event.pointerId);
      Whistle?.unlock?.();
      applyWhistlePointer(event.clientY);
      event.preventDefault();
    });

    whistleRope.addEventListener('pointermove', (event) => {
      if (!whistlePulling || event.pointerId !== whistlePointerId) return;
      applyWhistlePointer(event.clientY);
    });

    const end = (event) => {
      if (!whistlePulling || event.pointerId !== whistlePointerId) return;
      releaseWhistle();
    };
    whistleRope.addEventListener('pointerup', end);
    whistleRope.addEventListener('pointercancel', end);
  }

  /** 打开驾驶台。 */
  function openPanel() {
    if (open) return;
    if (window.LpInventory?.isOpen()) window.LpInventory.close();
    if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
    if (window.LpGuardCrateUi?.isOpen()) window.LpGuardCrateUi.close();
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-boiler-panel-open');
    window.LpTouchControls?.setEnabled(false);
    syncLeaveHint();
    window.LpGame?.faceTrainForward?.();
    const state = Drive.getState();
    uiThrottle = state.throttle;
    uiBrake = state.brake;
    lastSyncTs = performance.now();
    syncFromState();
    syncFuelGauge();
    paintWhistle();
  }

  /** 关闭驾驶台。 */
  function closePanel() {
    if (!open) return;
    open = false;
    drag = null;
    abortWhistle();
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-boiler-panel-open');
    window.LpTouchControls?.setEnabled(true);
  }

  /** 切换。 */
  function toggle() {
    if (open) closePanel();
    else openPanel();
  }

  /** 节流值 → 拉杆垂直比例（上=前进，下=后退）。 */
  function throttleToRatio(throttle) {
    return (5 - throttle) / 10;
  }

  /** 拉杆比例 → 节流值。 */
  function ratioToThrottle(ratio) {
    return 5 - ratio * 10;
  }

  /** 指数逼近目标。 */
  function easeToward(current, target, rate, dt) {
    const next = current + (target - current) * (1 - Math.exp(-rate * dt));
    return Math.abs(target - next) < 0.02 ? target : next;
  }

  /** 绘制滑块位置与仪表（读数跟逻辑状态）。 */
  function paint(state) {
    throttleKnob.style.top = `${throttleToRatio(uiThrottle) * 100}%`;
    brakeKnob.style.top = `${uiBrake * 100}%`;
    if (throttleReadout) throttleReadout.textContent = state.throttleLabel;
    if (brakeReadout) brakeReadout.textContent = state.brakeLabel;
    const abs = Math.abs(state.speed);
    const ratio = Math.min(1, abs / 5);
    const kmh = Math.round(ratio * SPEED_DISPLAY_MAX);
    if (speedReadout) speedReadout.textContent = String(kmh);
    if (speedDir) {
      speedDir.textContent =
        abs < 0.08 ? '静止' : state.speed > 0 ? '前进' : '后退';
    }
    if (speedNeedle) {
      const angle = -120 + ratio * 240;
      speedNeedle.style.transform = `rotate(${angle}deg)`;
    }
  }

  /** 更新拉杆与读数 UI（拖动跟手，其余缓动就位）。 */
  function syncFromState() {
    const state = Drive.getState();
    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - lastSyncTs) / 1000));
    lastSyncTs = now;

    if (drag?.kind === 'throttle') {
      /* 跟手：uiThrottle 已在 applyPointer 写入 */
    } else {
      uiThrottle = easeToward(uiThrottle, state.throttle, THROTTLE_EASE, dt);
    }

    if (drag?.kind === 'brake') {
      /* 跟手 */
    } else if (state.brakeSpringing) {
      uiBrake = state.brake;
    } else {
      uiBrake = easeToward(uiBrake, state.brake, BRAKE_EASE, dt);
    }

    paint(state);
  }

  /** 从指针位置写入拉杆（拖动中连续、跟手）。 */
  function applyPointer(track, clientY, kind) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    if (kind === 'throttle') {
      const throttle = ratioToThrottle(ratio);
      Drive.setThrottleRaw(throttle);
      const st = Drive.getState();
      /* 急刹锁档时滑块不能跟手离开空档 */
      uiThrottle =
        st.emergencyActive || Drive.isEmergencyBrake?.() ? st.throttle : throttle;
    } else {
      Drive.setBrakeRaw(ratio);
      uiBrake = ratio;
    }
    paint(Drive.getState());
  }

  /** 绑定一根拉杆的拖拽。 */
  function bindLever(track, kind) {
    track.addEventListener('pointerdown', (event) => {
      if (!open) return;
      drag = { kind, pointerId: event.pointerId };
      track.setPointerCapture(event.pointerId);
      applyPointer(track, event.clientY, kind);
      event.preventDefault();
    });
  }

  bindLever(throttleTrack, 'throttle');
  bindLever(brakeTrack, 'brake');
  bindWhistleRope();

  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const track = drag.kind === 'throttle' ? throttleTrack : brakeTrack;
    applyPointer(track, event.clientY, drag.kind);
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.kind === 'throttle') {
      Drive.snapThrottle();
    } else if (drag.kind === 'brake') {
      finishBrakeDrag();
    }
    drag = null;
    syncFromState();
  });

  window.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.kind === 'brake') {
      finishBrakeDrag();
    } else if (drag.kind === 'throttle') {
      Drive.snapThrottle();
    }
    drag = null;
    syncFromState();
  });

  /** 松手：半程以上吸附急刹并回弹，否则回松开。 */
  function finishBrakeDrag() {
    const raw = Drive.getState().brake;
    const threshold = Drive.BRAKE_SNAP_THRESHOLD ?? 0.5;
    if (raw >= threshold) {
      Drive.setBrake(1, { fromUser: true });
      Drive.onBrakeReleased();
    } else {
      Drive.setBrake(0, { fromUser: true });
    }
  }

  closeButton?.addEventListener('click', closePanel);
  root.querySelector('.lp-boiler-backdrop')?.addEventListener('click', closePanel);

  for (const mark of root.querySelectorAll('[data-throttle-notch]')) {
    mark.addEventListener('click', () => {
      Drive.setThrottle(Number(mark.dataset.throttleNotch));
      syncFromState();
    });
  }
  for (const mark of root.querySelectorAll('[data-brake-preset]')) {
    mark.addEventListener('click', () => {
      const value = Number(mark.dataset.brakePreset);
      if (value >= (Drive.EMERGENCY_BRAKE ?? 0.95)) {
        Drive.triggerEmergencyBrake();
      } else {
        Drive.setBrake(value, { fromUser: true });
      }
      syncFromState();
    });
  }

  window.addEventListener('liminal:train-drive', syncFromState);
  window.addEventListener('liminal:fuel-changed', () => {
    syncFuelGauge();
  });
  window.addEventListener('lp:bindings-changed', syncLeaveHint);

  /** 同步锅炉燃料玻璃管与读数。 */
  function syncFuelGauge() {
    const level = window.LiminalInteract?.getFuelLevel?.() ?? 0;
    const label = document.getElementById('lpBoilerFuelReadout');
    if (label) label.textContent = `${Math.round(level)}/100`;
    if (fuelFill) fuelFill.style.height = `${Math.max(0, Math.min(100, level))}%`;
  }

  window.LpBoilerPanel = {
    open: openPanel,
    close: closePanel,
    toggle,
    isOpen,
    syncFromState,
  };

  const initial = Drive.getState();
  uiThrottle = initial.throttle;
  uiBrake = initial.brake;
  syncFromState();
  syncFuelGauge();
  paintWhistle();
})();
