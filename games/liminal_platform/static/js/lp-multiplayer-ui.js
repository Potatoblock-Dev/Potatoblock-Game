/**
 * 阈限月台多人房间控件（复用大厅 mp-* 元素约定）。
 * 连线状态带迟滞：短时断线仍显示「连线」，避免与「重连」来回闪。
 */
(() => {
  const PUBLIC_ROOM_ID = window.LiminalNetwork?.PUBLIC_ROOM_ID || 'public';
  /** 已连线后，断线未超过此时长仍显示「连线」。 */
  const ONLINE_HOLD_MS = 1500;

  function bindMultiplayerUi(session) {
    const statusEl = document.getElementById('mpStatus');
    const roomEl = document.getElementById('mpRoom');
    const countEl = document.getElementById('mpCount');
    const joinInput = document.getElementById('mpJoinInput');
    const feedbackEl = document.getElementById('mpFeedback');
    const createBtn = document.getElementById('mpCreateButton');
    const joinBtn = document.getElementById('mpJoinButton');
    const publicBtn = document.getElementById('mpPublicButton');
    const inviteBtn = document.getElementById('mpInviteButton');

    /** 写入房间操作反馈文案。 */
    function setFeedback(text, isError = false) {
      if (!feedbackEl) return;
      feedbackEl.textContent = text || '';
      feedbackEl.classList.toggle('is-error', Boolean(isError && text));
    }

    let lastStatus = 'connecting';
    let everOnline = false;
    /** 展示态：online | connecting | reconnecting | offline | replaced */
    let displayKind = 'connecting';
    let holdTimer = null;

    /** 将展示态映射为状态条文案。 */
    function statusText() {
      if (displayKind === 'online') return '连线';
      if (displayKind === 'replaced') return '已在其他窗口打开';
      if (displayKind === 'offline') return '断线';
      if (displayKind === 'connecting') return '连接中';
      return '重连';
    }

    /** 是否按「已连线」样式着色。 */
    function isOnlineStyle() {
      return displayKind === 'online';
    }

    /** 根据底层 connectionchange / connected 更新展示态（含迟滞）。 */
    function syncDisplayKind() {
      if (session.connected || lastStatus === 'online') {
        everOnline = true;
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        displayKind = 'online';
        return;
      }

      if (lastStatus === 'replaced') {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        displayKind = 'replaced';
        return;
      }

      // 主动断开：立刻显示断线。
      if (lastStatus === 'offline' && session.manualClose) {
        if (holdTimer) {
          clearTimeout(holdTimer);
          holdTimer = null;
        }
        displayKind = 'offline';
        return;
      }

      const nextKind = everOnline ? 'reconnecting' : 'connecting';

      // 已显示连线时，短时断线不立刻切到重连。
      if (displayKind === 'online') {
        if (!holdTimer) {
          holdTimer = setTimeout(() => {
            holdTimer = null;
            if (session.connected) {
              displayKind = 'online';
            } else if (lastStatus === 'replaced') {
              displayKind = 'replaced';
            } else if (lastStatus === 'offline' && session.manualClose) {
              displayKind = 'offline';
            } else {
              displayKind = everOnline ? 'reconnecting' : 'connecting';
            }
            render();
          }, ONLINE_HOLD_MS);
        }
        return;
      }

      // 重连过程中 connecting / offline / reconnecting 都稳定显示「重连」或「连接中」。
      displayKind = nextKind;
    }

    /** 刷新状态条、房间名、人数与按钮可用态。 */
    function render() {
      syncDisplayKind();
      if (statusEl) {
        const online = isOnlineStyle();
        statusEl.textContent = statusText();
        statusEl.classList.toggle('is-online', online);
        statusEl.classList.toggle('is-offline', !online);
      }
      if (roomEl) {
        roomEl.textContent =
          session.isPublic || session.roomId === PUBLIC_ROOM_ID
            ? '公共月台'
            : `房间 ${session.roomId}`;
      }
      if (countEl) {
        countEl.textContent = `${session.playerCount || 0}/${session.maxPlayers || 10}`;
      }
      if (publicBtn) {
        publicBtn.disabled = Boolean(session.isPublic || session.roomId === PUBLIC_ROOM_ID);
      }
      if (inviteBtn) {
        inviteBtn.disabled = Boolean(session.isPublic || session.roomId === PUBLIC_ROOM_ID);
      }
    }

    createBtn?.addEventListener('click', () => {
      setFeedback('正在创建房间…');
      session.createRoom();
    });

    joinBtn?.addEventListener('click', () => {
      const code = (joinInput?.value || '').trim().toUpperCase();
      if (!code) {
        setFeedback('请输入房间码', true);
        return;
      }
      setFeedback(`正在加入 ${code}…`);
      session.joinRoom(code);
    });

    joinInput?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') joinBtn?.click();
    });

    publicBtn?.addEventListener('click', () => {
      setFeedback('返回公共月台…');
      session.returnPublic();
    });

    inviteBtn?.addEventListener('click', async () => {
      const url = new URL(location.href);
      url.searchParams.set('room', session.roomId);
      try {
        await navigator.clipboard.writeText(url.toString());
        setFeedback('邀请链接已复制');
      } catch (_err) {
        setFeedback(url.toString());
      }
    });

    session.addEventListener('connectionchange', (event) => {
      lastStatus = event.detail?.status || lastStatus;
      if (lastStatus === 'online') setFeedback('');
      if (lastStatus === 'replaced') setFeedback('已在其他窗口打开', true);
      render();
    });
    session.addEventListener('roomchange', () => {
      setFeedback('');
      render();
    });
    session.addEventListener('worldsnapshot', render);
    session.addEventListener('playerjoin', render);
    session.addEventListener('playerleave', render);
    session.addEventListener('roomerror', (event) => {
      setFeedback(event.detail?.message || '房间错误', true);
      render();
    });

    render();
  }

  window.LiminalMultiplayerUi = { bindMultiplayerUi };
})();
