/**
 * 阈限月台移动端触控：左移摇杆 + 右瞄准摇杆 + 跳跃 / 开火 / 交互。
 * 瞄准采用双摇杆（类合金弹头）：松手后保持最后瞄准方向。
 */
(() => {
  const controls = document.getElementById('lpMobileControls');
  const joystick = document.getElementById('lpMoveJoystick');
  const knob = document.getElementById('lpMoveJoystickKnob');
  const lookStick = document.getElementById('lpLookJoystick');
  const lookKnob = document.getElementById('lpLookJoystickKnob');
  const jumpButton = document.getElementById('lpMobileJumpButton');
  const fireButton = document.getElementById('lpMobileFireButton');
  const interactButton = document.getElementById('lpMobileInteractButton');
  const inventoryButton = document.getElementById('lpMobileInventoryButton');
  const sprintButton = document.getElementById('lpMobileSprintButton');
  if (!controls || !joystick || !knob || !jumpButton) return;

  const LOOK_DEADZONE = 0.18;

  const state = {
    direction: 0,
    jump: false,
    jumpQueued: false,
    interact: false,
    interactQueued: false,
    fire: false,
    fireQueued: false,
    /** 奔跑锁定（点按切换，类似 Minecraft 移动端）。 */
    sprintToggle: Boolean(window.LpInputBindings?.getAutoRun?.()),
    /** 归一化瞄准向量，松手后保留。 */
    lookX: 0,
    lookY: 0,
    lookActive: false,
    lookReady: false,
    enabled: true,
  };
  let joystickPointer = null;
  let lookPointer = null;
  let jumpPointer = null;
  let firePointer = null;

  /** 重置移动摇杆到中心。 */
  function resetMoveJoystick() {
    joystickPointer = null;
    state.direction = 0;
    knob.style.transform = 'translate(0, 0)';
    joystick.setAttribute('aria-valuenow', '0');
  }

  /** 仅复位瞄准摇杆外观，不清除已锁定的瞄准方向。 */
  function resetLookKnob() {
    lookPointer = null;
    state.lookActive = false;
    if (lookKnob) lookKnob.style.transform = 'translate(0, 0)';
  }

  /** 根据触点更新移动摇杆。 */
  function updateMoveJoystick(clientX, clientY) {
    const rect = joystick.getBoundingClientRect();
    const radius = rect.width * 0.3;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    state.direction = dx < -radius * 0.28 ? -1 : dx > radius * 0.28 ? 1 : 0;
    joystick.setAttribute('aria-valuenow', String(state.direction));
  }

  /** 根据触点更新瞄准摇杆（全方向）。 */
  function updateLookJoystick(clientX, clientY) {
    if (!lookStick || !lookKnob) return;
    const rect = lookStick.getBoundingClientRect();
    const radius = rect.width * 0.34;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    lookKnob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / radius;
    const ny = dy / radius;
    const mag = Math.hypot(nx, ny);
    if (mag < LOOK_DEADZONE) {
      state.lookActive = true;
      return;
    }
    state.lookX = nx / mag;
    state.lookY = ny / mag;
    state.lookActive = true;
    state.lookReady = true;
  }

  /** 同步奔跑切换按钮文案（仅文字提示，不高亮）。 */
  function syncSprintButton() {
    if (!sprintButton) return;
    sprintButton.setAttribute('aria-pressed', state.sprintToggle ? 'true' : 'false');
    sprintButton.textContent = state.sprintToggle ? '奔跑中' : '行走中';
    sprintButton.title = state.sprintToggle
      ? '当前奔跑 · 点按改为行走'
      : '当前行走 · 点按改为奔跑';
  }

  /** 启用/禁用触控（弹层打开时关闭）。 */
  function setEnabled(enabled) {
    state.enabled = enabled;
    controls.classList.toggle('is-disabled', !enabled);
    resetMoveJoystick();
    resetLookKnob();
    jumpPointer = null;
    firePointer = null;
    state.jump = false;
    state.jumpQueued = false;
    state.interact = false;
    state.interactQueued = false;
    state.fire = false;
    state.fireQueued = false;
    jumpButton.classList.remove('is-active');
    fireButton?.classList.remove('is-active');
    inventoryButton?.classList.remove('is-active');
    if (interactButton) interactButton.classList.remove('is-active');
  }

  /** 加载失败或全屏面板是否挡住触控。 */
  function isUiBlockingInput() {
    const err = document.getElementById('lpLoadError');
    if (err && !err.hidden) return true;
    if (window.LpInventory?.isOpen()) return true;
    if (window.LpBoilerPanel?.isOpen()) return true;
    if (window.LpFuelFeed?.isOpen()) return true;
    return false;
  }

  joystick.addEventListener('pointerdown', (event) => {
    if (!state.enabled || joystickPointer !== null) return;
    joystickPointer = event.pointerId;
    updateMoveJoystick(event.clientX, event.clientY);
    joystick.setPointerCapture(event.pointerId);
  });

  joystick.addEventListener('pointermove', (event) => {
    if (event.pointerId === joystickPointer) updateMoveJoystick(event.clientX, event.clientY);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    joystick.addEventListener(eventName, (event) => {
      if (event.pointerId === joystickPointer) resetMoveJoystick();
    });
  }

  if (lookStick && lookKnob) {
    lookStick.addEventListener('pointerdown', (event) => {
      if (!state.enabled || lookPointer !== null) return;
      lookPointer = event.pointerId;
      updateLookJoystick(event.clientX, event.clientY);
      lookStick.setPointerCapture(event.pointerId);
    });
    lookStick.addEventListener('pointermove', (event) => {
      if (event.pointerId === lookPointer) updateLookJoystick(event.clientX, event.clientY);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      lookStick.addEventListener(eventName, (event) => {
        if (event.pointerId === lookPointer) resetLookKnob();
      });
    }
  }

  jumpButton.addEventListener('pointerdown', (event) => {
    if (!state.enabled) return;
    jumpPointer = event.pointerId;
    state.jump = true;
    state.jumpQueued = true;
    jumpButton.classList.add('is-active');
    jumpButton.setPointerCapture(event.pointerId);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    jumpButton.addEventListener(eventName, (event) => {
      if (event.pointerId !== jumpPointer) return;
      jumpPointer = null;
      state.jump = false;
      jumpButton.classList.remove('is-active');
    });
  }

  if (fireButton) {
    fireButton.addEventListener('pointerdown', (event) => {
      if (!state.enabled) return;
      firePointer = event.pointerId;
      state.fire = true;
      state.fireQueued = true;
      fireButton.classList.add('is-active');
      window.dispatchEvent(new CustomEvent('lp:fire'));
      fireButton.setPointerCapture(event.pointerId);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      fireButton.addEventListener(eventName, (event) => {
        if (event.pointerId !== firePointer) return;
        firePointer = null;
        state.fire = false;
        fireButton.classList.remove('is-active');
      });
    }
  }

  /** 显示/隐藏移动端交互按钮，并更新文案（长标签用短名以免圆键溢出）。 */
  function setInteractVisible(visible, label) {
    if (!interactButton) return;
    interactButton.hidden = !visible;
    if (label) {
      const shortLabels = {
        添加燃料: '燃料',
        打开驾驶台: '驾驶台',
        打开控制台: '驾驶台',
      };
      interactButton.textContent = shortLabels[label] || label;
      interactButton.title = label;
      interactButton.setAttribute('aria-label', label);
    }
    if (!visible) {
      state.interact = false;
      state.interactQueued = false;
      interactButton.classList.remove('is-active');
      interactButton.removeAttribute('title');
    }
  }

  if (interactButton) {
    interactButton.hidden = true;
    interactButton.addEventListener('pointerdown', (event) => {
      if (!state.enabled || interactButton.hidden) return;
      state.interact = true;
      state.interactQueued = true;
      interactButton.classList.add('is-active');
      window.dispatchEvent(new CustomEvent('lp:interact'));
      interactButton.setPointerCapture(event.pointerId);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      interactButton.addEventListener(eventName, () => {
        state.interact = false;
        interactButton.classList.remove('is-active');
      });
    }
  }

  if (sprintButton) {
    sprintButton.addEventListener('pointerdown', (event) => {
      if (!state.enabled) return;
      event.preventDefault();
      state.sprintToggle = !state.sprintToggle;
      syncSprintButton();
      sprintButton.classList.add('is-active');
      sprintButton.setPointerCapture?.(event.pointerId);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      sprintButton.addEventListener(eventName, () => {
        sprintButton.classList.remove('is-active');
      });
    }
  }

  if (inventoryButton) {
    inventoryButton.addEventListener('pointerdown', (event) => {
      if (!state.enabled) return;
      inventoryButton.classList.add('is-active');
      window.dispatchEvent(new CustomEvent('lp:inventory-toggle'));
      inventoryButton.setPointerCapture(event.pointerId);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      inventoryButton.addEventListener(eventName, () => {
        inventoryButton.classList.remove('is-active');
      });
    }
  }

  /** 仓储车厢提示：高亮「物品」按钮。 */
  function setStorageHint(active) {
    inventoryButton?.classList.toggle('is-storage-hint', Boolean(active));
  }

  window.addEventListener('lp:settings-changed', () => {
    state.sprintToggle = Boolean(window.LpInputBindings?.getAutoRun?.());
    syncSprintButton();
  });

  window.addEventListener('blur', () => setEnabled(false));
  window.addEventListener('focus', () => setEnabled(!isUiBlockingInput()));

  window.LpTouchControls = {
    read() {
      if (!state.enabled) {
        return {
          direction: 0,
          jump: false,
          interact: false,
          fire: false,
          sprintToggle: state.sprintToggle,
          look: { x: 0, y: 0, active: false, ready: false },
        };
      }
      const input = {
        direction: state.direction,
        jump: state.jump || state.jumpQueued,
        interact: state.interact || state.interactQueued,
        fire: state.fire || state.fireQueued,
        sprintToggle: state.sprintToggle,
        look: {
          x: state.lookX,
          y: state.lookY,
          active: state.lookActive,
          ready: state.lookReady,
        },
      };
      state.jumpQueued = false;
      state.interactQueued = false;
      state.fireQueued = false;
      return input;
    },
    /** 只读瞄准（不消费开火队列）。 */
    getLook() {
      if (!state.enabled) return { x: 0, y: 0, active: false, ready: false };
      return {
        x: state.lookX,
        y: state.lookY,
        active: state.lookActive,
        ready: state.lookReady,
      };
    },
    isFireHeld() {
      return state.enabled && state.fire;
    },
    isSprintOn() {
      return state.sprintToggle;
    },
    setEnabled,
    setInteractVisible,
    setStorageHint,
  };

  syncSprintButton();
  setEnabled(!isUiBlockingInput());
})();
