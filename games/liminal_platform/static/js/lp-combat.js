/**
 * 阈限月台战斗层：瞄准开火、弹道示意，供步枪 / 火炮后续接入。
 * 当前为占位步枪：冷却 + 曳光线，无伤害判定。
 */
(() => {
  const DEFAULT_COOLDOWN = 0.22;
  const TRACE_LIFE = 0.12;
  const TRACE_LENGTH = 520;

  const state = {
    cooldown: 0,
    weaponId: 'rifle_stub',
    shots: [],
  };

  /** 当前武器冷却间隔。 */
  function getCooldown() {
    if (state.weaponId === 'cannon_stub') return 0.85;
    return DEFAULT_COOLDOWN;
  }

  /** 归一化方向；零向量时按朝向回退。 */
  function normalizeDir(dirX, dirY, facing) {
    const len = Math.hypot(dirX, dirY);
    if (len < 0.001) {
      return { x: facing >= 0 ? 1 : -1, y: 0 };
    }
    return { x: dirX / len, y: dirY / len };
  }

  /**
   * 尝试开火。
   * @returns {object|null} 开火快照，冷却中返回 null
   */
  function tryFire(options = {}) {
    if (state.cooldown > 0) return null;
    const facing = options.facing >= 0 ? 1 : -1;
    const originX = options.originX ?? 0;
    const originY = options.originY ?? 0;
    const dir = normalizeDir(options.dirX ?? facing, options.dirY ?? 0, facing);
    const range = options.range ?? TRACE_LENGTH;

    const shot = {
      originX,
      originY,
      dirX: dir.x,
      dirY: dir.y,
      endX: originX + dir.x * range,
      endY: originY + dir.y * range,
      life: TRACE_LIFE,
      weaponId: state.weaponId,
    };
    state.shots.push(shot);
    state.cooldown = getCooldown();

    const payload = {
      originX,
      originY,
      dirX: dir.x,
      dirY: dir.y,
      weaponId: state.weaponId,
      range,
    };
    window.dispatchEvent(new CustomEvent('lp:weapon-fired', { detail: payload }));
    return payload;
  }

  /** 推进冷却与曳光寿命。 */
  function tick(dt) {
    if (state.cooldown > 0) state.cooldown = Math.max(0, state.cooldown - dt);
    for (let i = state.shots.length - 1; i >= 0; i -= 1) {
      state.shots[i].life -= dt;
      if (state.shots[i].life <= 0) state.shots.splice(i, 1);
    }
  }

  /** 在世界坐标层绘制曳光（调用方已设好 transform）。 */
  function draw(ctx) {
    for (const shot of state.shots) {
      const alpha = Math.max(0, shot.life / TRACE_LIFE);
      ctx.save();
      ctx.strokeStyle = `rgba(253, 224, 71, ${0.25 + alpha * 0.7})`;
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(shot.originX, shot.originY);
      ctx.lineTo(shot.endX, shot.endY);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.beginPath();
      ctx.arc(shot.originX, shot.originY, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** 切换占位武器（后续接真实武器表）。 */
  function setWeapon(weaponId) {
    state.weaponId = weaponId || 'rifle_stub';
  }

  /** 是否可开火。 */
  function canFire() {
    return state.cooldown <= 0;
  }

  window.LpCombat = {
    tryFire,
    tick,
    draw,
    setWeapon,
    canFire,
    getWeaponId: () => state.weaponId,
  };
})();
