/**
 * 医疗箱：手部 3 号槽（index 2）持用；开火键对准自己或近距队友持续治疗并扣耐久。
 * 联机：发 heal 意图，服务端校验耐久后广播 player_healed；离线本地结算。
 * 瞄准濒死队友时改为一次性 revive（消耗整箱医箱）。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  /** 手部 3 号（0-based index 2）。 */
  const HAND_SLOT_INDEX = 2;
  const NET_INTERVAL = 0.1;

  let netAccum = 0;
  let lastMode = null;
  let reviveSent = false;

  /** 当前选中手部槽上的医疗箱（须为 3 号或显式 handSlot）。 */
  function getHeldMedkitSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog?.isMedkit) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    const order = [];
    if (preferred === 0 || preferred === 1 || preferred === 2) order.push(preferred);
    if (!order.includes(HAND_SLOT_INDEX)) order.push(HAND_SLOT_INDEX);
    for (const index of order) {
      if (index >= hands.size()) continue;
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isMedkit(stack.itemId)) continue;
      const item = Catalog.getItem(stack.itemId);
      if (!item) continue;
      // 仅当选中的是该槽（或唯有工具槽有医箱且当前选中工具槽）才视为持用
      if (preferred != null && preferred !== index) continue;
      if (item.maxDurability != null && stack.dur == null) {
        stack = hands.updateSlot?.(index, { dur: item.maxDurability }) || {
          ...stack,
          dur: item.maxDurability,
        };
      }
      return { hands, index, stack, item };
    }
    return null;
  }

  /** 是否正持用医疗箱（选中 3 号槽且有医箱）。 */
  function isHoldingMedkit() {
    return Boolean(getHeldMedkitSlot());
  }

  /**
   * 根据瞄准点解析治疗目标：近距队友优先，否则自身（瞄准靠近自己）。
   * @returns {{ mode: 'self'|'ally'|'none', targetId: string|null, ally: object|null }}
   */
  function resolveHealTarget(aimX, aimY, selfX, selfY, remotes) {
    const held = getHeldMedkitSlot();
    if (!held) return { mode: 'none', targetId: null, ally: null };
    const item = held.item;
    const allyRange = Number(item.allyRange) || 150;
    const selfAim = Number(item.selfAimRadius) || 72;
    const allyAim = Number(item.allyAimRadius) || 88;
    const selfDistAim = Math.hypot(aimX - selfX, aimY - (selfY - 56));
    let best = null;
    let bestAim = Infinity;
    const list = Array.isArray(remotes) ? remotes : [];
    for (const remote of list) {
      if (!remote || remote._lpDisconnected) continue;
      const rx = Number(remote.x);
      const ry = Number(remote.y != null ? remote.y : remote._physicsY != null ? remote._physicsY : 0);
      if (!Number.isFinite(rx)) continue;
      const distSelf = Math.hypot(rx - selfX, (ry || 0) - (selfY || 0));
      if (distSelf > allyRange) continue;
      const chestY = (Number.isFinite(ry) ? ry : 0) - 56;
      const distAim = Math.hypot(aimX - rx, aimY - chestY);
      if (distAim > allyAim) continue;
      if (distAim < bestAim) {
        bestAim = distAim;
        best = remote;
      }
    }
    if (best) {
      return { mode: 'ally', targetId: String(best.id || ''), ally: best };
    }
    if (selfDistAim <= selfAim) {
      return { mode: 'self', targetId: null, ally: null };
    }
    return { mode: 'none', targetId: null, ally: null };
  }

  /** 离线：扣耐久并返回本帧治疗量；耗尽移除。 */
  function consumeDurOffline(held, dt, ally) {
    const { hands, index, stack, item } = held;
    const dur = stack.dur ?? item.maxDurability ?? 0;
    if (dur <= 0) {
      hands.takeSlot?.(index);
      window.LpInventory?.persistAndRender?.();
      return 0;
    }
    const rate = ally
      ? Number(item.allyHealPerSec) || 28
      : Number(item.selfHealPerSec) || 12;
    const costRate = Number(item.durCostPerSec) || 8;
    let amount = rate * dt;
    let cost = costRate * dt;
    if (costRate > 0 && cost > dur) {
      const scale = dur / cost;
      amount *= scale;
      cost = dur;
    }
    const next = Math.max(0, Math.round(dur - cost));
    if (next <= 0) {
      hands.takeSlot?.(index);
    } else {
      hands.updateSlot?.(index, { dur: next });
    }
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    return amount;
  }

  /** 离线：整箱消耗（濒死队友复活；单机无真实队友时仅清箱）。 */
  function consumeWholeMedkitOffline(held) {
    const { hands, index } = held;
    hands.takeSlot?.(index);
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
  }

  /**
   * 每帧：若按住开火且持医疗箱，按瞄准解析目标并治疗 / 复活濒死队友。
   * @param {number} dt
   * @param {{ fireHeld: boolean, aimX: number, aimY: number, selfX: number, selfY: number, remotes?: object[], localUserId?: string }} ctx
   */
  function tick(dt, ctx = {}) {
    if (!ctx.fireHeld || !isHoldingMedkit()) {
      lastMode = null;
      reviveSent = false;
      return null;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      lastMode = null;
      return null;
    }
    const held = getHeldMedkitSlot();
    if (!held) return null;
    const target = resolveHealTarget(
      ctx.aimX,
      ctx.aimY,
      ctx.selfX,
      ctx.selfY,
      ctx.remotes
    );
    if (target.mode === 'none') {
      lastMode = null;
      reviveSent = false;
      return null;
    }

    const allyDowned =
      target.mode === 'ally' && target.ally && target.ally._lpLifeState === 'downed';

    if (allyDowned) {
      lastMode = 'revive';
      const online = Boolean(window.LpInventoryNet?.isActive?.());
      if (online) {
        if (reviveSent) return { mode: 'revive', pending: true };
        reviveSent = true;
        window.dispatchEvent(
          new CustomEvent('lp:revive', {
            detail: {
              targetId: target.targetId,
              handIndex: held.index,
            },
          })
        );
        return { mode: 'revive', online: true };
      }
      // 离线：无真实队友权威态，仅消耗医箱占位
      consumeWholeMedkitOffline(held);
      return { mode: 'revive', offline: true };
    }

    reviveSent = false;
    lastMode = target.mode;
    const online = Boolean(window.LpInventoryNet?.isActive?.());
    if (online) {
      netAccum += dt;
      if (netAccum < NET_INTERVAL) return { mode: target.mode, pending: true };
      const sendDt = netAccum;
      netAccum = 0;
      window.dispatchEvent(
        new CustomEvent('lp:heal', {
          detail: {
            targetId: target.mode === 'ally' ? target.targetId : null,
            handIndex: held.index,
            dt: sendDt,
            aimX: ctx.aimX,
            aimY: ctx.aimY,
          },
        })
      );
      return { mode: target.mode, online: true };
    }
    const amount = consumeDurOffline(held, dt, target.mode === 'ally');
    if (amount > 0 && target.mode === 'self') {
      window.LpGame?.heal?.(amount);
    }
    if (amount > 0 && target.mode === 'ally' && target.ally) {
      const hp = Number(target.ally._lpHp);
      if (Number.isFinite(hp)) {
        const maxHp = Number(target.ally._lpMaxHp) || 100;
        target.ally._lpHp = Math.min(maxHp, hp + amount);
      }
    }
    return { mode: target.mode, amount };
  }

  /** 应用服务端广播的治疗（目标为本地时回血）。 */
  function applyHealed(detail) {
    const targetId = String(detail?.targetId || '');
    const localId = String(window.LpGame?.getLocalAvatar?.()?.id || document.body.dataset.userId || '');
    const amount = Number(detail?.amount) || 0;
    if (amount <= 0) return;
    if (targetId && targetId === localId) {
      window.LpGame?.heal?.(amount);
    }
  }

  window.LpMedkit = {
    HAND_SLOT_INDEX,
    getHeldMedkitSlot,
    isHoldingMedkit,
    resolveHealTarget,
    tick,
    applyHealed,
    getLastMode: () => lastMode,
  };
})();
