/**
 * 医疗箱 / 急救箱：手部 3 号槽持用。
 * - 医疗箱 medkit：开火键对准自己或近距队友持续治疗并扣耐久。
 * - 急救箱 first_aid_kit：瞄准濒死队友开火，消耗整箱复活。
 * 联机：heal / revive 意图由服务端校验。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const HAND_SLOT_INDEX = 2;
  const NET_INTERVAL = 0.1;

  let netAccum = 0;
  let lastMode = null;
  let reviveSent = false;

  /**
   * 取手部医疗类工具槽。
   * @param {'heal'|'revive'|'any'} purpose
   */
  function getHeldMedicalSlot(purpose = 'any') {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    const order = [];
    if (preferred === 0 || preferred === 1 || preferred === 2) order.push(preferred);
    if (!order.includes(HAND_SLOT_INDEX)) order.push(HAND_SLOT_INDEX);
    for (const index of order) {
      if (index >= hands.size()) continue;
      if (hands.isCovered?.(index)) continue;
      let stack = hands.getSlot(index);
      if (!stack || !Catalog.isMedicalTool?.(stack.itemId)) continue;
      const item = Catalog.getItem(stack.itemId);
      if (!item) continue;
      if (preferred != null && preferred !== index) continue;
      if (purpose === 'heal' && !item.canHeal) continue;
      if (purpose === 'revive' && !item.canRevive) continue;
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

  /** 当前选中手部槽上的医疗箱（回血）。 */
  function getHeldMedkitSlot() {
    return getHeldMedicalSlot('heal');
  }

  /** 当前选中手部槽上的急救箱（复活）。 */
  function getHeldFirstAidSlot() {
    return getHeldMedicalSlot('revive');
  }

  /** 是否正持用医疗箱或急救箱（开火改走医疗逻辑）。 */
  function isHoldingMedkit() {
    return Boolean(getHeldMedicalSlot('any'));
  }

  /**
   * 根据瞄准点解析目标：近距队友优先，否则自身。
   * @returns {{ mode: 'self'|'ally'|'none', targetId: string|null, ally: object|null }}
   */
  function resolveHealTarget(aimX, aimY, selfX, selfY, remotes, item) {
    if (!item) return { mode: 'none', targetId: null, ally: null };
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

  /** 离线扣医疗箱耐久并返回本帧治疗量。 */
  function consumeDurOffline(held, dt, ally) {
    const { hands, index, stack, item } = held;
    let dur = Number(stack.dur);
    if (!Number.isFinite(dur)) dur = Number(item.maxDurability) || 0;
    if (dur <= 0) {
      hands.takeSlot?.(index);
      window.LpInventory?.persistAndRender?.();
      window.LpHandsHud?.render?.();
      return 0;
    }
    const rate = Number(ally ? item.allyHealPerSec : item.selfHealPerSec) || 0;
    const costRate = Number(item.durCostPerSec) || 0;
    let amount = rate * dt;
    let durCost = costRate * dt;
    if (costRate > 0 && durCost > dur) {
      const scale = dur / durCost;
      amount *= scale;
      durCost = dur;
    }
    const nextDur = Math.max(0, Math.round(dur - durCost));
    if (nextDur <= 0) {
      hands.takeSlot?.(index);
    } else {
      hands.updateSlot?.(index, { dur: nextDur });
    }
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    return amount;
  }

  /** 离线消耗整箱急救箱。 */
  function consumeWholeKitOffline(held) {
    const { hands, index } = held;
    hands.takeSlot?.(index);
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
  }

  /**
   * 每帧：持医疗类工具且按住开火 → 回血或复活。
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

    const firstAid = getHeldFirstAidSlot();
    const medkit = getHeldMedkitSlot();
    const probeItem = firstAid?.item || medkit?.item;
    if (!probeItem) return null;

    const target = resolveHealTarget(
      ctx.aimX,
      ctx.aimY,
      ctx.selfX,
      ctx.selfY,
      ctx.remotes,
      probeItem
    );
    if (target.mode === 'none') {
      lastMode = null;
      reviveSent = false;
      return null;
    }

    const allyDowned =
      target.mode === 'ally' && target.ally && target.ally._lpLifeState === 'downed';

    if (allyDowned) {
      if (!firstAid) {
        lastMode = null;
        reviveSent = false;
        return { mode: 'need_first_aid' };
      }
      lastMode = 'revive';
      const online = Boolean(window.LpInventoryNet?.isActive?.());
      if (online) {
        if (reviveSent) return { mode: 'revive', pending: true };
        reviveSent = true;
        window.dispatchEvent(
          new CustomEvent('lp:revive', {
            detail: {
              targetId: target.targetId,
              handIndex: firstAid.index,
            },
          })
        );
        return { mode: 'revive', online: true };
      }
      consumeWholeKitOffline(firstAid);
      return { mode: 'revive', offline: true };
    }

    reviveSent = false;
    if (!medkit) {
      lastMode = null;
      return { mode: 'need_medkit' };
    }

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
            handIndex: medkit.index,
            dt: sendDt,
            aimX: ctx.aimX,
            aimY: ctx.aimY,
          },
        })
      );
      return { mode: target.mode, online: true };
    }
    const amount = consumeDurOffline(medkit, dt, target.mode === 'ally');
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
    getHeldFirstAidSlot,
    isHoldingMedkit,
    resolveHealTarget,
    tick,
    applyHealed,
    getLastMode: () => lastMode,
  };
})();
