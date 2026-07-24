/**
 * 小怪死亡消散：短寿径向粒子 + 可选残影淡出（Canvas 2D，对象池）。
 * 由 LpMobs 在标记死亡时 spawn；主循环 tick/draw；不参与碰撞。
 */
(() => {
  const MAX_PARTICLES = 160;
  const MAX_GHOSTS = 12;
  /** 默认粒子寿命（秒）。 */
  const LIFE = [0.42, 0.72];
  /** 残影寿命（秒）。 */
  const GHOST_LIFE = [0.32, 0.48];

  /** @type {Array<object>} */
  const particlePool = [];
  /** @type {Array<object>} */
  const particles = [];
  /** @type {Array<object>} */
  const ghostPool = [];
  /** @type {Array<object>} */
  const ghosts = [];

  const FALLBACK_PALETTE = [
    [255, 99, 132],
    [255, 206, 86],
    [72, 219, 151],
    [77, 150, 255],
    [199, 125, 255],
  ];

  /** 在 [lo, hi] 均匀随机。 */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /** 从池取粒子对象，池空则新建。 */
  function acquireParticle() {
    return (
      particlePool.pop() || {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0.5,
        age: 0,
        size: 4,
        r: 200,
        g: 200,
        b: 200,
        alpha: 0.7,
        drag: 1.6,
      }
    );
  }

  /** 归还粒子到池（满池则丢弃）。 */
  function releaseParticle(p) {
    if (particlePool.length < MAX_PARTICLES) particlePool.push(p);
  }

  /** 从池取残影对象，池空则新建。 */
  function acquireGhost() {
    return (
      ghostPool.pop() || {
        x: 0,
        y: 0,
        life: 0.4,
        age: 0,
        radius: 20,
        r: 180,
        g: 180,
        b: 200,
        alpha: 0.55,
      }
    );
  }

  /** 归还残影到池。 */
  function releaseGhost(g) {
    if (ghostPool.length < MAX_GHOSTS) ghostPool.push(g);
  }

  /**
   * 解析调色盘：优先 opts.palette，否则泡泡默认色板。
   * @param {number[][] | undefined} palette
   * @returns {number[][]}
   */
  function resolvePalette(palette) {
    if (palette && palette.length) return palette;
    const bub = window.LpMobBubbleFill?.PALETTE;
    if (bub && bub.length) return bub;
    return FALLBACK_PALETTE;
  }

  /**
   * 在怪死亡位置生成消散粒子（外漂、缩小、淡出）与短暂残影。
   * opts.palette: RGB 数组（保龄球/气球泡泡色）
   * opts.radius: 怪半径，影响数量与散布
   * opts.count: 覆盖粒子数
   * opts.scale: 整体缩放
   * opts.ghost: 是否画残影（默认 true）
   */
  function spawnDissipate(x, y, opts = {}) {
    const palette = resolvePalette(opts.palette);
    const radius = Math.max(8, opts.radius != null ? opts.radius : 20);
    const scale = opts.scale != null ? opts.scale : 1;
    const count =
      opts.count != null
        ? Math.max(0, Math.floor(opts.count))
        : Math.max(8, Math.round(10 + radius * 0.35 * scale));
    const withGhost = opts.ghost !== false;

    if (withGhost) {
      while (ghosts.length >= MAX_GHOSTS) {
        releaseGhost(ghosts.shift());
      }
      const rgb = palette[(Math.random() * palette.length) | 0];
      const g = acquireGhost();
      g.x = x;
      g.y = y;
      g.life = randRange(GHOST_LIFE[0], GHOST_LIFE[1]);
      g.age = 0;
      g.radius = radius * (0.92 + Math.random() * 0.12) * scale;
      g.r = rgb[0];
      g.g = rgb[1];
      g.b = rgb[2];
      g.alpha = 0.42 + Math.random() * 0.18;
      ghosts.push(g);
    }

    for (let i = 0; i < count; i += 1) {
      while (particles.length >= MAX_PARTICLES) {
        releaseParticle(particles.shift());
      }
      const ang = Math.random() * Math.PI * 2;
      const spd = randRange(28, 95) * scale * (0.55 + (radius / 40) * 0.45);
      const rgb = palette[(Math.random() * palette.length) | 0];
      const p = acquireParticle();
      const jitter = radius * 0.35 * scale;
      p.x = x + (Math.random() - 0.5) * jitter;
      p.y = y + (Math.random() - 0.5) * jitter;
      p.vx = Math.cos(ang) * spd;
      p.vy = Math.sin(ang) * spd - randRange(8, 28) * scale;
      p.life = randRange(LIFE[0], LIFE[1]) * (0.9 + 0.15 * scale);
      p.age = 0;
      p.size = randRange(2.2, 5.8) * scale * (0.7 + radius / 50);
      p.r = rgb[0];
      p.g = rgb[1];
      p.b = rgb[2];
      p.alpha = 0.55 + Math.random() * 0.4;
      p.drag = 1.35 + Math.random() * 0.7;
      particles.push(p);
    }
  }

  /** 推进消散粒子与残影寿命/运动。 */
  function tick(dt) {
    if (!(dt > 0)) return;
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        releaseParticle(p);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp;
      p.vy *= damp * 0.98;
    }
    for (let i = ghosts.length - 1; i >= 0; i -= 1) {
      const g = ghosts[i];
      g.age += dt;
      if (g.age >= g.life) {
        ghosts.splice(i, 1);
        releaseGhost(g);
      }
    }
  }

  /** 在世界坐标层绘制残影与消散粒子。 */
  function draw(ctx) {
    for (const g of ghosts) {
      const t = g.age / g.life;
      const fade = (1 - t) * (1 - t);
      const a = g.alpha * fade;
      if (a <= 0.01) continue;
      const r = g.radius * (1 + t * 0.55);
      const grad = ctx.createRadialGradient(g.x, g.y, 0, g.x, g.y, r);
      grad.addColorStop(0, `rgba(${g.r},${g.g},${g.b},${a * 0.85})`);
      grad.addColorStop(0.45, `rgba(${g.r},${g.g},${g.b},${a * 0.35})`);
      grad.addColorStop(1, `rgba(${g.r},${g.g},${g.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const p of particles) {
      const t = p.age / p.life;
      const fade = (1 - t) * (t < 0.06 ? t / 0.06 : 1);
      const a = p.alpha * fade;
      if (a <= 0.01) continue;
      const r = Math.max(0.35, p.size * (1 - t * 0.85));
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, `rgba(${p.r},${p.g},${p.b},${a})`);
      grad.addColorStop(0.55, `rgba(${p.r},${p.g},${p.b},${a * 0.4})`);
      grad.addColorStop(1, `rgba(${p.r},${p.g},${p.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 清空活动粒子/残影并归还对象池。 */
  function clear() {
    while (particles.length) releaseParticle(particles.pop());
    while (ghosts.length) releaseGhost(ghosts.pop());
  }

  window.LpMobDeathFx = {
    spawnDissipate,
    tick,
    draw,
    clear,
  };
})();
