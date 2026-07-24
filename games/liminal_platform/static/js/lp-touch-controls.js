/**
 * 阈限月台移动端触控：左下背包+移摇杆；右上跑走+手部栏；右下瞄准/地图/开火/跳跃。
 * 瞄准采用双摇杆（类合金弹头）：方向 + 把手离中心距离（mag）驱动准星；松手保持最后方向与距离。
 * 入座机炮：左摇杆改瞄准，右侧只留开火；「离开」情境键留在左侧簇。
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
  const moveCluster = controls?.querySelector('.lp-mobile-move-cluster');
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
    /** 奔跑锁定（点按 / 桌面 Shift 边沿切换；进房时跟自动奔跑偏好）。 */
    sprintToggle: false,
    /** 情境键：inventory | interact */
    actionMode: 'inventory',
    lookX: 0,
    lookY: 0,
    /** 死区外把手距离 → 0–1（满推为 1），映射准星领先距离。 */
    lookMag: 0,
    lookActive: false,
    lookReady: false,
    /** 入座机炮：左摇杆瞄准、右侧仅开火。 */
    turretMode: false,
    enabled: true,
  };
  let joystickPointer = null;
  let lookPointer = null;
  let jumpPointer = null;
  let firePointer = null;
  let storageHint = false;

  /** 阻止长按选中 / iOS 呼出菜单（摇杆与触控键）。 */
  function suppressSelect(event) {
    event.preventDefault();
  }

  /** 重置移动摇杆到中心（非炮塔模式）。 */
  function resetMoveJoystick() {
    joystickPointer = null;
    state.direction = 0;
    knob.style.transform = 'translate(0, 0)';
    joystick.setAttribute('aria-valuenow', '0');
  }

  /** 仅复位瞄准把手外观，不清除已锁定的瞄准方向。 */
  function resetLookKnobVisual(targetKnob) {
    if (targetKnob) targetKnob.style.transform = 'translate(0, 0)';
  }

  /** 松手后复位右瞄准摇杆外观。 */
  function resetLookKnob() {
    lookPointer = null;
    state.lookActive = false;
    resetLookKnobVisual(lookKnob);
  }

  /**
   * 松开左侧摇杆：步行模式清方向；炮塔模式只复位把手，保留准星方向/距离。
   */
  function releaseLeftStick() {
    if (state.turretMode) {
      joystickPointer = null;
      state.lookActive = false;
      resetLookKnobVisual(knob);
      return;
    }
    resetMoveJoystick();
  }

  /** 根据触点更新移动摇杆（水平方向）。 */
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
   * 将触点写入瞄准状态（单位方向 + 死区重映射距离 0–1）。
   * stickEl/knobEl 可为左或右摇杆；死区内仅保持按住态。
   */
  function applyLookFromStick(stickEl, knobEl, clientX, clientY) {
    if (!stickEl || !knobEl) return;
    const rect = stickEl.getBoundingClientRect();
    const radius = rect.width * 0.34;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = (dx / distance) * radius;
      dy = (dy / distance) * radius;
    }
    knobEl.style.transform = `translate(${dx}px, ${dy}px)`;

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

  /** 右瞄准摇杆更新（非炮塔）。 */
  function updateLookJoystick(clientX, clientY) {
    applyLookFromStick(lookStick, lookKnob, clientX, clientY);
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

  /** 将奔跑锁定设为指定状态（进房 / 自动奔跑偏好 / 桌面 Shift 共用）。 */
  function setSprintToggle(on) {
    state.sprintToggle = Boolean(on);
    syncSprintButton();
  }

  /** 切换奔跑锁定并刷新按钮。 */
  function toggleSprint() {
    setSprintToggle(!state.sprintToggle);
  }

  /** 按自动奔跑偏好重置锁定：开=进房即跑，关=进房行走。 */
  function applyAutoRunPreference() {
    setSprintToggle(Boolean(window.LpInputBindings?.getAutoRun?.()));
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
      actionButton.title = storageHint ? '打开背包（仓库）' : '打开背包';
      actionButton.setAttribute('aria-label', '背包');
    }
  }

  /**
   * 入座/离席机炮时切换触控布局：左摇杆瞄准、右侧仅开火；背包键改「离开」（已在左侧）。
   */
  function setTurretMode(active) {
    const next = Boolean(active);
    if (state.turretMode === next) {
      controls.classList.toggle('is-turret-mode', next);
      return;
    }
    state.turretMode = next;
    controls.classList.toggle('is-turret-mode', next);

    joystickPointer = null;
    lookPointer = null;
    state.direction = 0;
    state.lookActive = false;
    resetLookKnobVisual(knob);
    resetLookKnobVisual(lookKnob);
    joystick.setAttribute('aria-valuenow', '0');
    joystick.setAttribute('aria-label', next ? '瞄准' : '水平移动');

    /* 背包键默认在左簇；炮塔时确保仍在左侧并切成离开 */
    if (actionButton && moveCluster && actionButton.parentElement !== moveCluster) {
      moveCluster.insertBefore(actionButton, joystick);
    }
    if (next) {
      setInteractVisible(true, '离开');
    } else {
      setInteractVisible(false);
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

  controls.addEventListener('selectstart', suppressSelect);

  joystick.addEventListener('pointerdown', (event) => {
    if (!state.enabled || joystickPointer !== null) return;
    suppressSelect(event);
    joystickPointer = event.pointerId;
    if (state.turretMode) {
      applyLookFromStick(joystick, knob, event.clientX, event.clientY);
    } else {
      updateMoveJoystick(event.clientX, event.clientY);
    }
    joystick.setPointerCapture(event.pointerId);
  });

  joystick.addEventListener('pointermove', (event) => {
    if (event.pointerId !== joystickPointer) return;
    if (state.turretMode) {
      applyLookFromStick(joystick, knob, event.clientX, event.clientY);
    } else {
      updateMoveJoystick(event.clientX, event.clientY);
    }
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    joystick.addEventListener(eventName, (event) => {
      if (event.pointerId === joystickPointer) releaseLeftStick();
    });
  }

  if (lookStick && lookKnob) {
    lookStick.addEventListener('pointerdown', (event) => {
      if (!state.enabled || state.turretMode || lookPointer !== null) return;
      suppressSelect(event);
      lookPointer = event.pointerId;
      updateLookJoystick(event.clientX, event.clientY);
      lookStick.setPointerCapture(event.pointerId);
    });
    lookStick.addEventListener('pointermove', (event) => {
      if (state.turretMode) return;
      if (event.pointerId === lookPointer) updateLookJoystick(event.clientX, event.clientY);
    });
    for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      lookStick.addEventListener(eventName, (event) => {
        if (event.pointerId === lookPointer) resetLookKnob();
      });
    }
  }

  jumpButton.addEventListener('pointerdown', (event) => {
    if (!state.enabled || state.turretMode) return;
    suppressSelect(event);
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
      suppressSelect(event);
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
   * 炮塔模式强制「离开」，避免 mid-session 被改回物品栏。
   */
  function setInteractVisible(visible, label) {
    if (!actionButton) return;
    if (state.turretMode) {
      visible = true;
      label = label || '离开';
    }
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
      suppressSelect(event);
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
      if (!state.enabled || state.turretMode) return;
      suppressSelect(event);
      toggleSprint();
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

  /** 与 body.lp-turret-mode / 进出事件对齐触控布局。 */
  function syncTurretModeFromDom() {
    setTurretMode(document.body.classList.contains('lp-turret-mode'));
  }

  window.addEventListener('lp:turret-enter', () => setTurretMode(true));
  window.addEventListener('lp:turret-exit', () => setTurretMode(false));
  window.addEventListener('lp:settings-changed', () => {
    applyAutoRunPreference();
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
        direction: state.turretMode ? 0 : state.direction,
        jump: state.turretMode ? false : state.jump || state.jumpQueued,
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
    setSprintToggle,
    toggleSprint,
    applyAutoRunPreference,
    setEnabled,
    setInteractVisible,
    setStorageHint,
    setTurretMode,
  };

  applyAutoRunPreference();
  syncActionButton();
  syncTurretModeFromDom();
  setEnabled(!isUiBlockingInput());
})();
