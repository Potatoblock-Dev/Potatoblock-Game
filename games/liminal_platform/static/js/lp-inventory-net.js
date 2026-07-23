/**
 * 阈限月台联机库存：应用服务端快照，并发送 inv 意图。
 * 离线时 isActive() 为 false，调用方继续走 localStorage。
 */
(() => {
  let boundSession = null;

  /** 是否已联机且应使用服务端权威库存。 */
  function isActive() {
    return Boolean(window.LiminalSession?.isConnected?.());
  }

  /** 绑定会话引用（事件由 lp-session 转发）。 */
  function bindSession(session) {
    boundSession = session || null;
  }

  /** 用 JSON 覆盖已有 Inventory 实例（保持引用，避免 UI 丢绑）。 */
  function overwriteInventory(target, data, options = {}) {
    if (!target || !data || !window.LpInventoryCore) return;
    const next = window.LpInventoryCore.Inventory.fromJSON(data, options);
    target.id = next.id;
    target.cols = next.cols;
    target.rows = next.rows;
    target.ignoreItemSize = next.ignoreItemSize;
    target.slotKeys = next.slotKeys ? [...next.slotKeys] : null;
    target.slots = next.slots;
  }

  /** 应用房间共享库存（仓库 / 地面 / 炮塔箱）。 */
  function applyRoomOnly(detail) {
    const room = detail?.room || detail;
    if (!room) return;
    if (room.storage && window.LpInventory?.getStorageInventory) {
      overwriteInventory(window.LpInventory.getStorageInventory(), room.storage);
    }
    if (room.ground && window.LpGroundLoot?.applyFromSnapshot) {
      window.LpGroundLoot.applyFromSnapshot(room.ground);
    }
    if (room.crates && window.LpGuardTurret?.applyCratesFromSnapshot) {
      window.LpGuardTurret.applyCratesFromSnapshot(room.crates);
    }
    window.LpInventory?.renderAfterAuthority?.();
    window.LpHandsHud?.render?.();
    window.LpGuardCrateUi?.refresh?.();
  }

  /**
   * 应用完整库存快照（个人 + 房间）。
   * @param {object} detail inv_snapshot 消息
   */
  function applySnapshot(detail) {
    if (!detail) return;
    const personal = detail.personal || {};
    const inv = window.LpInventory;
    if (inv?.getPlayerInventory && personal.player) {
      overwriteInventory(inv.getPlayerInventory(), personal.player);
    }
    if (inv?.getHandsInventory && personal.hands) {
      overwriteInventory(inv.getHandsInventory(), personal.hands, {
        ignoreItemSize: true,
      });
    }
    if (inv?.getEquipInventory && personal.equip) {
      overwriteInventory(inv.getEquipInventory(), personal.equip, {
        ignoreItemSize: true,
        slotKeys: personal.equip.slotKeys,
      });
    }
    if (detail.room) {
      applyRoomOnly({ room: detail.room });
    } else {
      inv?.renderAfterAuthority?.();
      window.LpHandsHud?.render?.();
    }
    inv?.clearCursorAfterAuthority?.();
  }

  /** 发送库存意图（type=inv）。 */
  function sendOp(payload) {
    if (!isActive()) return false;
    const session = window.LiminalSession?.getSession?.() || boundSession;
    if (!session?.sendInv) return false;
    session.sendInv(payload || {});
    return true;
  }

  window.LpInventoryNet = {
    isActive,
    bindSession,
    applySnapshot,
    applyRoomOnly,
    sendOp,
    overwriteInventory,
  };
})();
