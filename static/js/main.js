/** 首页：已登录且存在可重连房间时，直接进入对应游戏。 */
(function () {
  'use strict';

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
