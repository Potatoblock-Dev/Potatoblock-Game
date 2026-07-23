/**
 * 阈限月台键位与移动偏好：物品栏、交互、开火、奔跑；支持自动奔跑。
 */
(() => {
  const STORAGE_KEY = 'liminal-platform-input-bindings-v5';
  const LEGACY_STORAGE_KEYS = [
    'liminal-platform-input-bindings-v4',
    'liminal-platform-input-bindings-v3',
    'liminal-platform-input-bindings-v2',
    'liminal-platform-input-bindings-v1',
  ];
  const SETTINGS_KEY = 'liminal-platform-game-settings-v1';
  const DEFAULT_BINDINGS = {
    inventory: [['Tab'], []],
    interact: [['KeyF'], []],
    fire: [['KeyJ'], []],
    reload: [['KeyR'], []],
    sprint: [['ShiftLeft'], ['ShiftRight']],
    handsHud: [['KeyX'], []],
  };
  const ACTION_NAMES = {
    inventory: '物品栏',
    interact: '交互',
    fire: '开火',
    reload: '装填',
    sprint: '奔跑',
    handsHud: '切换手部',
  };
  const DEFAULT_SETTINGS = {
    autoRun: false,
  };
  const MODIFIER_CODES = new Set([
    'ShiftLeft', 'ShiftRight',
    'ControlLeft', 'ControlRight',
    'AltLeft', 'AltRight',
  ]);

  let bindings = loadBindings();
  let settings = loadSettings();
  let captureTarget = null;
  const capturedModifiers = new Set();
  let settingsMounted = false;

  /** 深拷贝绑定表。 */
  function cloneBindings(source) {
    return Object.fromEntries(
      Object.entries(source).map(([action, slots]) => [
        action,
        slots.map((codes) => [...codes]),
      ])
    );
  }

  /** 从 localStorage 读取绑定（合并新增动作）。 */
  function loadBindings() {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const key of LEGACY_STORAGE_KEYS) {
        raw = localStorage.getItem(key);
        if (raw) break;
      }
    }
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const merged = cloneBindings(DEFAULT_BINDINGS);
        for (const action of Object.keys(DEFAULT_BINDINGS)) {
          if (
            Array.isArray(parsed[action]) &&
            parsed[action].length === 2 &&
            parsed[action].every(
              (codes) =>
                Array.isArray(codes) && codes.every((code) => typeof code === 'string')
            )
          ) {
            merged[action] = parsed[action].map((codes) => [...codes]);
          }
        }
        /* 旧默认 KeyE → 新默认 KeyX（仍为旧默认时才迁移） */
        const hh = merged.handsHud;
        if (
          hh?.[0]?.length === 1 &&
          hh[0][0] === 'KeyE' &&
          (!hh[1] || hh[1].length === 0)
        ) {
          hh[0] = ['KeyX'];
        }
        return merged;
      } catch {
        // 损坏配置回退默认。
      }
    }
    return cloneBindings(DEFAULT_BINDINGS);
  }

  /** 读取游戏设置。 */
  function loadSettings() {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
      const parsed = JSON.parse(raw);
      return {
        autoRun: Boolean(parsed.autoRun),
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** 保存设置。 */
  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent('lp:settings-changed', { detail: { ...settings } }));
  }

  /** 保存绑定。 */
  function saveBindings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    renderBindings();
    window.dispatchEvent(new CustomEvent('lp:bindings-changed'));
  }

  /** 格式化单键显示名。 */
  function formatKey(code) {
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    const labels = {
      Tab: 'Tab',
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      Space: '空格',
      ShiftLeft: 'Shift',
      ShiftRight: 'Shift',
      ControlLeft: 'Ctrl',
      ControlRight: 'Ctrl',
      AltLeft: 'Alt',
      AltRight: 'Alt',
    };
    return labels[code] || code;
  }

  /** 格式化一组按键。 */
  function formatBinding(codes) {
    return codes.length === 0 ? '添加' : codes.map(formatKey).join(' + ');
  }

  /** 格式化动作全部绑定。 */
  function formatAction(action) {
    return bindings[action]
      .filter((codes) => codes.length > 0)
      .map(formatBinding)
      .join(' / ');
  }

  /** 判断按键集合是否触发动作。 */
  function isPressed(action, pressedCodes) {
    return bindings[action].some(
      (codes) => codes.length > 0 && codes.every((code) => pressedCodes.has(code))
    );
  }

  /** 判断 keydown 事件是否匹配动作（含修饰键）。 */
  function matchesKeyEvent(action, event) {
    if (event.repeat) return false;
    for (const codes of bindings[action]) {
      if (codes.length === 0) continue;
      const mainCode = codes[codes.length - 1];
      const modifiers = codes.slice(0, -1);
      if (event.code !== mainCode) continue;
      const needsShift = modifiers.some((c) => c === 'ShiftLeft' || c === 'ShiftRight');
      const needsCtrl = modifiers.some((c) => c === 'ControlLeft' || c === 'ControlRight');
      const needsAlt = modifiers.some((c) => c === 'AltLeft' || c === 'AltRight');
      if (Boolean(event.shiftKey) !== needsShift) continue;
      if (Boolean(event.ctrlKey) !== needsCtrl) continue;
      if (Boolean(event.altKey) !== needsAlt) continue;
      return true;
    }
    return false;
  }

  /** 是否正在录制键位。 */
  function isCapturing(action, slot) {
    return captureTarget?.action === action && captureTarget.slot === slot;
  }

  /** 是否开启自动奔跑。 */
  function getAutoRun() {
    return Boolean(settings.autoRun);
  }

  /** 设置自动奔跑。 */
  function setAutoRun(value) {
    settings.autoRun = Boolean(value);
    saveSettings();
    syncAutoRunToggle();
  }

  /** 同步自动奔跑开关 UI。 */
  function syncAutoRunToggle() {
    const toggle = document.getElementById('lpAutoRunToggle');
    if (toggle) toggle.checked = settings.autoRun;
  }

  /** 渲染绑定按钮文案。 */
  function renderBindings() {
    for (const button of document.querySelectorAll('[data-lp-binding-action]')) {
      const action = button.dataset.lpBindingAction;
      const slot = Number(button.dataset.lpBindingSlot);
      if (!bindings[action]) continue;
      const capturing = isCapturing(action, slot);
      const modifierText = [...capturedModifiers].map(formatKey).join(' + ');
      button.textContent = capturing
        ? (modifierText ? `${modifierText} + …` : '请按按键…')
        : formatBinding(bindings[action][slot]);
      button.classList.toggle('is-capturing', capturing);
      button.classList.toggle('is-empty', bindings[action][slot].length === 0);
    }
    syncAutoRunToggle();
    const status = document.getElementById('lpBindingStatus');
    if (status && !captureTarget) {
      const sprintHint = settings.autoRun
        ? `${formatAction('sprint') || 'Shift'} 行走`
        : `${formatAction('sprint') || 'Shift'} 奔跑`;
      status.textContent =
        `${formatAction('inventory')} 物品栏 · ${formatAction('interact')} 交互 · ${formatAction('fire')} 开火 · ${formatAction('reload')} 装填 · ${sprintHint}`;
    }
    const hint = document.getElementById('lpInventoryHint');
    if (hint) {
      const coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches;
      hint.textContent = coarse
        ? '点按查看 · 拖拽到格子移动 · 点关闭退出'
        : `悬停弹出说明 · 拖拽移动 · Shift+点击快速转移 · ${formatAction('inventory')} 关闭`;
    }
  }

  /** 开始录制键位。 */
  function beginCapture(action, slot) {
    captureTarget = { action, slot };
    capturedModifiers.clear();
    const status = document.getElementById('lpBindingStatus');
    if (status) status.textContent = '按下单键或修饰键组合；松修饰键可单独绑定；Delete 清除，Esc 取消';
    renderBindings();
  }

  /** 结束录制。 */
  function finishCapture(message) {
    captureTarget = null;
    capturedModifiers.clear();
    const status = document.getElementById('lpBindingStatus');
    if (status) status.textContent = message;
    renderBindings();
  }

  /** 检测键位冲突。 */
  function findConflict(candidate) {
    for (const [action, slots] of Object.entries(bindings)) {
      for (let slot = 0; slot < slots.length; slot += 1) {
        if (action === captureTarget.action && slot === captureTarget.slot) continue;
        const existing = slots[slot];
        if (existing.length === 0 || candidate.length === 0) continue;
        const same = candidate.length === existing.length &&
          candidate.every((code, i) => code === existing[i]);
        if (same) return { action, slot };
      }
    }
    return null;
  }

  /** 尝试写入候选键位。 */
  function commitCandidate(candidate) {
    const conflict = findConflict(candidate);
    if (conflict) {
      const status = document.getElementById('lpBindingStatus');
      if (status) {
        status.textContent =
          `${formatBinding(candidate)} 与${ACTION_NAMES[conflict.action]}冲突`;
      }
      return false;
    }
    bindings[captureTarget.action][captureTarget.slot] = candidate;
    saveBindings();
    finishCapture('键位已保存');
    return true;
  }

  /** 录制 keydown。 */
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
    if (event.code === 'MetaLeft' || event.code === 'MetaRight') return;
    if (MODIFIER_CODES.has(event.code)) {
      capturedModifiers.add(event.code);
      renderBindings();
      return;
    }

    const candidate = [...capturedModifiers, event.code];
    commitCandidate(candidate);
  }

  /** 录制 keyup：仅修饰键时松手即可单独绑定。 */
  function captureKeyUp(event) {
    if (captureTarget === null || !MODIFIER_CODES.has(event.code)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (capturedModifiers.has(event.code) && capturedModifiers.size === 1) {
      commitCandidate([event.code]);
      return;
    }
    capturedModifiers.delete(event.code);
    renderBindings();
  }

  /** 恢复默认键位与设置。 */
  function resetBindings() {
    bindings = cloneBindings(DEFAULT_BINDINGS);
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    saveBindings();
    finishCapture('已恢复默认键位与设置');
  }

  /** 挂载键位设置 UI 事件。 */
  function mountSettings() {
    if (settingsMounted) {
      renderBindings();
      return;
    }
    settingsMounted = true;
    for (const button of document.querySelectorAll('[data-lp-binding-action]')) {
      button.addEventListener('click', () => {
        beginCapture(button.dataset.lpBindingAction, Number(button.dataset.lpBindingSlot));
      });
    }
    const resetButton = document.getElementById('lpResetBindingsButton');
    resetButton?.addEventListener('click', resetBindings);
    const autoRunToggle = document.getElementById('lpAutoRunToggle');
    autoRunToggle?.addEventListener('change', () => {
      setAutoRun(autoRunToggle.checked);
      renderBindings();
    });
    window.addEventListener('keydown', captureKeyDown, true);
    window.addEventListener('keyup', captureKeyUp, true);
    renderBindings();
  }

  window.LpInputBindings = {
    isPressed,
    matchesKeyEvent,
    formatAction,
    formatKey,
    getAutoRun,
    setAutoRun,
    mountSettings,
    renderBindings,
  };

  document.addEventListener('DOMContentLoaded', mountSettings);
  if (document.readyState !== 'loading') mountSettings();
})();
