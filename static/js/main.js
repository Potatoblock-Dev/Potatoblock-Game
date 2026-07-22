/** 首页：顶栏昵称、断线重连跳转、移动端下拉刷新。 */
(function () {
  'use strict';

  var accountLabel = document.getElementById('accountLabel');
  if (accountLabel) {
    fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) {
          return null;
        }
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.user_id) {
          return;
        }
        var name = String(data.nickname || '').trim();
        accountLabel.textContent = name || ('用户ID: ' + data.user_id);
      })
      .catch(function () {});
  }

  /** 页面顶部且无弹层遮挡时，允许下拉刷新。 */
  function canPullRefresh() {
    if (window.scrollY > 0) {
      return false;
    }
    if (document.body.style.overflow === 'hidden') {
      return false;
    }
    var blocked = document.querySelector(
      '.settings-overlay:not(.hidden), .pwa-guide-overlay:not(.hidden)'
    );
    return !blocked;
  }

  /** 绑定移动端顶部过度下拉 → 刷新。 */
  function bindPullToRefresh() {
    var tip = document.getElementById('pullRefresh');
    var tipText = tip && tip.querySelector('.pull-refresh-inner');
    if (!tip || !tipText) {
      return;
    }
    if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches
      && !window.matchMedia('(max-width: 639px)').matches) {
      return;
    }

    var startY = 0;
    var pulling = false;
    var armed = false;
    var THRESHOLD = 72;

    function setTip(distance, ready) {
      var shown = distance > 8;
      tip.classList.toggle('is-visible', shown);
      tip.style.height = (Math.min(distance, 96) + 12) + 'px';
      tipText.textContent = ready ? '松开刷新' : '下拉刷新';
      tip.setAttribute('aria-hidden', shown ? 'false' : 'true');
    }

    function resetTip() {
      tip.classList.remove('is-visible');
      tip.style.height = '';
      tipText.textContent = '下拉刷新';
      tip.setAttribute('aria-hidden', 'true');
    }

    window.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1 || !canPullRefresh()) {
        pulling = false;
        return;
      }
      startY = event.touches[0].clientY;
      pulling = true;
      armed = false;
    }, { passive: true });

    window.addEventListener('touchmove', function (event) {
      if (!pulling || event.touches.length !== 1) {
        return;
      }
      if (!canPullRefresh()) {
        pulling = false;
        resetTip();
        return;
      }
      var dy = event.touches[0].clientY - startY;
      if (dy <= 0) {
        armed = false;
        resetTip();
        return;
      }
      // 仅在过度下拉时拦截，避免影响正常滚动。
      if (dy > 10 && event.cancelable) {
        event.preventDefault();
      }
      armed = dy >= THRESHOLD;
      setTip(dy * 0.45, armed);
    }, { passive: false });

    window.addEventListener('touchend', function () {
      if (!pulling) {
        return;
      }
      pulling = false;
      if (armed && canPullRefresh()) {
        tipText.textContent = '正在刷新…';
        tip.classList.add('is-visible');
        window.location.reload();
        return;
      }
      resetTip();
    }, { passive: true });

    window.addEventListener('touchcancel', function () {
      pulling = false;
      armed = false;
      resetTip();
    }, { passive: true });
  }

  bindPullToRefresh();

  if (new URLSearchParams(window.location.search).has('stay')) {
    return;
  }

  fetch('/api/active-session', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) {
        return null;
      }
      return response.json();
    })
    .then(function (data) {
      var session = data && data.session;
      if (session && session.url) {
        window.location.replace(session.url);
      }
    })
    .catch(function () {});
})();
