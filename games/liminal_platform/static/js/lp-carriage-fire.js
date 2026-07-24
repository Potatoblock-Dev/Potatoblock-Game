/**
 * 车厢着火（本地 VFX + 强度状态）。
 * 未来由车厢火灾事件驱动；当前仅调试/灭火器联调。
 * 权威火灾未做；联机以本地特效为主。
 */
(() => {
  const Spec = window.LiminalCarriageSpec;
  const MAX_PARTICLES = 220;
  /** 满火强度（0–1）。 */
  const FULL_INTENSITY = 1;
  /** 自然蔓延/维持：调试点燃后保持，不自动灭。 */
  const particles = [];
  /** @type {Record<string, number>} carId → intensity 0–1 */
  const fires = Object.create(null);

  /** 在 [lo, hi] 均匀随机。 */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /** 读取车厢火灾强度（0–1）。 */
  function getIntensity(carId) {
    if (!carId) return 0;
    return Math.max(0, Math.min(1, fires[carId] || 0));
  }

  /** 设置车厢火灾强度；≤0 则清除。 */
  function setIntensity(carId, value) {
    if (!carId) return 0;
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (next <= 0.001) {
      delete fires[carId];
      return 0;
    }
    fires[carId] = next;
    return next;
  }

  /** 点燃指定车厢（满火）。 */
  function igniteCar(carId, intensity = FULL_INTENSITY) {
    return setIntensity(carId, intensity);
  }

  /** 扑灭指定车厢。 */
  function extinguishCar(carId) {
    return setIntensity(carId, 0);
  }

  /** 按玩家世界 X 取当前车厢并点燃。 */
  function ignitePlayerCar(worldX) {
    const x =
      worldX != null ? Number(worldX) : Number(window.LpGame?.getLocalX?.());
    const car = Spec?.carriageAt?.(x);
    if (!car) return null;
    igniteCar(car.id, FULL_INTENSITY);
    return car.id;
  }

  /** 降低火灾强度（灭火器喷射时调用）；返回剩余强度。 */
  function reduceFire(carId, amount) {
    if (!carId || !(amount > 0)) return getIntensity(carId);
    return setIntensity(carId, getIntensity(carId) - amount);
  }

  /** 是否有任意车厢着火。 */
  function hasAnyFire() {
    return Object.keys(fires).length > 0;
  }

  /** 列出着火车厢 id。 */
  function listBurningCars() {
    return Object.keys(fires).filter((id) => fires[id] > 0);
  }

  /** 在车厢舱内生成火焰粒子。 */
  function spawnFlamesForCar(car, intensity, dt) {
    if (!car || intensity <= 0) return;
    const left = car.worldX + Spec.WALK_LEFT;
    const right = car.worldX + Spec.WALK_RIGHT;
    const floorY = Spec.FLOOR_Y;
    const ceilY = Spec.FLOOR_Y - Spec.CABIN_CEIL_INSET;
    const rate = 28 * intensity;
    let budget = rate * dt + Math.random() * 0.4;
    while (budget >= 1 && particles.length < MAX_PARTICLES) {
      budget -= 1;
      const x = randRange(left + 20, right - 20);
      const y = randRange(floorY - 8, floorY - 40 - intensity * 80);
      particles.push({
        x,
        y,
        vx: randRange(-18, 18),
        vy: randRange(-90, -40) * (0.6 + intensity),
        life: randRange(0.35, 0.85),
        age: 0,
        size: randRange(4, 12) * (0.7 + intensity * 0.5),
        heat: Math.random(),
        carId: car.id,
      });
    }
    /* 舱顶轻烟 */
    if (Math.random() < intensity * 0.35) {
      if (particles.length < MAX_PARTICLES) {
        particles.push({
          x: randRange(left + 30, right - 30),
          y: randRange(ceilY + 10, ceilY + 50),
          vx: randRange(-10, 10),
          vy: randRange(-40, -12),
          life: randRange(0.5, 1.1),
          age: 0,
          size: randRange(6, 14),
          heat: -1,
          carId: car.id,
        });
      }
    }
  }

  /** 每帧推进粒子与补焰。 */
  function tick(dt) {
    const step = Math.max(0, Math.min(0.05, dt || 0));
    for (const carId of Object.keys(fires)) {
      const intensity = fires[carId];
      if (!(intensity > 0)) {
        delete fires[carId];
        continue;
      }
      const car = Spec?.carriageById?.(carId);
      if (!car) continue;
      spawnFlamesForCar(car, intensity, step);
    }

    for (let i = particles.length - 1; i >= 0; i -= 1) {
      const p = particles[i];
      p.age += step;
      if (p.age >= p.life) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      if (p.heat < 0) {
        p.vx *= 0.98;
        p.size += 6 * step;
      } else {
        p.vy -= 40 * step;
      }
    }
  }

  /** 世界层绘制火焰/烟雾。 */
  function draw(ctx) {
    if (!ctx || !particles.length) return;
    ctx.save();
    for (const p of particles) {
      const t = p.age / p.life;
      const alpha = (1 - t) * (p.heat < 0 ? 0.22 : 0.85);
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      if (p.heat < 0) {
        ctx.fillStyle = `rgba(160, 160, 160, ${alpha})`;
      } else {
        const hot = p.heat;
        const r = 255;
        const g = Math.floor(80 + hot * 140 + (1 - t) * 40);
        const b = Math.floor(20 + (1 - t) * 30);
        ctx.fillStyle = `rgb(${r},${g},${b})`;
      }
      const s = p.size * (0.7 + 0.5 * (1 - t));
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, s * 0.55, s, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  window.LpCarriageFire = {
    getIntensity,
    setIntensity,
    igniteCar,
    extinguishCar,
    ignitePlayerCar,
    reduceFire,
    hasAnyFire,
    listBurningCars,
    tick,
    draw,
    /** @deprecated 未来事件入口占位 */
    NOTE_FUTURE_EVENTS:
      'Car-fire gameplay events will drive igniteCar; debug/API is enough for now.',
  };
})();
