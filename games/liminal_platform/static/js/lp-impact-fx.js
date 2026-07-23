/**
 * 可复用命中特效：尘土喷溅（Canvas 2D 粒子）。
 * 任意武器 / 表面经 spawnDust 调用；不绑定单一枪械。
 */
(() => {
  const MAX_PARTICLES = 280;
  const SURFACE_PRESETS = {
    underside: {
      count: 9,
      life: [0.22, 0.42],
      speed: [40, 120],
      size: [2.2, 5.5],
      gravity: 280,
      colors: [
        [120, 92, 68],
        [90, 70, 52],
        [70, 56, 44],
        [150, 120, 90],
      ],
      spread: 0.85,
      lift: 0.35,
    },
    ground: {
      count: 12,
      life: [0.28, 0.55],
      speed: [50, 150],
      size: [2.5, 7],
      gravity: 360,
      colors: [
        [160, 140, 110],
        [130, 110, 85],
        [100, 88, 70],
        [180, 160, 130],
      ],
      spread: 1.05,
      lift: 0.55,
    },
    generic: {
      count: 8,
      life: [0.2, 0.4],
      speed: [35, 100],
      size: [2, 5],
      gravity: 300,
      colors: [
        [140, 120, 100],
        [110, 95, 75],
      ],
      spread: 0.9,
      lift: 0.4,
    },
  };

  const particles = [];

  /** 在 [lo, hi] 均匀随机。 */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /** 解析表面预设键。 */
  function resolvePreset(surface) {
    if (surface && SURFACE_PRESETS[surface]) return SURFACE_PRESETS[surface];
    return SURFACE_PRESETS.generic;
  }

  /**
   * 在世界坐标生成短促尘土喷溅。
   * opts.surface: 'underside' | 'ground' | 'generic'
   * opts.dirX/dirY: 入射方向（喷溅沿法线反弹侧散开）
   * opts.scale: 整体缩放（数量/尺寸/速度）
   * opts.count: 覆盖粒子数
   * opts.intensity: 0–1，缩放数量与速度
   */
  function spawnDust(x, y, opts = {}) {
    const preset = resolvePreset(opts.surface);
    const scale = opts.scale != null ? opts.scale : 1;
    const intensity =
      opts.intensity != null ? Math.max(0, Math.min(1, opts.intensity)) : 1;
    const count =
      opts.count != null
        ? Math.max(0, Math.floor(opts.count))
        : Math.max(1, Math.round(preset.count * scale * (0.55 + 0.45 * intensity)));

    let nx = 0;
    let ny = -1;
    const dx = opts.dirX ?? 0;
    const dy = opts.dirY ?? 1;
    const len = Math.hypot(dx, dy);
    if (len > 0.001) {
      /* 入射单位向量的反方向作主喷溅轴，并略抬起 */
      nx = -dx / len;
      ny = -dy / len;
      const lift = preset.lift;
      ny -= lift;
      const nLen = Math.hypot(nx, ny) || 1;
      nx /= nLen;
      ny /= nLen;
    }

    for (let i = 0; i < count; i += 1) {
      if (particles.length >= MAX_PARTICLES) particles.shift();
      const ang = (Math.random() - 0.5) * Math.PI * preset.spread;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const rx = nx * c - ny * s;
      const ry = nx * s + ny * c;
      const spd = randRange(preset.speed[0], preset.speed[1]) * scale * (0.6 + 0.4 * intensity);
      const rgb = preset.colors[(Math.random() * preset.colors.length) | 0];
      particles.push({
        x: x + (Math.random() - 0.5) * 4 * scale,
        y: y + (Math.random() - 0.5) * 2 * scale,
        vx: rx * spd + (Math.random() - 0.5) * 28 * scale,
        vy: ry * spd + (Math.random() - 0.5) * 20 * scale,
        life: randRange(preset.life[0], preset.life[1]) * (0.85 + 0.2 * scale),
        age: 0,
        size: randRange(preset.size[0], preset.size[1]) * scale,
        gravity: preset.gravity,
        r: rgb[0],
        g: rgb[1],
        b: rgb[2],
        alpha: 0.55 + Math.random() * 0.35,
      });
    }
  }

  /** 推进尘土粒子寿命与运动。 */
  function tick(dt) {
    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-1.8 * dt);
    }
  }

  /** 在世界坐标层绘制尘土（径向软点）。 */
  function draw(ctx) {
    for (const p of particles) {
      const t = p.age / p.life;
      const fade = (1 - t) * (t < 0.08 ? t / 0.08 : 1);
      const a = p.alpha * fade;
      if (a <= 0.01) continue;
      const r = Math.max(0.4, p.size * (1 - t * 0.4));
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
      grad.addColorStop(0, `rgba(${p.r},${p.g},${p.b},${a})`);
      grad.addColorStop(0.55, `rgba(${p.r},${p.g},${p.b},${a * 0.45})`);
      grad.addColorStop(1, `rgba(${p.r},${p.g},${p.b},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** 清空全部粒子。 */
  function clear() {
    particles.length = 0;
  }

  window.LpImpactFx = {
    spawnDust,
    tick,
    draw,
    clear,
    SURFACE_PRESETS,
  };
})();
