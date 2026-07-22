/**
 * 阈限月台多人房间控件（复用大厅 mp-* 元素约定）。
 */
(() => {
  const PUBLIC_ROOM_ID = window.LiminalNetwork?.PUBLIC_ROOM_ID || 'public';

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

    function setFeedback(text, isError = false) {
      if (!feedbackEl) return;
      feedbackEl.textContent = text || '';
      feedbackEl.classList.toggle('is-error', Boolean(isError && text));
    }

    let lastStatus = 'connecting';

    function statusText() {
      if (session.connected) return '在线';
      if (lastStatus === 'replaced') return '已在其他窗口打开';
      return lastStatus === 'connecting' ? '连接中' : '重连中';
    }

    function render() {
      if (statusEl) {
        const online = session.connected;
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
