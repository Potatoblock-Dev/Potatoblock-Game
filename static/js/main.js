/** 首页：顶栏显示昵称（优先）/ UID；有可重连房间时自动进入游戏。 */
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
