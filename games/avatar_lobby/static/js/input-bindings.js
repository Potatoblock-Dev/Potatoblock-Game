/**
 * 键位设置：每个动作最多两个绑定，每个绑定可以是单键或修饰键组合。
 */
(() => {
  const STORAGE_KEY = 'avatar-lobby-input-bindings-v5';
  const LEGACY_V4_STORAGE_KEY = 'avatar-lobby-input-bindings-v4';
  const LEGACY_V3_STORAGE_KEY = 'avatar-lobby-input-bindings-v3';
  const LEGACY_V2_STORAGE_KEY = 'avatar-lobby-input-bindings-v2';
  const LEGACY_V1_STORAGE_KEY = 'avatar-lobby-input-bindings-v1';
  const DEFAULT_BINDINGS = {
    left: [['KeyA'], ['ArrowLeft']],
    right: [['KeyD'], ['ArrowRight']],
    jump: [['Space'], []],
    kneel: [['KeyS'], ['ArrowDown']],
    interact: [['KeyF'], []],
  };
  const ACTION_NAMES = {
    left: '向左移动',
    right: '向右移动',
    jump: '跳跃',
    kneel: '单膝跪地',
    interact: '交互',
  };
  const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight',
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
  ]);

  let bindings = loadBindings();
  let captureTarget = null;
  const capturedModifiers = new Set();

  function cloneBindings(source) {
    return Object.fromEntries(
      Object.entries(source).map(([action, slots]) => [
        action,
        slots.map((codes) => [...codes]),
      ])
    );
  }

  function isValidBindings(value) {
    return Object.keys(DEFAULT_BINDINGS).every((action) =>
      Array.isArray(value[action]) &&
      value[action].length === 2 &&
      value[action].every((codes) =>
        Array.isArray(codes) && codes.every((code) => typeof code === 'string')
      )
    );
  }

  function migrateV4Bindings() {
    const saved = localStorage.getItem(LEGACY_V4_STORAGE_KEY);
    if (!saved) return null;
    try {
      const legacy = JSON.parse(saved);
      if (!isValidBindings(legacy)) return null;
      const migrated = cloneBindings(legacy);
      migrated.interact = cloneBindings(DEFAULT_BINDINGS).interact;
      return migrated;
    } catch {
      return null;
    }
  }

  function migrateV3Bindings() {
    const saved = localStorage.getItem(LEGACY_V3_STORAGE_KEY);
    if (!saved) return null;
    try {
      const legacy = JSON.parse(saved);
      const migrated = cloneBindings(DEFAULT_BINDINGS);
      for (const action of ['left', 'right', 'jump']) {
        if (!Array.isArray(legacy[action]) || legacy[action].length !== 2) return null;
        migrated[action] = legacy[action].map((codes) => [...codes]);
      }
      if (Array.isArray(legacy.crouch) && legacy.crouch.length === 2) {
        migrated.kneel = legacy.crouch.map((codes) => [...codes]);
      }
      return migrated;
    } catch {
      return null;
    }
  }

  function migrateV2Bindings() {
    const saved = localStorage.getItem(LEGACY_V2_STORAGE_KEY);
    if (!saved) return null;
    try {
      const legacy = JSON.parse(saved);
      const migrated = cloneBindings(DEFAULT_BINDINGS);
      for (const action of ['left', 'right', 'jump']) {
        if (!Array.isArray(legacy[action]) || legacy[action].length !== 2) return null;
        migrated[action] = legacy[action].map((codes) => [...codes]);
      }
      return migrated;
    } catch {
      return null;
    }
  }

  function migrateV1Bindings() {
    const saved = localStorage.getItem(LEGACY_V1_STORAGE_KEY);
    if (!saved) return null;
    try {
      const legacy = JSON.parse(saved);
      const migrated = cloneBindings(DEFAULT_BINDINGS);
      for (const action of ['left', 'right', 'jump']) {
        if (!Array.isArray(legacy[action])) return null;
        migrated[action] = legacy[action].slice(0, 2).map((code) => [code]);
        while (migrated[action].length < 2) migrated[action].push([]);
      }
      return migrated;
    } catch {
      return null;
    }
  }

  function loadBindings() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (isValidBindings(parsed)) return parsed;
      } catch {
        // 损坏的本地配置回退到迁移或默认值。
      }
    }
    return migrateV4Bindings() || migrateV3Bindings() || migrateV2Bindings() || migrateV1Bindings()
      || cloneBindings(DEFAULT_BINDINGS);
  }

  function formatKey(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const labels = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      Space: '空格',
      ShiftLeft: '左 Shift',
      ShiftRight: '右 Shift',
      ControlLeft: '左 Ctrl',
      ControlRight: '右 Ctrl',
      AltLeft: '左 Alt',
      AltRight: '右 Alt',
    };
    return labels[code] || code;
  }

  function formatBinding(codes) {
    return codes.length === 0 ? '添加' : codes.map(formatKey).join(' + ');
  }

  function formatAction(action) {
    return bindings[action]
      .filter((codes) => codes.length > 0)
      .map(formatBinding)
      .join(' / ');
  }

  function isCapturing(action, slot) {
    return captureTarget?.action === action && captureTarget.slot === slot;
  }

  function renderBindings() {
    for (const button of document.querySelectorAll('[data-binding-action]')) {
      const action = button.dataset.bindingAction;
      const slot = Number(button.dataset.bindingSlot);
      const capturing = isCapturing(action, slot);
      const modifierText = [...capturedModifiers].map(formatKey).join(' + ');
      button.textContent = capturing
        ? (modifierText ? `${modifierText} + …` : '请按按键…')
        : formatBinding(bindings[action][slot]);
      button.classList.toggle('is-capturing', capturing);
      button.classList.toggle('is-empty', bindings[action][slot].length === 0);
    }
    document.getElementById('controlHint').textContent =
      `${formatAction('left')} 向左，${formatAction('right')} 向右，` +
      `${formatAction('jump')} 跳跃，${formatAction('kneel')} 单膝跪地，` +
      `${formatAction('interact')} 交互，Enter 说话`;
  }

  function beginCapture(action, slot) {
    captureTarget = { action, slot };
    capturedModifiers.clear();
    document.getElementById('bindingStatus').textContent =
      '按下单键或修饰键组合；Delete 清除，Esc 取消';
    renderBindings();
  }

  function bindingsOverlap(first, second) {
    if (first.length === 0 || second.length === 0) return false;
    const firstContainsSecond = second.every((code) => first.includes(code));
    const secondContainsFirst = first.every((code) => second.includes(code));
    return firstContainsSecond || secondContainsFirst;
  }

  function findConflict(candidate) {
    for (const [action, slots] of Object.entries(bindings)) {
      for (let slot = 0; slot < slots.length; slot += 1) {
        if (action === captureTarget.action && slot === captureTarget.slot) continue;
        if (bindingsOverlap(candidate, slots[slot])) return { action, slot };
      }
    }
    return null;
  }

  function finishCapture(message) {
    captureTarget = null;
    capturedModifiers.clear();
    document.getElementById('bindingStatus').textContent = message;
    renderBindings();
  }

  function saveBindings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
  }

  function captureKeyDown(event) {
    if (captureTarget === null) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.code === 'Escape') {
      finishCapture('已取消修改');
      return;
    }
    if (event.code === 'Delete' || event.code === 'Backspace') {
      bindings[captureTarget.action][captureTarget.slot] = [];
      saveBindings();
      finishCapture('已清除键位');
      return;
    }
    if (event.code === 'MetaLeft' || event.code === 'MetaRight') {
      document.getElementById('bindingStatus').textContent = '系统 Command 键不可绑定';
      return;
    }
    if (MODIFIER_CODES.has(event.code)) {
      capturedModifiers.add(event.code);
      renderBindings();
      return;
    }

    const candidate = [...capturedModifiers, event.code];
    const conflict = findConflict(candidate);
    if (conflict) {
      document.getElementById('bindingStatus').textContent =
        `${formatBinding(candidate)} 与${ACTION_NAMES[conflict.action]}的现有键位冲突`;
      return;
    }
    bindings[captureTarget.action][captureTarget.slot] = candidate;
    saveBindings();
    finishCapture('键位已保存');
  }

  function captureKeyUp(event) {
    if (captureTarget === null || !MODIFIER_CODES.has(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    capturedModifiers.delete(event.code);
    renderBindings();
  }

  function resetBindings() {
    bindings = cloneBindings(DEFAULT_BINDINGS);
    saveBindings();
    finishCapture('已恢复默认键位');
  }

  for (const button of document.querySelectorAll('[data-binding-action]')) {
    button.addEventListener('click', () => {
      beginCapture(button.dataset.bindingAction, Number(button.dataset.bindingSlot));
    });
  }
  document.getElementById('resetBindingsButton').addEventListener('click', resetBindings);
  window.addEventListener('keydown', captureKeyDown, true);
  window.addEventListener('keyup', captureKeyUp, true);

  window.InputBindings = {
    isPressed(action, pressedCodes) {
      return bindings[action].some(
        (codes) => codes.length > 0 && codes.every((code) => pressedCodes.has(code))
      );
    },
    formatAction(action) {
      return formatAction(action);
    },
  };

  renderBindings();
})();
