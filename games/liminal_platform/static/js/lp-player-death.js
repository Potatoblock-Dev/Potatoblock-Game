/**
 * 玩家生命态：alive →（联机）downed 濒死 → dead → 仓储重生；或队友医箱复活。
 *
 * 单机 / 房内无队友：HP≤0 直接 dead（跳过濒死）。
 * 濒死时长：默认 10s；倒下瞬间半径内有队友则为 15s（半径同 allyDeathRadius）。
 * 长按空格/移动端开火 3s = 重新部署（放弃濒死→dead→仓储重生）；附近友军压力 +20。
 * 计时耗尽最终死亡：附近友军压力 +100。进入濒死 / 医箱复活：附近不加压力。
 * 联机 lifeState / downedRemain 经 pose 透传；医箱复活经 revive 消息（库存权威扣箱）。
 */
(() => {
  /** @typedef {'alive'|'downed'|'dead'} LifeState */

  const RESPAWN_INPUT_DELAY = 3;
  const RESPAWN_INVULN = 0.9;
  /** 濒死默认时长（秒）。 */
  const DOWNED_DURATION_DEFAULT = 10;
  /** 倒下时附近有队友时的濒死时长（秒）。 */
  const DOWNED_DURATION_NEAR_ALLY = 15;
  /** 重新部署长按（秒）。 */
  const REDEPLOY_HOLD = 3;
  /** 医箱/复活回血比例（相对 max HP）。 */
  const REVIVE_HP_FRAC = 0.2;
  const ALLY_DEATH_RADIUS_MUL = 1.5;
  const DOWNED_LEAN = 1.32;
  const REVIVE_PRESSURE_ALLY = 80;
  const REDEPLOY_NEARBY_PRESSURE = 20;
  const FINAL_DEATH_NEARBY_PRESSURE = 100;

  /** @type {LifeState} */
  let lifeState = 'alive';
  let deathElapsed = 0;
  let deathWorldX = 0;
  let downedRemain = 0;
  let downedDuration = DOWNED_DURATION_DEFAULT;
  /** 进入濒死时记录的压力（复活加压基数）。 */
  let pressureAtDowned = 0;
  let redeployHold = 0;
  /** @type {'timer'|'redeploy'|'solo'} */
  let deathCause = 'timer';
  let hintEl = null;
  let washEl = null;
  let redeployEl = null;
  /** @type {Map<string, string>} 远端上一帧 lifeState，用于附近加压边沿。 */
  const allyLifeSeen = new Map();

  /** 友军死亡/重新部署加压半径（≈1.5×车厢对接间距）。 */
  function allyDeathRadius() {
    const join = window.LiminalCarriageSpec?.COUPLER_JOIN_OFFSET;
    if (join != null && Number.isFinite(join) && join > 0) {
      return join * ALLY_DEATH_RADIUS_MUL;
    }
    return 2000;
  }

  /** 联机且存在至少一名在线远端队友时启用濒死。 */
  function shouldUseDowned() {
    if (!window.LiminalSession?.isConnected?.()) return false;
    const remotes = window.LiminalSession?.remotes?.();
    if (!remotes) return false;
    for (const remote of remotes.values()) {
      if (remote && !remote._lpDisconnected) return true;
    }
    return false;
  }

  /**
   * 世界 X 处半径内是否有其他在线玩家。
   * @param {number} worldX
   * @param {number} [radius]
   */
  function hasNearbyAlly(worldX, radius = allyDeathRadius()) {
    const remotes = window.LiminalSession?.remotes?.();
    if (!remotes) return false;
    const lx = Number(worldX);
    if (!Number.isFinite(lx)) return false;
    for (const remote of remotes.values()) {
      if (!remote || remote._lpDisconnected) continue;
      const rx = Number(remote.x);
      if (!Number.isFinite(rx)) continue;
      if (Math.abs(rx - lx) <= radius) return true;
    }
    return false;
  }

  /** 倒下瞬间选定濒死时长。 */
  function pickDownedDuration(worldX) {
    return hasNearbyAlly(worldX) ? DOWNED_DURATION_NEAR_ALLY : DOWNED_DURATION_DEFAULT;
  }

  function ensureHintEl() {
    if (hintEl && hintEl.isConnected) return hintEl;
    const host = document.querySelector('.lp-stage-ui') || document.querySelector('.lp-stage');
    if (!host) return null;
    hintEl = document.getElementById('lpRespawnHint');
    if (!hintEl) {
      hintEl = document.createElement('p');
      hintEl.id = 'lpRespawnHint';
      hintEl.className = 'lp-respawn-hint';
      hintEl.setAttribute('aria-live', 'polite');
      hintEl.hidden = true;
      hintEl.textContent = '按任意键重生';
      host.appendChild(hintEl);
    }
    return hintEl;
  }

  function ensureWashEl() {
    if (washEl && washEl.isConnected) return washEl;
    const stage = document.querySelector('.lp-stage');
    if (!stage) return null;
    washEl = document.getElementById('lpDownedWash');
    if (!washEl) {
      washEl = document.createElement('div');
      washEl.id = 'lpDownedWash';
      washEl.className = 'lp-downed-wash';
      washEl.setAttribute('aria-hidden', 'true');
      stage.appendChild(washEl);
    }
    return washEl;
  }

  function ensureRedeployEl() {
    if (redeployEl && redeployEl.isConnected) return redeployEl;
    const host = document.querySelector('.lp-stage-ui') || document.querySelector('.lp-stage');
    if (!host) return null;
    redeployEl = document.getElementById('lpRedeployHint');
    if (!redeployEl) {
      redeployEl = document.createElement('div');
      redeployEl.id = 'lpRedeployHint';
      redeployEl.className = 'lp-redeploy-hint';
      redeployEl.hidden = true;
      redeployEl.innerHTML =
        '<p class="lp-redeploy-label">长按空格重新部署</p><div class="lp-redeploy-bar"><span class="lp-redeploy-fill"></span></div>';
      host.appendChild(redeployEl);
    }
    return redeployEl;
  }

  /** @param {boolean} visible */
  function setHintVisible(visible) {
    const el = ensureHintEl();
    if (el) el.hidden = !visible;
  }

  /** @param {boolean} on */
  function setDownedWash(on) {
    const el = ensureWashEl();
    if (!el) return;
    el.classList.toggle('is-on', Boolean(on));
  }

  /**
   * 更新重新部署进度 UI。
   * @param {number} progress 0…1；≤0 隐藏
   * @param {boolean} mobile
   */
  function setRedeployProgress(progress, mobile) {
    const el = ensureRedeployEl();
    if (!el) return;
    const p = Math.max(0, Math.min(1, Number(progress) || 0));
    if (p <= 0) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const label = el.querySelector('.lp-redeploy-label');
    if (label) {
      label.textContent = mobile ? '长按开火键重新部署' : '长按空格重新部署';
    }
    const fill = el.querySelector('.lp-redeploy-fill');
    if (fill) fill.style.transform = `scaleX(${p})`;
  }

  /**
   * @param {number} fromX
   * @returns {number}
   */
  function nearestStorageSpawnX(fromX) {
    const Spec = window.LiminalCarriageSpec;
    if (typeof Spec?.nearestStorageSpawnX === 'function') {
      return Spec.nearestStorageSpawnX(fromX);
    }
    if (typeof Spec?.defaultSpawnX === 'function') return Spec.defaultSpawnX('storage');
    return fromX;
  }

  /**
   * @param {object} entity
   * @param {number} [dt]
   */
  function applyDownedPose(entity, dt = 0.016) {
    if (!entity) return;
    entity.kneel = Math.min(1, (Number(entity.kneel) || 0) + dt * 5);
    entity.moveDirection = 0;
    entity.gait = 'walk';
    entity.headLook = 0;
    entity.headLookVelocity = 0;
    const facing = (entity.facing || 1) >= 0 ? 1 : -1;
    const target = facing * DOWNED_LEAN;
    const k = Math.min(1, dt * 6);
    entity.lean = (Number(entity.lean) || 0) + (target - (Number(entity.lean) || 0)) * k;
    entity.leanVelocity = 0;
    entity.squash = Math.max(Number(entity.squash) || 0, 0.12);
  }

  /** @param {object} entity */
  function clearDownedPose(entity) {
    if (!entity) return;
    entity.kneel = 0;
    entity.lean = 0;
    entity.leanVelocity = 0;
    entity.squash = 0;
    entity.squashVelocity = 0;
  }

  /**
   * HP≤0 入口：联机有队友 → 濒死；否则直接最终死亡。
   * @param {{ x: number, exitTurret?: () => void }} ctx
   */
  function onLethalHit(ctx) {
    if (lifeState !== 'alive') return;
    if (typeof ctx?.exitTurret === 'function') ctx.exitTurret();
    else if (window.LpGuardTurret?.isManned?.()) window.LpGuardTurret.exitTurret();
    deathWorldX = Number(ctx?.x) || 0;
    pressureAtDowned = Number(window.LpPressure?.getPressure?.()) || 0;
    if (shouldUseDowned()) {
      enterDowned(deathWorldX);
    } else {
      enterDead({ cause: 'solo' });
    }
  }

  /**
   * 进入濒死（附近友军不加压力）。
   * @param {number} worldX
   */
  function enterDowned(worldX) {
    lifeState = 'downed';
    deathWorldX = Number(worldX) || deathWorldX;
    downedDuration = pickDownedDuration(deathWorldX);
    downedRemain = downedDuration;
    redeployHold = 0;
    deathElapsed = 0;
    setHintVisible(false);
    setDownedWash(true);
    setRedeployProgress(0, false);
    syncDownedHud();
  }

  /**
   * 进入最终死亡（倒地等待重生输入）。
   * cause 写入 pose；远端 watchAllyDeaths 按 redeploy→+20 / 其它→+100。
   * @param {{ cause?: 'timer'|'redeploy'|'solo' }} [opts]
   */
  function enterDead(opts) {
    deathCause = opts?.cause || 'timer';
    lifeState = 'dead';
    downedRemain = 0;
    redeployHold = 0;
    deathElapsed = 0;
    setDownedWash(false);
    setRedeployProgress(0, false);
    setHintVisible(false);
    syncDownedHud();
  }

  function getLifeState() {
    return lifeState;
  }

  function isDowned() {
    return lifeState === 'downed';
  }

  function isDead() {
    return lifeState === 'dead';
  }

  /** 不可移动/开火（濒死或最终死亡）。 */
  function isIncapacitated() {
    return lifeState === 'downed' || lifeState === 'dead';
  }

  function canAcceptRespawnInput() {
    return lifeState === 'dead' && deathElapsed >= RESPAWN_INPUT_DELAY;
  }

  function getDownedRemain() {
    return lifeState === 'downed' ? downedRemain : 0;
  }

  function getDownedDuration() {
    return downedDuration;
  }

  function getPressureAtDowned() {
    return pressureAtDowned;
  }

  /** 刷新本机白色倒计时条 / 清回普通 HP。 */
  function syncDownedHud() {
    if (lifeState === 'downed') {
      window.LpHudVitals?.syncDownedCountdown?.(downedRemain, downedDuration);
    } else {
      window.LpHudVitals?.clearDownedCountdown?.();
    }
  }

  /**
   * 是否按住重新部署键：桌面 Space；触屏开火键。
   * @param {{ keys?: Set<string>, coarse?: boolean }} input
   */
  function isRedeployHeld(input = {}) {
    if (input.coarse) {
      return Boolean(
        window.LpTouchControls?.isFireHeld?.() ||
          window.LpTouchControls?.read?.()?.fire
      );
    }
    const keys = input.keys;
    return Boolean(keys && (keys.has('Space') || keys.has('Spacebar')));
  }

  /**
   * 濒死/死亡每帧。
   * @param {number} dt
   * @param {{
   *   avatar?: object,
   *   keys?: Set<string>,
   *   coarse?: boolean,
   *   onTimerExpire?: () => void,
   *   onRedeployComplete?: () => void,
   * }} [ctx]
   */
  function tick(dt, ctx = {}) {
    if (lifeState === 'alive') {
      setDownedWash(false);
      setRedeployProgress(0, false);
      return;
    }

    const step = Math.max(0, Number(dt) || 0);
    if (ctx.avatar) applyDownedPose(ctx.avatar, step);

    if (lifeState === 'downed') {
      downedRemain = Math.max(0, downedRemain - step);
      syncDownedHud();
      setDownedWash(true);

      if (isRedeployHeld(ctx)) {
        redeployHold = Math.min(REDEPLOY_HOLD, redeployHold + step);
        setRedeployProgress(redeployHold / REDEPLOY_HOLD, Boolean(ctx.coarse));
        if (redeployHold >= REDEPLOY_HOLD) {
          redeployHold = 0;
          setRedeployProgress(0, false);
          enterDead({ cause: 'redeploy' });
          ctx.onRedeployComplete?.();
          return;
        }
      } else {
        redeployHold = 0;
        setRedeployProgress(0, false);
      }

      if (downedRemain <= 0) {
        enterDead({ cause: 'timer' });
        ctx.onTimerExpire?.();
      }
      return;
    }

    // dead
    deathElapsed += step;
    setHintVisible(canAcceptRespawnInput());
  }

  /**
   * @param {KeyboardEvent|PointerEvent|MouseEvent} event
   * @param {object} hooks
   * @returns {boolean}
   */
  function tryRespawnFromEvent(event, hooks) {
    if (!canAcceptRespawnInput() || !hooks) return false;
    if (event instanceof KeyboardEvent) {
      const t = event.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
    } else if (event && typeof event.button === 'number') {
      if (event.button !== 0 && event.button !== 2) return false;
    } else {
      return false;
    }
    respawn(hooks);
    return true;
  }

  /**
   * 传送最近仓储、满血、清状态。
   * @param {{
   *   local: { x: number, y: number, vx: number, vy: number, onGround: boolean, kneel: number },
   *   avatar: object,
   *   restoreHp: () => void,
   *   syncPose: () => void,
   *   setInvuln: (t: number) => void,
   * }} hooks
   */
  function respawn(hooks) {
    if (lifeState !== 'dead') return;
    const spawnX = nearestStorageSpawnX(deathWorldX);
    hooks.local.x = spawnX;
    hooks.local.y = 0;
    hooks.local.vx = 0;
    hooks.local.vy = 0;
    hooks.local.onGround = true;
    hooks.local.kneel = 0;
    clearDownedPose(hooks.avatar);
    hooks.restoreHp();
    hooks.setInvuln(RESPAWN_INVULN);
    lifeState = 'alive';
    deathElapsed = 0;
    downedRemain = 0;
    redeployHold = 0;
    setHintVisible(false);
    setDownedWash(false);
    setRedeployProgress(0, false);
    syncDownedHud();
    hooks.syncPose();
  }

  /**
   * 被队友医箱复活（本地为目标时）。
   * @param {{
   *   maxHp: number,
   *   setHp: (hp: number) => void,
   *   avatar: object,
   *   local: { kneel: number },
   *   syncPose: () => void,
   *   setInvuln: (t: number) => void,
   * }} hooks
   */
  function applyAllyRevive(hooks) {
    if (lifeState !== 'downed') return false;
    const maxHp = Math.max(1, Number(hooks.maxHp) || 100);
    hooks.setHp(Math.max(1, Math.round(maxHp * REVIVE_HP_FRAC)));
    const nextP = pressureAtDowned + REVIVE_PRESSURE_ALLY;
    window.LpPressure?.setPressure?.(nextP, hooks.local?.x);
    hooks.local.kneel = 0;
    clearDownedPose(hooks.avatar);
    lifeState = 'alive';
    downedRemain = 0;
    redeployHold = 0;
    setDownedWash(false);
    setRedeployProgress(0, false);
    setHintVisible(false);
    syncDownedHud();
    hooks.setInvuln?.(RESPAWN_INVULN * 0.5);
    hooks.syncPose();
    return true;
  }

  /**
   * 复活者减压：若压力 &gt;20，最多 −20，不低于 20。
   * @param {number} [localX]
   */
  function applyReviverPressureRelief(localX) {
    const P = window.LpPressure;
    if (!P?.getPressure || !P?.setPressure) return;
    const cur = Number(P.getPressure()) || 0;
    if (cur <= 20) return;
    P.setPressure(Math.max(20, cur - 20), localX);
  }

  /**
   * 扫描远端 lifeState 边沿：dead 且 cause=redeploy → +20；dead 其它 → +100。
   * 不响应 downed 进入。
   * @param {number} localX
   */
  function watchAllyDeaths(localX) {
    const remotes = window.LiminalSession?.remotes?.();
    if (!remotes || typeof remotes.entries !== 'function') return;
    const radius = allyDeathRadius();
    const lx = Number(localX);
    const seenIds = new Set();

    for (const [id, remote] of remotes.entries()) {
      const pid = String(id);
      seenIds.add(pid);
      if (!remote || remote._lpDisconnected) {
        allyLifeSeen.delete(pid);
        continue;
      }
      const state = String(remote._lpLifeState || 'alive');
      const prev = allyLifeSeen.get(pid);
      allyLifeSeen.set(pid, state);
      if (prev == null || prev === 'dead' || state !== 'dead') continue;
      // prev 为 alive 或 downed → dead
      const rx = Number(remote.x);
      if (!Number.isFinite(rx) || !Number.isFinite(lx)) continue;
      if (Math.abs(rx - lx) > radius) continue;
      const cause = String(remote._lpDeathCause || 'timer');
      if (cause === 'redeploy') {
        window.LpPressure?.noteAllyRedeployNearby?.(lx);
      } else {
        window.LpPressure?.noteAllyDeathNearby?.(lx);
      }
    }

    for (const id of [...allyLifeSeen.keys()]) {
      if (!seenIds.has(id)) allyLifeSeen.delete(id);
    }
  }

  /** 供 pose 上报（lifeState / downedRemain / deathCause）。 */
  function poseExtras() {
    if (lifeState === 'alive') {
      return { lifeState: 'alive', downedRemain: null, deathCause: null };
    }
    if (lifeState === 'downed') {
      return {
        lifeState: 'downed',
        downedRemain: Math.max(0, downedRemain),
        deathCause: null,
      };
    }
    return {
      lifeState: 'dead',
      downedRemain: 0,
      deathCause,
    };
  }

  window.LpPlayerDeath = {
    RESPAWN_INPUT_DELAY,
    RESPAWN_INVULN,
    DOWNED_DURATION_DEFAULT,
    DOWNED_DURATION_NEAR_ALLY,
    REDEPLOY_HOLD,
    REVIVE_HP_FRAC,
    REVIVE_PRESSURE_ALLY,
    REDEPLOY_NEARBY_PRESSURE,
    FINAL_DEATH_NEARBY_PRESSURE,
    ALLY_DEATH_RADIUS_MUL,
    allyDeathRadius,
    hasNearbyAlly,
    nearestStorageSpawnX,
    applyDownedPose,
    clearDownedPose,
    onLethalHit,
    enterDowned,
    enterDead,
    getLifeState,
    isDowned,
    isDead,
    isIncapacitated,
    canAcceptRespawnInput,
    getDownedRemain,
    getDownedDuration,
    getPressureAtDowned,
    tick,
    tryRespawnFromEvent,
    respawn,
    applyAllyRevive,
    applyReviverPressureRelief,
    watchAllyDeaths,
    poseExtras,
    shouldUseDowned,
  };
})();
