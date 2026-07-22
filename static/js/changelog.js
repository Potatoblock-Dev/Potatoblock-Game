/** 首页更新日志：邮箱按钮 + 弹窗列表。 */
(function () {
  'use strict';

  const STORAGE_KEY = 'pb-changelog-seen';
  const CHANGELOG_URL = '/static/changelog.json?v=1';

  function bindChangelogUi() {
    const openBtn = document.getElementById('changelogButton');
    const badge = document.getElementById('changelogBadge');
    const overlay = document.getElementById('changelogOverlay');
    const closeBtn = document.getElementById('changelogCloseButton');
    const listEl = document.getElementById('changelogList');
    if (!openBtn || !overlay || !listEl) return;

    function setOpen(open) {
      overlay.classList.toggle('hidden', !open);
      document.body.style.overflow = open ? 'hidden' : '';
      if (open) {
        markSeen();
        if (badge) badge.classList.add('hidden');
      }
    }

    function markSeen() {
      const latest = overlay.dataset.latest || '';
      if (latest) localStorage.setItem(STORAGE_KEY, latest);
    }

    function render(data) {
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const latest = String(data.latest || (entries[0] && entries[0].version) || '');
      overlay.dataset.latest = latest;
      listEl.innerHTML = entries.map((entry) => {
        const items = (entry.items || [])
          .map((text) => `<li>${escapeHtml(String(text))}</li>`)
          .join('');
        return (
          `<article class="changelog-entry">` +
          `<header class="changelog-entry-head">` +
          `<strong>v${escapeHtml(String(entry.version || ''))}</strong>` +
          `<span>${escapeHtml(String(entry.date || ''))}</span>` +
          `</header>` +
          `<ul class="changelog-entry-list">${items}</ul>` +
          `</article>`
        );
      }).join('') || '<p class="changelog-empty">暂无更新记录</p>';

      const seen = localStorage.getItem(STORAGE_KEY) || '';
      if (badge && latest && seen !== latest) {
        badge.classList.remove('hidden');
      }
    }

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    openBtn.addEventListener('click', () => setOpen(true));
    closeBtn?.addEventListener('click', () => setOpen(false));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) setOpen(false);
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !overlay.classList.contains('hidden')) {
        setOpen(false);
      }
    });

    fetch(CHANGELOG_URL, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error('changelog fetch failed');
        return res.json();
      })
      .then(render)
      .catch(() => {
        listEl.innerHTML = '<p class="changelog-empty">更新日志暂时无法加载</p>';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindChangelogUi);
  } else {
    bindChangelogUi();
  }
})();
