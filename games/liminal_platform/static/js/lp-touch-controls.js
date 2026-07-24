/**
 * 阈限月台移动端触控：左移摇杆 + 奔跑键；右瞄准摇杆 + 物品/交互情境键 + 开火/跳跃。
 * 瞄准采用双摇杆（类合金弹头）：方向 + 把手离中心距离（mag）驱动准星；松手保持最后方向与距离。
 */
(() => {
  const controls = document.getElementById('lpMobileControls');
  const joystick = document.getElementById('lpMoveJoystick');
  const knob = document.getElementById('lpMoveJoystickKnob');
  const lookStick = document.getElementById('lpLookJoystick');
  const lookKnob = document.getElementById('lpLookJoystickKnob');
  const jumpButton = document.getElementById('lpMobileJumpButton');
  const fireButton = document.getElementById('lpMobileFireButton');
  const actionButton = document.getElementById('lpMobileInventoryButton');
  const sprintButton = document.getElementById('lpMobileSprintButton');
  if (!controls || !joystick || !knob || !jumpButton) return;

  /** 瞄准摇杆死区（归一化半径 0–1）；进入死区不改方向/距离。 */
  const LOOK_DEADZONE = 0.18;

  const state = {
    direction: 0,
    jump: false,
    jumpQueued: false,
    interact: false,
    interactQueued: false,
    fire: false,
    fireQueued: false,
    /** 奔跑锁定（点按切换）。 */
    sprintToggle: Boolean(window.LpInputBindings?.getAutoRun?.()),
    /** 情境键：inventory | interact */
    actionMode: 'inventory',
    lookX: 0,
    lookY: 0,
    /** 死区外把手距离 → 0–1（满推为 1），映射准星领先距离。 */
    lookMag: 0,
    lookActive: false,
    lookReady: false,
    enabled: true,
  };
  let joystickPointer = null;
  let lookPointer = null;
  let jumpPointer = null;
  let firePointer = null;
  let storageHint = false;

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

  /**
   * 根据触点更新瞄准摇杆：单位方向 + 死区重映射后的距离（0–1）。
   * 死区内仅保持按住态，不改 lookX/Y/mag（松手后仍保留上次瞄准）。
   */
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
    state.lookActive = true;
    if (mag < LOOK_DEADZONE) return;
    const remapped = Math.min(1, (mag - LOOK_DEADZONE) / (1 - LOOK_DEADZONE));
    state.lookX = nx / mag;
    state.lookY = ny / mag;
    state.lookMag = remapped;
    state.lookReady = true;
  }

  /** 同步奔跑切换按钮（图标 + aria；文案不写进 DOM 以免冲掉 Kenney 图标）。 */
  function syncSprintButton() {
    if (!sprintButton) return;
    sprintButton.setAttribute('aria-pressed', state.sprintToggle ? 'true' : 'false');
    sprintButton.classList.toggle('is-sprint-on', state.sprintToggle);
    sprintButton.title = state.sprintToggle
      ? '当前奔跑 · 点按改为行走'
      : '当前行走 · 点按改为奔跑';
    sprintButton.setAttribute(
      'aria-label',
      state.sprintToggle ? '切换为行走' : '切换为奔跑'
    );
  }

  /** 同步物品/交互共用键外观。 */
  function syncActionButton() {
    if (!actionButton) return;
    const interact = state.actionMode === 'interact';
    actionButton.dataset.mode = state.actionMode;
    actionButton.classList.toggle('is-interact-mode', interact);
    actionButton.classList.toggle('is-storage-hint', !interact && storageHint);
    if (interact) {
      const label = actionButton.dataset.interactLabel || '交互';
      actionButton.title = label;
      actionButton.setAttribute('aria-label', label);
    } else {
      actionButton.title = storageHint ? '打开物品栏（仓库）' : '打开物品栏';
      actionButton.setAttribute('aria-label', '物品栏');
    }
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
    actionButton?.classList.remove('is-active');
  }

  /** 加载失败或全屏面板是否挡住触控。 */
  function isUiBlockingInput() {
    const err = document.getElementById('lpLoadError');
    if (err && !err.hidden) return true;
    if (window.LpInventory?.isOpen()) return true;
    if (window.LpBoilerPanel?.isOpen()) return true;
    if (window.LpFuelFeed?.isOpen()) return true;
    if (window.LpGuardCrateUi?.isOpen()) return true;
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

  /**
   * 靠近交互点时，物品键切换为交互；离开后恢复物品栏。
   */
  function setInteractVisible(visible, label) {
    if (!actionButton) return;
    if (visible) {
      state.actionMode = 'interact';
      if (label) actionButton.dataset.interactLabel = label;
    } else {
      state.actionMode = 'inventory';
      state.interact = false;
      state.interactQueued = false;
      actionButton.classList.remove('is-active');
      delete actionButton.dataset.interactLabel;
    }
    syncActionButton();
  }

  if (actionButton) {
    actionButton.addEventListener('pointerdown', (event) => {
      if (!state.enabled) return;
      actionButton.classList.add('is-active');
      if (state.actionMode === 'interact') {
        state.interact = true;
        state.interactQueued = true;
        window.dispatchEvent(new CustomEvent('lp:interact'));
      } else {
        window.dispatchEvent(new CustomEvent('lp:inventory-toggle'));
      }
      actionButton.setPointerCapture(event.pointerId);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      actionButton.addEventListener(eventName, () => {
        state.interact = false;
        actionButton.classList.remove('is-active');
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

  /** 仓储车厢提示：物品模式下高亮情境键。 */
  function setStorageHint(active) {
    storageHint = Boolean(active);
    syncActionButton();
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
          look: { x: 0, y: 0, mag: 0, active: false, ready: false },
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
          mag: state.lookMag,
          active: state.lookActive,
          ready: state.lookReady,
        },
      };
      state.jumpQueued = false;
      state.interactQueued = false;
      state.fireQueued = false;
      return input;
    },
    /** 当前瞄准摇杆：单位方向 (x,y) + 距离 mag(0–1) + active/ready。 */
    getLook() {
      if (!state.enabled) return { x: 0, y: 0, mag: 0, active: false, ready: false };
      return {
        x: state.lookX,
        y: state.lookY,
        mag: state.lookMag,
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
  syncActionButton();
  setEnabled(!isUiBlockingInput());
})();
