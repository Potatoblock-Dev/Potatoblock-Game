/**
 * 动力车驾驶台：节流阀 + 制动阀（嵌入式机柜 UI）。
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

  if (!root || !throttleTrack || !brakeTrack) return;

  const Drive = window.LpTrainDrive;
  const SPEED_DISPLAY_MAX = 120;
  let open = false;
  let drag = null;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 打开驾驶台。 */
  function openPanel() {
    if (open) return;
    if (window.LpInventory?.isOpen()) window.LpInventory.close();
    if (window.LpFuelFeed?.isOpen()) window.LpFuelFeed.close();
    open = true;
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-boiler-panel-open');
    window.LpTouchControls?.setEnabled(false);
    syncFromState();
    syncFuelGauge();
  }

  /** 关闭驾驶台。 */
  function closePanel() {
    if (!open) return;
    open = false;
    drag = null;
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

  /** 更新拉杆与读数 UI。 */
  function syncFromState() {
    const state = Drive.getState();
    const tRatio = throttleToRatio(state.throttle);
    const bRatio = state.brake;
    throttleKnob.style.top = `${tRatio * 100}%`;
    brakeKnob.style.top = `${bRatio * 100}%`;
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
      /* 表针：-120°（0）→ +120°（满速），支点在表盘底部中心。 */
      const angle = -120 + ratio * 240;
      speedNeedle.style.transform = `rotate(${angle}deg)`;
    }
  }

  /** 从指针位置写入拉杆。 */
  function applyPointer(track, clientY, kind) {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    if (kind === 'throttle') {
      Drive.setThrottleRaw(ratioToThrottle(ratio));
    } else {
      Drive.setBrake(ratio, { fromUser: true });
    }
    syncFromState();
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

  window.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const track = drag.kind === 'throttle' ? throttleTrack : brakeTrack;
    applyPointer(track, event.clientY, drag.kind);
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.kind === 'throttle') Drive.snapThrottle();
    if (drag.kind === 'brake') Drive.onBrakeReleased();
    drag = null;
    syncFromState();
  });

  window.addEventListener('pointercancel', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (drag.kind === 'brake') Drive.onBrakeReleased();
    drag = null;
    syncFromState();
  });

  closeButton?.addEventListener('click', closePanel);
  root.querySelector('.lp-boiler-backdrop')?.addEventListener('click', closePanel);

  // 档位刻度点击
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

  syncFromState();
  syncFuelGauge();
})();
