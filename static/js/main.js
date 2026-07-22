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

  /** 绑定移动端顶部过度下拉 → 刷新（松手带回弹动画）。 */
  function bindPullToRefresh() {
    var body = document.body;
    var tip = document.getElementById('pullRefresh');
    var tipText = tip && tip.querySelector('.pull-refresh-inner');
    var homeMain = document.querySelector('.home-main');
    if (!tip || !tipText || !homeMain || !body.classList.contains('home-page')) {
      return;
    }
    if (!window.matchMedia('(hover: none) and (pointer: coarse)').matches
      && !window.matchMedia('(max-width: 639px)').matches) {
      return;
    }

    var startY = 0;
    var pulling = false;
    var armed = false;
    var pullY = 0;
    var rebounding = false;
    var THRESHOLD = 72;
    var MAX_PULL = 120;

    function setPullY(y) {
      pullY = Math.max(0, Math.min(y, MAX_PULL));
      body.style.setProperty('--pull-y', pullY + 'px');
      tip.classList.toggle('is-visible', pullY > 8);
      tip.setAttribute('aria-hidden', pullY > 8 ? 'false' : 'true');
    }

    function setTipLabel(ready, refreshing) {
      if (refreshing) {
        tipText.textContent = '正在刷新…';
        return;
      }
      tipText.textContent = ready ? '松开刷新' : '下拉刷新';
    }

    function clearPullState() {
      body.classList.remove('is-pulling', 'is-rebounding');
      body.style.removeProperty('--pull-y');
      tip.classList.remove('is-visible');
      tip.setAttribute('aria-hidden', 'true');
      tipText.textContent = '下拉刷新';
      pullY = 0;
      rebounding = false;
    }

    /** 松手后平滑回弹到 0，结束后回调。 */
    function reboundToRest(onDone) {
      if (rebounding) {
        return;
      }
      rebounding = true;
      body.classList.remove('is-pulling');
      body.classList.add('is-rebounding');
      setPullY(0);
      tip.classList.remove('is-visible');

      var finished = false;
      function finish() {
        if (finished) {
          return;
        }
        finished = true;
        homeMain.removeEventListener('transitionend', onTransitionEnd);
        clearPullState();
        if (onDone) {
          onDone();
        }
      }

      function onTransitionEnd(event) {
        if (event.propertyName === 'transform') {
          finish();
        }
      }

      homeMain.addEventListener('transitionend', onTransitionEnd);
      window.setTimeout(finish, 480);
    }

    window.addEventListener('touchstart', function (event) {
      if (rebounding || event.touches.length !== 1 || !canPullRefresh()) {
        pulling = false;
        return;
      }
      startY = event.touches[0].clientY;
      pulling = true;
      armed = false;
      body.classList.remove('is-rebounding');
      body.classList.add('is-pulling');
    }, { passive: true });

    window.addEventListener('touchmove', function (event) {
      if (!pulling || rebounding || event.touches.length !== 1) {
        return;
      }
      if (!canPullRefresh()) {
        pulling = false;
        reboundToRest();
        return;
      }
      var dy = event.touches[0].clientY - startY;
      if (dy <= 0) {
        armed = false;
        setPullY(0);
        setTipLabel(false, false);
        return;
      }
      if (dy > 10 && event.cancelable) {
        event.preventDefault();
      }
      // 阻尼：越往下越难拉，回弹更自然。
      var dampened = Math.min(MAX_PULL, dy * 0.42);
      armed = dampened >= THRESHOLD * 0.55;
      setPullY(dampened);
      setTipLabel(armed, false);
    }, { passive: false });

    window.addEventListener('touchend', function () {
      if (!pulling || rebounding) {
        return;
      }
      pulling = false;
      if (armed && canPullRefresh()) {
        setTipLabel(false, true);
        tip.classList.add('is-visible');
        body.classList.remove('is-pulling');
        body.classList.add('is-rebounding');
        // 先收到刷新位，再短停后刷新，避免瞬间跳转。
        setPullY(48);
        window.setTimeout(function () {
          window.location.reload();
        }, 220);
        return;
      }
      reboundToRest();
    }, { passive: true });

    window.addEventListener('touchcancel', function () {
      if (!pulling && !rebounding) {
        return;
      }
      pulling = false;
      armed = false;
      reboundToRest();
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
