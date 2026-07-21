/** PWA 注册、安装提示、版本更新通知。 */
(function () {
  'use strict';

  const SW_URL = '/sw.js';
  const UPDATE_EVENT = 'pb-pwa-update';
  let deferredPrompt = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function isAndroid() {
    return /Android/i.test(navigator.userAgent);
  }

  function dispatchUpdate() {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT));
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

  function bindInstallUi() {
    const installBtn = document.getElementById('pwaInstallButton');
    const iosHint = document.getElementById('pwaIosHint');
    const androidHint = document.getElementById('pwaAndroidHint');
    const updateBtn = document.getElementById('pwaUpdateButton');
    const updateHint = document.getElementById('pwaUpdateHint');

    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          deferredPrompt = null;
          installBtn.classList.add('hidden');
        }
      });
    }

    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        const reg = navigator.serviceWorker.controller;
        if (!reg) {
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
      if (installBtn) installBtn.classList.remove('hidden');
      if (androidHint) androidHint.classList.add('hidden');
    });

    window.addEventListener(UPDATE_EVENT, () => {
      if (updateBtn) updateBtn.classList.remove('hidden');
      if (updateHint) {
        updateHint.classList.remove('hidden');
        updateHint.textContent = '新版本已就绪，点击更新后重新加载。';
      }
    });

    if (isStandalone()) {
      if (installBtn) installBtn.classList.add('hidden');
      if (iosHint) iosHint.classList.add('hidden');
      if (androidHint) androidHint.classList.add('hidden');
      return;
    }

    if (isIOS() && iosHint) {
      iosHint.classList.remove('hidden');
    } else if (iosHint) {
      iosHint.classList.add('hidden');
    }
    if (isAndroid() && androidHint && !deferredPrompt) {
      androidHint.classList.remove('hidden');
    }
  }

  registerServiceWorker();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindInstallUi);
  } else {
    bindInstallUi();
  }

  window.PotatoblockPwa = { isStandalone, isIOS, isAndroid };
})();
