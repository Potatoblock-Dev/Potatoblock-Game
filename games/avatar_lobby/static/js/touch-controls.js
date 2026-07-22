/**
 * 移动端触控：左侧虚拟摇杆（左右走 + 下拉下蹲）+ 右侧交互 / 跳跃。
 * 对外只暴露动作状态，角色控制器无需感知 PointerEvent 细节。
 */
(() => {
  const controls = document.getElementById('mobileControls');
  const joystick = document.getElementById('moveJoystick');
  const knob = document.getElementById('moveJoystickKnob');
  const jumpButton = document.getElementById('mobileJumpButton');
  const interactButton = document.getElementById('mobileInteractButton');
  const state = {
    direction: 0,
    jump: false,
    jumpQueued: false,
    kneel: false,
    interactQueued: false,
    enabled: true,
  };
  let joystickPointer = null;
  let jumpPointer = null;
  let interactPointer = null;

  function resetJoystick() {
    joystickPointer = null;
    state.direction = 0;
    state.kneel = false;
    knob.style.transform = 'translate(0, 0)';
    joystick.setAttribute('aria-valuenow', '0');
  }

  function updateJoystick(clientX, clientY) {
    const rect = joystick.getBoundingClientRect();
    const radius = rect.width * 0.3;
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx = dx / distance * radius;
      dy = dy / distance * radius;
    }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const deadzone = radius * 0.28;
    state.direction = dx < -deadzone ? -1 : dx > deadzone ? 1 : 0;
    state.kneel = dy > deadzone;
    joystick.setAttribute('aria-valuenow', String(state.direction));
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    controls.classList.toggle('is-disabled', !enabled);
    resetJoystick();
    jumpPointer = null;
    interactPointer = null;
    state.jump = false;
    state.jumpQueued = false;
    state.interactQueued = false;
    jumpButton.classList.remove('is-active');
    interactButton.classList.remove('is-active');
  }

  function isUiBlockingInput() {
    const panelOpen = document.querySelector('.overlay-panel:not(.hidden)');
    const policyOpen = !document.getElementById('contentPolicyPrompt').classList.contains('hidden');
    const editorOpen = !document.getElementById('skinEditor').classList.contains('hidden');
    return Boolean(panelOpen) || policyOpen || editorOpen;
  }

  joystick.addEventListener('pointerdown', (event) => {
    if (!state.enabled || joystickPointer !== null) return;
    joystickPointer = event.pointerId;
    updateJoystick(event.clientX, event.clientY);
    joystick.setPointerCapture(event.pointerId);
  });

  joystick.addEventListener('pointermove', (event) => {
    if (event.pointerId === joystickPointer) updateJoystick(event.clientX, event.clientY);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    joystick.addEventListener(eventName, (event) => {
      if (event.pointerId === joystickPointer) resetJoystick();
    });
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

  interactButton.addEventListener('pointerdown', (event) => {
    if (!state.enabled || interactPointer !== null) return;
    interactPointer = event.pointerId;
    state.interactQueued = true;
    interactButton.classList.add('is-active');
    interactButton.setPointerCapture(event.pointerId);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    interactButton.addEventListener(eventName, (event) => {
      if (event.pointerId !== interactPointer) return;
      interactPointer = null;
      interactButton.classList.remove('is-active');
    });
  }

  window.addEventListener('stagepanelchange', () => {
    queueMicrotask(() => setEnabled(!isUiBlockingInput()));
  });
  window.addEventListener('contentpolicychange', () => setEnabled(!isUiBlockingInput()));
  window.addEventListener('blur', () => setEnabled(false));
  window.addEventListener('focus', () => setEnabled(!isUiBlockingInput()));

  window.TouchControls = {
    read() {
      if (!state.enabled) {
        return { direction: 0, jump: false, kneel: false, interact: false };
      }
      const input = {
        direction: state.direction,
        jump: state.jump || state.jumpQueued,
        kneel: state.kneel,
        interact: state.interactQueued,
      };
      state.jumpQueued = false;
      state.interactQueued = false;
      return input;
    },
  };

  setEnabled(!isUiBlockingInput());
})();
