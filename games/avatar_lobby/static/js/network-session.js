/**
 * 联机会话：WebSocket 多人大厅。
 *
 * 接口：connect / disconnect / sendInput / createRoom / joinRoom / returnPublic / setAppearance
 * 事件：connectionchange、worldsnapshot、playerleave、playerjoin、appearance、roomchange、roomerror
 */
(() => {
  const PROTOCOL_VERSION = 6;
  const INPUT_RATE_HZ = 20;
  const PUBLIC_ROOM_ID = 'public';
  const PING_MS = 5000;
  const PONG_TIMEOUT_MS = 12000;
  const MAX_BACKOFF_MS = 8000;

  function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams(location.search);
    const query = params.toString();
    return `${protocol}//${location.host}/avatar-lobby/ws${query ? `?${query}` : ''}`;
  }

  function roomFromUrl() {
    const room = new URLSearchParams(location.search).get('room');
    return room && room.trim() ? room.trim().toUpperCase() : PUBLIC_ROOM_ID;
  }

  class WebSocketSession extends EventTarget {
    constructor() {
      super();
      this.mode = 'online';
      this.identity = null;
      this.ws = null;
      this.roomId = PUBLIC_ROOM_ID;
      this.desiredRoomId = PUBLIC_ROOM_ID;
      this.createNext = false;
      this.connected = false;
      this.manualClose = false;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.pingTimer = null;
      this.lastPongAt = 0;
      this.playerCount = 0;
      this.maxPlayers = 10;
      this.isPublic = true;
    }

    connect(identity) {
      this.identity = { ...identity };
      this.manualClose = false;
      this.desiredRoomId = roomFromUrl();
      this._open();
    }

    disconnect() {
      this.manualClose = true;
      this._clearTimers();
      if (this.ws) {
        try { this.ws.close(1000); } catch (_err) { /* ignore */ }
        this.ws = null;
      }
      this.connected = false;
      this._emit('connectionchange', { status: 'offline' });
    }

    sendInput(frame) {
      this._send({
        type: 'input',
        protocolVersion: PROTOCOL_VERSION,
        sequence: frame.sequence,
        direction: frame.direction,
        jump: frame.jump,
        kneel: frame.kneel,
        sprint: Boolean(frame.sprint),
        headLook: Number(frame.headLook) || 0,
      });
    }

    setAppearance(appearance) {
      this._send({
        type: 'appearance',
        protocolVersion: PROTOCOL_VERSION,
        skinId: appearance?.skinId || null,
      });
    }

    sendChat(text) {
      const cleaned = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!cleaned) return;
      this._send({
        type: 'chat',
        protocolVersion: PROTOCOL_VERSION,
        text: cleaned,
      });
    }

    createRoom() {
      this.createNext = true;
      this.desiredRoomId = null;
      if (this.connected) {
        this._send({ type: 'create', protocolVersion: PROTOCOL_VERSION });
      } else {
        this._open();
      }
    }

    joinRoom(roomId) {
      this.createNext = false;
      this.desiredRoomId = (roomId || PUBLIC_ROOM_ID).toUpperCase();
      if (this.connected) {
        this._send({
          type: 'join',
          protocolVersion: PROTOCOL_VERSION,
          roomId: this.desiredRoomId,
        });
      } else {
        this._open();
      }
    }

    returnPublic() {
      this.joinRoom(PUBLIC_ROOM_ID);
    }

    _open() {
      this._clearTimers();
      // 被顶替后用户主动创建/加入房间时恢复自动重连。
      this.manualClose = false;
      if (this.ws) {
        try { this.ws.close(); } catch (_err) { /* ignore */ }
      }
      this._emit('connectionchange', { status: 'connecting' });
      const socket = new WebSocket(wsUrl());
      this.ws = socket;

      socket.onopen = () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.lastPongAt = performance.now();
        this._emit('connectionchange', { status: 'online' });
        if (this.createNext) {
          this._send({ type: 'create', protocolVersion: PROTOCOL_VERSION });
          this.createNext = false;
        } else {
          this._send({
            type: 'join',
            protocolVersion: PROTOCOL_VERSION,
            roomId: this.desiredRoomId || PUBLIC_ROOM_ID,
          });
        }
        this.pingTimer = setInterval(() => this._ping(), PING_MS);
      };

      socket.onmessage = (event) => {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch (_err) {
          return;
        }
        this._handleMessage(payload);
      };

      socket.onclose = (event) => {
        this.connected = false;
        this.ws = null;
        this._clearPing();
        // 同账号在其他窗口进入：停止重连，否则两个窗口互相顶替、角色来回闪现。
        if (event.code === 4002) {
          this.manualClose = true;
          this._emit('connectionchange', { status: 'replaced' });
          return;
        }
        // 房间已满被拒：重连回公共大厅，避免对同一满房无限重试。
        if (event.code === 4005) {
          this.desiredRoomId = PUBLIC_ROOM_ID;
          this.createNext = false;
        }
        this._emit('connectionchange', { status: 'offline' });
        if (!this.manualClose) this._scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose 会随后触发重连。
      };
    }

    _handleMessage(payload) {
      const type = payload?.type;
      if (type === 'pong') {
        this.lastPongAt = performance.now();
        return;
      }
      if (type === 'room_joined') {
        this.roomId = payload.roomId;
        this.isPublic = Boolean(payload.isPublic);
        this.playerCount = payload.playerCount || 1;
        this.maxPlayers = payload.maxPlayers || 10;
        this.desiredRoomId = payload.roomId;
        this._syncUrlRoom(payload.roomId, payload.isPublic);
        this._emit('roomchange', payload);
        return;
      }
      if (type === 'room_error') {
        this._emit('roomerror', payload);
        return;
      }
      if (type === 'world_snapshot') {
        this.roomId = payload.roomId || this.roomId;
        this.isPublic = payload.isPublic ?? this.isPublic;
        this.playerCount = payload.playerCount || 0;
        this.maxPlayers = payload.maxPlayers || this.maxPlayers;
        this._emit('worldsnapshot', payload);
        return;
      }
      if (type === 'player_leave') {
        this.playerCount = payload.playerCount || this.playerCount;
        this._emit('playerleave', payload);
        return;
      }
      if (type === 'player_join') {
        this.playerCount = payload.playerCount || this.playerCount;
        this._emit('playerjoin', payload);
        return;
      }
      if (type === 'appearance') {
        this._emit('appearance', payload);
        return;
      }
      if (type === 'chat') {
        this._emit('chat', payload);
      }
    }

    _ping() {
      if (!this.connected) return;
      if (performance.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        try { this.ws?.close(); } catch (_err) { /* ignore */ }
        return;
      }
      this._send({ type: 'ping', t: performance.now() });
    }

    _send(message) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify(message));
    }

    _scheduleReconnect() {
      this._clearReconnect();
      const delay = Math.min(MAX_BACKOFF_MS, 500 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt += 1;
      this.reconnectTimer = setTimeout(() => {
        if (!this.manualClose) this._open();
      }, delay);
    }

    _syncUrlRoom(roomId, isPublic) {
      const url = new URL(location.href);
      if (isPublic || roomId === PUBLIC_ROOM_ID) {
        url.searchParams.delete('room');
      } else {
        url.searchParams.set('room', roomId);
      }
      history.replaceState(null, '', url);
    }

    _clearPing() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    }

    _clearReconnect() {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    }

    _clearTimers() {
      this._clearPing();
      this._clearReconnect();
    }

    _emit(name, detail) {
      this.dispatchEvent(new CustomEvent(name, { detail }));
    }
  }

  // 离线兜底：WebSocket 不可用时仍可本地游玩。
  class OfflineSession extends EventTarget {
    constructor() {
      super();
      this.mode = 'offline';
      this.identity = null;
      this.roomId = PUBLIC_ROOM_ID;
      this.playerCount = 1;
      this.maxPlayers = 1;
      this.isPublic = true;
    }

    connect(identity) {
      this.identity = { ...identity };
      this.dispatchEvent(new CustomEvent('connectionchange', {
        detail: { status: 'offline' },
      }));
    }

    sendInput() {}
    setAppearance() {}
    sendChat() {}
    createRoom() {}
    joinRoom() {}
    returnPublic() {}
    disconnect() {
      this.identity = null;
    }
  }

  window.AvatarNetwork = {
    PROTOCOL_VERSION,
    INPUT_RATE_HZ,
    PUBLIC_ROOM_ID,
    createSession() {
      if (typeof WebSocket === 'undefined') return new OfflineSession();
      return new WebSocketSession();
    },
  };
})();
