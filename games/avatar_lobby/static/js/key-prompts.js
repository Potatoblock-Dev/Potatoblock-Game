/**
 * Kenney Input Prompts Pixel（CC0）键位图标：映射 KeyboardEvent.code → PNG。
 * 显示须配合 CSS `image-rendering: pixelated`，避免缩放抗锯齿。
 */
(() => {
  const FILE_BY_CODE = {
    Tab: 'tab.png',
    Escape: 'esc.png',
    Space: 'space.png',
    Enter: 'enter.png',
    Backspace: 'backspace.png',
    Delete: 'del.png',
    Home: 'home.png',
    End: 'end.png',
    Insert: 'insert.png',
    ShiftLeft: 'shift.png',
    ShiftRight: 'shift.png',
    ControlLeft: 'ctrl.png',
    ControlRight: 'ctrl.png',
    AltLeft: 'alt.png',
    AltRight: 'alt.png',
    MetaLeft: 'command.png',
    MetaRight: 'command.png',
    ArrowUp: 'arrow_up.png',
    ArrowRight: 'arrow_right.png',
    ArrowDown: 'arrow_down.png',
    ArrowLeft: 'arrow_left.png',
  };

  for (let i = 0; i < 26; i += 1) {
    const letter = String.fromCharCode(65 + i);
    FILE_BY_CODE[`Key${letter}`] = `char_${letter.toLowerCase()}.png`;
  }
  for (let i = 0; i <= 9; i += 1) {
    FILE_BY_CODE[`Digit${i}`] = `num_${i}.png`;
  }
  for (let i = 1; i <= 12; i += 1) {
    FILE_BY_CODE[`F${i}`] = `f${i}.png`;
  }

  /**
   * @param {string} baseUrl 如 /static/games/liminal-platform/img/input-prompts
   * @param {string} code KeyboardEvent.code
   * @returns {string|null}
   */
  function srcForCode(baseUrl, code) {
    const file = FILE_BY_CODE[code];
    if (!file) return null;
    const root = baseUrl.replace(/\/$/, '');
    return `${root}/${file}`;
  }

  /**
   * 把绑定按钮内容换成像素键位图（组合键用 + 连接）。
   * @param {HTMLElement} button
   * @param {string[]} codes
   * @param {{ baseUrl: string, emptyLabel?: string, capturingLabel?: string }} options
   */
  function renderButton(button, codes, options) {
    const baseUrl = options.baseUrl;
    const emptyLabel = options.emptyLabel ?? '添加';
    button.replaceChildren();
    if (!codes.length) {
      button.textContent = emptyLabel;
      return;
    }
    codes.forEach((code, index) => {
      if (index > 0) {
        const plus = document.createElement('span');
        plus.className = 'kp-plus';
        plus.textContent = '+';
        plus.setAttribute('aria-hidden', 'true');
        button.appendChild(plus);
      }
      const src = srcForCode(baseUrl, code);
      if (src) {
        const img = document.createElement('img');
        img.className = 'kp-key';
        img.src = src;
        img.alt = code;
        img.draggable = false;
        button.appendChild(img);
      } else {
        const fallback = document.createElement('span');
        fallback.className = 'kp-fallback';
        fallback.textContent = options.formatKey?.(code) || code;
        button.appendChild(fallback);
      }
    });
  }

  /**
   * 录制中：已按修饰键图标 + 省略号文案。
   * @param {HTMLElement} button
   * @param {string[]} modifierCodes
   * @param {{ baseUrl: string, formatKey?: (c: string) => string }} options
   */
  function renderCapturing(button, modifierCodes, options) {
    button.replaceChildren();
    if (modifierCodes.length) {
      renderButton(button, modifierCodes, { ...options, emptyLabel: '' });
      const plus = document.createElement('span');
      plus.className = 'kp-plus';
      plus.textContent = '+';
      plus.setAttribute('aria-hidden', 'true');
      button.appendChild(plus);
      const wait = document.createElement('span');
      wait.className = 'kp-wait';
      wait.textContent = '…';
      button.appendChild(wait);
      return;
    }
    const wait = document.createElement('span');
    wait.className = 'kp-wait';
    wait.textContent = options.capturingLabel || '请按按键…';
    button.appendChild(wait);
  }

  window.KeyPrompts = {
    srcForCode,
    renderButton,
    renderCapturing,
    FILE_BY_CODE,
  };
})();
