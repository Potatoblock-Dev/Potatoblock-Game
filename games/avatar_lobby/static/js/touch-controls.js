/**
 * 移动端触控：左侧虚拟摇杆 + 右侧跳跃按钮。
 * 对外只暴露动作状态，角色控制器无需感知 PointerEvent 细节。
 */
(() => {
  const controls = document.getElementById('mobileControls');
  const joystick = document.getElementById('moveJoystick');
  const knob = document.getElementById('moveJoystickKnob');
  const jumpButton = document.getElementById('mobileJumpButton');
  const kneelButton = document.getElementById('mobileKneelButton');
  const state = {
    direction: 0,
    jump: false,
    jumpQueued: false,
    kneel: false,
    enabled: true,
  };
  let joystickPointer = null;
  let jumpPointer = null;
  let kneelPointer = null;

  function resetJoystick() {
    joystickPointer = null;
    state.direction = 0;
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
    state.direction = dx < -radius * 0.28 ? -1 : dx > radius * 0.28 ? 1 : 0;
    joystick.setAttribute('aria-valuenow', String(state.direction));
  }

  function setEnabled(enabled) {
    state.enabled = enabled;
    controls.classList.toggle('is-disabled', !enabled);
    resetJoystick();
    jumpPointer = null;
    kneelPointer = null;
    state.jump = false;
    state.jumpQueued = false;
    state.kneel = false;
    jumpButton.classList.remove('is-active');
    kneelButton.classList.remove('is-active');
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

  kneelButton.addEventListener('pointerdown', (event) => {
    if (!state.enabled || kneelPointer !== null) return;
    kneelPointer = event.pointerId;
    state.kneel = true;
    kneelButton.classList.add('is-active');
    kneelButton.setPointerCapture(event.pointerId);
  });

  for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    kneelButton.addEventListener(eventName, (event) => {
      if (event.pointerId !== kneelPointer) return;
      kneelPointer = null;
      state.kneel = false;
      kneelButton.classList.remove('is-active');
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
      if (!state.enabled) return { direction: 0, jump: false, kneel: false };
      const input = {
        direction: state.direction,
        jump: state.jump || state.jumpQueued,
        kneel: state.kneel,
      };
      state.jumpQueued = false;
      return input;
    },
  };

  setEnabled(!isUiBlockingInput());
})();
