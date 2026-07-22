/** PWA 注册、安装引导、版本更新通知。 */
(function () {
  'use strict';

  const SW_URL = '/sw.js';
  const UPDATE_EVENT = 'pb-pwa-update';
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent);
  }

  function dispatchUpdate() {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
  }

  function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('hidden', hidden);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register(SW_URL, { scope: '/' }).then((reg) => {
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            dispatchUpdate();
          }
        });
      });
      if (reg.waiting && navigator.serviceWorker.controller) {
        dispatchUpdate();
      }
    }).catch(() => {});
  }

  function bindInstallGuide() {
    const guide = document.getElementById('pwaInstallGuide');
    const closeBtn = document.getElementById('pwaGuideClose');
    const doneBtn = document.getElementById('pwaGuideDone');
    if (!guide) return { open() {}, close() {} };

    function open() {
      setHidden(guide, false);
      guide.scrollTop = 0;
      const panel = guide.querySelector('.pwa-guide-panel');
      if (panel) panel.scrollTop = 0;
      document.body.style.overflow = 'hidden';
    }

    function close() {
      setHidden(guide, true);
      document.body.style.overflow = '';
    }

    closeBtn?.addEventListener('click', close);
    doneBtn?.addEventListener('click', close);
    guide.addEventListener('click', (event) => {
      if (event.target === guide) close();
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !guide.classList.contains('hidden')) close();
    });

    return { open, close };
  }

  function bindInstallUi() {
    const installBtn = document.getElementById('pwaInstallButton');
    const installStatus = document.getElementById('pwaInstallStatus');
    const iosHint = document.getElementById('pwaIosHint');
    const androidHint = document.getElementById('pwaAndroidHint');
    const desktopHint = document.getElementById('pwaDesktopHint');
    const updateBtn = document.getElementById('pwaUpdateButton');
    const updateHint = document.getElementById('pwaUpdateHint');
    const installGuide = bindInstallGuide();

    function hideAllInstallHints() {
      setHidden(iosHint, true);
      setHidden(androidHint, true);
      setHidden(desktopHint, true);
    }

    function showPlatformHint() {
      hideAllInstallHints();
      if (isIOS()) {
        setHidden(iosHint, false);
      } else if (isAndroid()) {
        setHidden(androidHint, false);
      } else {
        setHidden(desktopHint, false);
      }
    }

    function refreshInstallUi() {
      if (isStandalone()) {
        setHidden(installBtn, true);
        hideAllInstallHints();
        installGuide.close();
        if (installStatus) {
          installStatus.textContent = '已安装为应用，可从主屏幕打开。';
          setHidden(installStatus, false);
        }
        return;
      }

      if (installStatus) {
        installStatus.textContent = deferredPrompt
          ? '可一键安装到主屏幕。'
          : '按下方说明添加到主屏幕。';
        setHidden(installStatus, false);
      }

      setHidden(installBtn, false);
      if (deferredPrompt) {
        hideAllInstallHints();
        if (installBtn) installBtn.textContent = '添加到主屏幕 / 安装应用';
      } else {
        showPlatformHint();
        if (installBtn) {
          installBtn.textContent = isIOS()
            ? '查看安装步骤（iPhone / iPad）'
            : '查看安装步骤';
        }
      }
    }

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
          refreshInstallUi();
          return;
        }
        // iOS / 无系统安装弹窗：打开图文引导，避免“点了没反应”。
        if (isIOS()) {
          installGuide.open();
          return;
        }
        showPlatformHint();
        const hint = isAndroid() ? androidHint : desktopHint;
        hint?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // 非 iOS 也给一个明确反馈：短暂高亮说明文字。
        if (hint) {
          hint.style.outline = '2px solid rgb(245 158 11 / .7)';
          window.setTimeout(() => { hint.style.outline = ''; }, 1200);
        }
      });
    }

    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        if (!navigator.serviceWorker.controller) {
          window.location.reload();
          return;
        }
        navigator.serviceWorker.getRegistration().then((r) => {
          if (r && r.waiting) {
            r.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        });
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.location.reload();
        }, { once: true });
      });
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      refreshInstallUi();
    });

    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      refreshInstallUi();
    });

    window.addEventListener(UPDATE_EVENT, () => {
      setHidden(updateBtn, false);
      if (updateHint) {
        updateHint.textContent = '新版本已就绪，点击更新后重新加载。';
        setHidden(updateHint, false);
      }
    });

    refreshInstallUi();
  }

  registerServiceWorker();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindInstallUi);
  } else {
    bindInstallUi();
  }

  window.PotatoblockPwa = { isStandalone, isIOS, isAndroid };
})();
