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
  /** 急救箱成功复活 / 整箱消耗生效时的治疗音效（与医疗箱持续治疗无关）。 */
  const FIRST_AID_SUCCESS_SFX =
    '/static/games/liminal-platform/audio/items/first-aid-heal.wav?v=1';
  /** 对齐换弹 / UI 道具音量量级。 */
  const FIRST_AID_SUCCESS_VOLUME = 0.62;
  /**
   * 医疗箱持续治疗循环（湖水滴下无缝 loop）；与急救箱 one-shot 路径分离。
   * @see static/audio/items/medkit-heal-loop.PROCESSING.txt
   */
  const MEDKIT_HEAL_LOOP_SFX =
    '/static/games/liminal-platform/audio/items/medkit-heal-loop.wav?v=1';
  /** 软环境层；低于急救箱确认音，贴近道具 ambient。 */
  const MEDKIT_HEAL_LOOP_VOLUME = 0.38;

  let netAccum = 0;
  let lastMode = null;
  let reviveSent = false;
  let healLoopWanted = false;
  /** 递增以作废 in-flight startLoop（松手早于 decode 完成时）。 */
  let healLoopEpoch = 0;

  /** 播放急救箱生效 SFX（本地确认音，不走距离衰减）。 */
  function playFirstAidSuccessSfx() {
    window.LpSfx?.play?.(FIRST_AID_SUCCESS_SFX, {
      volume: FIRST_AID_SUCCESS_VOLUME,
      ambient: true,
    });
  }

  /** 开始医疗箱治疗循环（同 URL 已在播则忽略）。 */
  function startMedkitHealLoop() {
    if (healLoopWanted) return;
    healLoopWanted = true;
    const epoch = healLoopEpoch;
    void window.LpSfx
      ?.startLoop?.(MEDKIT_HEAL_LOOP_SFX, {
        volume: MEDKIT_HEAL_LOOP_VOLUME,
        fadeIn: 0.1,
        ambient: true,
      })
      ?.then?.(() => {
        if (epoch !== healLoopEpoch || !healLoopWanted) {
          window.LpSfx?.stopLoop?.(MEDKIT_HEAL_LOOP_SFX, { fadeOut: 0.05 });
        }
      });
  }

  /** 淡出并停止医疗箱治疗循环（松手 / 取消 / 改走复活）。 */
  function stopMedkitHealLoop() {
    if (!healLoopWanted && !window.LpSfx?.isLooping?.(MEDKIT_HEAL_LOOP_SFX)) {
      return;
    }
    healLoopWanted = false;
    healLoopEpoch += 1;
    window.LpSfx?.stopLoop?.(MEDKIT_HEAL_LOOP_SFX, { fadeOut: 0.14 });
  }

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
   * 医疗箱有效治疗时循环滴水 SFX；松手/无目标/改复活路径时停止。
   */
  function tick(dt, ctx = {}) {
    if (!ctx.fireHeld || !isHoldingMedkit()) {
      stopMedkitHealLoop();
      lastMode = null;
      reviveSent = false;
      return null;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      stopMedkitHealLoop();
      lastMode = null;
      return null;
    }

    const firstAid = getHeldFirstAidSlot();
    const medkit = getHeldMedkitSlot();
    const probeItem = firstAid?.item || medkit?.item;
    if (!probeItem) {
      stopMedkitHealLoop();
      return null;
    }

    const target = resolveHealTarget(
      ctx.aimX,
      ctx.aimY,
      ctx.selfX,
      ctx.selfY,
      ctx.remotes,
      probeItem
    );
    if (target.mode === 'none') {
      stopMedkitHealLoop();
      lastMode = null;
      reviveSent = false;
      return null;
    }

    const allyDowned =
      target.mode === 'ally' && target.ally && target.ally._lpLifeState === 'downed';

    if (allyDowned) {
      stopMedkitHealLoop();
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
      playFirstAidSuccessSfx();
      return { mode: 'revive', offline: true };
    }

    reviveSent = false;
    if (!medkit) {
      stopMedkitHealLoop();
      lastMode = null;
      return { mode: 'need_medkit' };
    }

    startMedkitHealLoop();
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

  /**
   * 联机：服务端确认急救箱消耗并复活成功时，复活者本地播放生效音效。
   * @param {CustomEvent} event
   */
  function onPlayerRevived(event) {
    const d = event?.detail || {};
    const localId = String(
      window.LpGame?.getLocalAvatar?.()?.id || document.body.dataset.userId || ''
    );
    const byId = String(d.by || '');
    if (!localId || !byId || byId !== localId) return;
    playFirstAidSuccessSfx();
  }

  window.addEventListener('lp:player-revived', onPlayerRevived);

  // lp-sfx.js 在模板中排在本文件之后；延后一拍再预热。
  setTimeout(() => {
    window.LpSfx?.preload?.([MEDKIT_HEAL_LOOP_SFX, FIRST_AID_SUCCESS_SFX]);
  }, 0);

  window.LpMedkit = {
    HAND_SLOT_INDEX,
    getHeldMedkitSlot,
    getHeldFirstAidSlot,
    isHoldingMedkit,
    resolveHealTarget,
    tick,
    applyHealed,
    playFirstAidSuccessSfx,
    startMedkitHealLoop,
    stopMedkitHealLoop,
    getLastMode: () => lastMode,
  };
})();
