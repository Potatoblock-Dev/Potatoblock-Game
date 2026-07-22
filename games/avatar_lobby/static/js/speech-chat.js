/**
 * 电脑端 Enter 聊天栏：打开输入 → Enter 发送 → 头顶气泡。
 * 通过 options.onSend(text) 交给各游戏处理本地气泡与联网广播。
 */
(() => {
  const MAX_CHARS = window.AvatarEntity?.SPEECH_MAX_CHARS || 40;

  function createSpeechChat(options = {}) {
    const root = document.getElementById(options.rootId || 'speechChatBar');
    const input = document.getElementById(options.inputId || 'speechChatInput');
    if (!root || !input) {
      return { isOpen: () => false, open() {}, close() {}, bind() {} };
    }

    let open = false;

    function setOpen(next) {
      open = next;
      root.classList.toggle('is-open', open);
      root.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) {
        input.value = '';
        input.focus();
      } else {
        input.blur();
      }
    }

    function submit() {
      const text = String(input.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
      input.value = '';
      setOpen(false);
      if (!text) return;
      options.onSend?.(text);
    }

    function shouldIgnoreGlobalEnter(event) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return event.target !== input;
      }
      if (options.isBlocked?.()) return true;
      return false;
    }

    function bind() {
      window.addEventListener('keydown', (event) => {
        if (event.code !== 'Enter' || event.repeat || event.isComposing) return;
        if (open && event.target === input) {
          event.preventDefault();
          submit();
          return;
        }
        if (open) return;
        if (shouldIgnoreGlobalEnter(event)) return;
        // 仅电脑端：触控设备不抢 Enter。
        if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
        event.preventDefault();
        setOpen(true);
      }, true);

      input.addEventListener('keydown', (event) => {
        if (event.code === 'Escape') {
          event.preventDefault();
          setOpen(false);
        }
      });

      root.querySelector('[data-speech-chat-send]')?.addEventListener('click', submit);
      root.querySelector('[data-speech-chat-cancel]')?.addEventListener('click', () => setOpen(false));
    }

    return {
      isOpen: () => open,
      open: () => setOpen(true),
      close: () => setOpen(false),
      bind,
    };
  }

  window.SpeechChat = { createSpeechChat };
})();
