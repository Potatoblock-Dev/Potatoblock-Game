(function (global) {
  'use strict';

  // 服务端单条 draw_batch 最多接收 64 段，超出会整批丢弃，这里留出余量分片。
  const MAX_BATCH_SEGMENTS = 60;

  /**
   * Two sync policies:
   * - lobby-multi: many owners; coalesce segments briefly, never confirm with full snapshots
   * - game-solo: one drawer; tighter coalesce so guessers see smooth incremental ink
   * - local: private lobby canvas (no network)
   *
   * Full canvas repair is requestRepairSync() only (join/reconnect/tab-visible).
   */
  class DrawGuessBoardAdapter {
    constructor(options) {
      const settings = options || {};
      this.send = settings.send;
      this.getCanvasScope = settings.getCanvasScope;
      this.getRoundId = settings.getRoundId;
      this.isPrivateLobby = settings.isPrivateLobby;
      this._queue = [];
      this._flushTimer = null;
      this._batchMs = {
        'lobby-multi': 24,
        'game-solo': 16,
        local: 0
      };
    }

    getSyncMode() {
      if (this.isPrivateLobby()) return 'local';
      return this.getCanvasScope() === 'lobby' ? 'lobby-multi' : 'game-solo';
    }

    actionType(action) {
      return this.getSyncMode() === 'lobby-multi' ? 'lobby_' + action : action;
    }

    isPublicScope() {
      return this.getSyncMode() !== 'local';
    }

    sendSegment(strokeId, segment, options) {
      const mode = this.getSyncMode();
      if (mode === 'local') return false;
      const immediate = Boolean(options && options.immediate);
      this._queue.push({ strokeId: String(strokeId), segment: Object.assign({}, segment) });
      if (immediate || this._batchMs[mode] <= 0) {
        this.flushSegments();
        return true;
      }
      this._scheduleFlush(mode);
      return true;
    }

    _scheduleFlush(mode) {
      if (this._flushTimer != null) return;
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.flushSegments();
      }, this._batchMs[mode] || 0);
    }

    flushSegments() {
      if (this._flushTimer != null) {
        clearTimeout(this._flushTimer);
        this._flushTimer = null;
      }
      if (!this._queue.length) return;
      const mode = this.getSyncMode();
      if (mode === 'local') {
        this._queue = [];
        return;
      }
      const pending = this._queue;
      this._queue = [];
      const groups = [];
      const indexByStroke = new Map();
      pending.forEach(item => {
        let group = indexByStroke.get(item.strokeId);
        if (!group) {
          group = { strokeId: item.strokeId, segments: [] };
          indexByStroke.set(item.strokeId, group);
          groups.push(group);
        }
        group.segments.push(item.segment);
      });

      const roundId = mode === 'game-solo' ? this.getRoundId() : '';
      groups.forEach(group => {
        if (group.segments.length === 1) {
          const payload = Object.assign(
            { type: this.actionType('draw'), stroke_id: group.strokeId },
            group.segments[0]
          );
          if (mode === 'game-solo') payload.round_id = roundId;
          this.send(payload);
          return;
        }
        for (let start = 0; start < group.segments.length; start += MAX_BATCH_SEGMENTS) {
          const chunk = group.segments.slice(start, start + MAX_BATCH_SEGMENTS);
          const payload = {
            type: this.actionType('draw_batch'),
            stroke_id: group.strokeId,
            segments: chunk
          };
          if (mode === 'game-solo') payload.round_id = roundId;
          this.send(payload);
        }
      });
    }

    /** Full snapshot repair only — not used after each stroke. */
    requestRepairSync() {
      if (!this.isPublicScope()) return false;
      this.flushSegments();
      const payload = { type: 'drawing_sync_request' };
      if (this.getSyncMode() === 'game-solo') payload.round_id = this.getRoundId();
      this.send(payload);
      return true;
    }

    /** @deprecated use requestRepairSync */
    requestSync() {
      return this.requestRepairSync();
    }

    sendHistoryAction(action) {
      if (!['undo', 'redo', 'clear'].includes(action)) return false;
      if (!this.isPublicScope()) return false;
      this.flushSegments();
      const payload = { type: this.actionType(action) };
      if (this.getSyncMode() === 'game-solo') payload.round_id = this.getRoundId();
      this.send(payload);
      return true;
    }
  }

  global.DrawGuessBoardAdapter = DrawGuessBoardAdapter;
})(window);
