/**
 * 电脑端无边框全屏：Fullscreen API 进入/退出，并同步 HUD 按钮文案与状态。
 * 快捷键 F11（部分浏览器会自行拦截，仍以按钮为准）；Esc 由浏览器退出。
 */
(() => {
  const SHORTCUT_CODE = 'F11';
  const button = document.getElementById('lpFullscreenButton');

  /** 当前全屏元素（含旧版 webkit 前缀）。 */
  function fullscreenElement() {
    return (
      document.fullscreenElement ||
      document.webkitFullscreenElement ||
      null
    );
  }

  /** 是否处于文档全屏。 */
  function isFullscreen() {
    return Boolean(fullscreenElement());
  }

  /** 请求根元素进入全屏。 */
  function enter() {
    const root = document.documentElement;
    if (typeof root.requestFullscreen === 'function') {
      return root.requestFullscreen();
    }
    if (typeof root.webkitRequestFullscreen === 'function') {
      return Promise.resolve(root.webkitRequestFullscreen());
    }
    return Promise.reject(new Error('Fullscreen API unavailable'));
  }

  /** 退出文档全屏。 */
  function exit() {
    if (typeof document.exitFullscreen === 'function') {
      return document.exitFullscreen();
    }
    if (typeof document.webkitExitFullscreen === 'function') {
      return Promise.resolve(document.webkitExitFullscreen());
    }
    return Promise.reject(new Error('Fullscreen API unavailable'));
  }

  /** 切换全屏；已全屏则退出。 */
  function toggle() {
    return isFullscreen() ? exit() : enter();
  }

  /** 按 fullscreenchange 刷新按钮文案、aria 与视觉状态。 */
  function syncButton() {
    if (!button) return;
    const active = isFullscreen();
    button.classList.toggle('is-fullscreen', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.setAttribute('aria-label', active ? '退出全屏' : '全屏');
    button.title = active ? '退出全屏 (Esc / F11)' : '全屏 (F11)';
    const longEl = button.querySelector('[data-lp-fs-text="long"]');
    const shortEl = button.querySelector('[data-lp-fs-text="short"]');
    if (longEl) longEl.textContent = active ? '退出全屏' : '全屏';
    if (shortEl) shortEl.textContent = active ? '退出' : '全屏';
  }

  /** 用户手势触发切换；忽略拒绝（如策略限制）。 */
  function onToggleGesture() {
    toggle().catch(() => {
      /* 浏览器拒绝或非安全上下文时保持当前 UI */
    });
  }

  /** 是否应忽略快捷键（输入框 / 可编辑区）。 */
  function isTypingTarget(target) {
    if (!(target instanceof Element)) return false;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return true;
    }
    if (target instanceof HTMLSelectElement) return true;
    if (target.isContentEditable) return true;
    return Boolean(target.closest('[contenteditable="true"]'));
  }

  button?.addEventListener('click', (event) => {
    event.preventDefault();
    onToggleGesture();
  });

  document.addEventListener('fullscreenchange', syncButton);
  document.addEventListener('webkitfullscreenchange', syncButton);

  window.addEventListener('keydown', (event) => {
    if (event.code !== SHORTCUT_CODE || event.repeat) return;
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    onToggleGesture();
  });

  syncButton();

  window.LpFullscreen = {
    isFullscreen,
    enter,
    exit,
    toggle,
  };
})();
