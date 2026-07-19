/**
 * 舞台浮层 UI：顶栏按钮开关键位/皮套面板，同一时间只展开一个。
 */
(() => {
  const toggles = [...document.querySelectorAll('[data-panel-toggle]')];
  const panels = toggles.map((button) => document.getElementById(button.dataset.panelToggle));

  function notifyPanelState(panel, open) {
    window.dispatchEvent(new CustomEvent('stagepanelchange', {
      detail: { id: panel.id, open },
    }));
  }

  function setOpenPanel(target) {
    const shouldOpen = target.classList.contains('hidden');
    panels.forEach((panel, index) => {
      const open = shouldOpen && panel === target;
      const wasOpen = !panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !open);
      toggles[index].classList.toggle('is-open', open);
      if (open !== wasOpen) notifyPanelState(panel, open);
    });
  }

  toggles.forEach((button, index) => {
    button.addEventListener('click', () => setOpenPanel(panels[index]));
  });

  function closeAllPanels() {
    panels.forEach((panel, index) => {
      const wasOpen = !panel.classList.contains('hidden');
      panel.classList.add('hidden');
      toggles[index].classList.remove('is-open');
      if (wasOpen) notifyPanelState(panel, false);
    });
  }

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') closeAllPanels();
  });

  // 皮套编辑器等其他浮层打开前先收起顶栏面板。
  window.StageUI = { closeAllPanels };

  // 首次进入时弹出内容规范，同意后写入本地标记，之后不再打扰。
  // 各游戏共用同一份规范，同意一次即可；条款有实质修改时递增版本号重新弹出。
  const CONTENT_POLICY_KEY = 'potatoblock.contentPolicyAccepted.v1';
  const policyPrompt = document.getElementById('contentPolicyPrompt');
  if (localStorage.getItem(CONTENT_POLICY_KEY) !== '1') {
    policyPrompt.classList.remove('hidden');
    document.getElementById('contentPolicyPromptConfirm').addEventListener('click', () => {
      localStorage.setItem(CONTENT_POLICY_KEY, '1');
      policyPrompt.classList.add('hidden');
      window.dispatchEvent(new CustomEvent('contentpolicychange', {
        detail: { open: false },
      }));
    }, { once: true });
  }
})();
