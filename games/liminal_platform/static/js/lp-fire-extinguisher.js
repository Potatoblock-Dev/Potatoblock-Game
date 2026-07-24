/**
 * 手提灭火器：任意手槽装备；开火键向准星喷雾并扣弹药（进度条 0–100，满罐约 15 秒）。
 * 普通 R 不换弹；靠近灭火器站时 R 补满。喷射可降低所在车厢火灾强度。
 * 联机：弹药经 inv set_ammo 同步权威；灭火器站依赖本机设施布局（布局本身不联机）。
 */
(() => {
  const Catalog = window.LpItemCatalog;
  const Spec = window.LiminalCarriageSpec;
  const ITEM_ID = 'fire_extinguisher';
  const STATION_ID = 'facility_fire_extinguisher_station';
  /** 靠近站台可装填的距离（世界像素）。 */
  const REFILL_RANGE = 150;
  /** 喷射锥半角（度）。 */
  const SPRAY_CONE_DEG = 26;
  /** 喷射最大距离。 */
  const SPRAY_RANGE = 200;
  /** 满罐灭火时长（秒）→ 扣弹速率 maxAmmo/秒。 */
  const SPRAY_DURATION_SEC = 15;
  /** 在着火车厢内持续喷射时，火灾强度每秒下降量。 */
  const FIRE_DAMP_PER_SEC = 0.28;
  const MAX_MIST = 160;
  /** 联机喷射时向权威同步弹药的最短间隔（秒）。 */
  const NET_AMMO_INTERVAL = 0.35;

  const mist = [];
  /** 调试临时站台（世界坐标中心 + 半宽）。 */
  let debugStations = [];
  let lastPromptKey = '';
  let spraying = false;
  /** 空罐 toast 边沿：按住开火时只提示一次，松手或补满后可再提示。 */
  let emptyToastShown = false;
  let netAmmoAccum = 0;
  let lastNetAmmo = null;
  let wasSpraying = false;

  /** 满罐弹药与每秒消耗。 */
  function ammoStats(item) {
    const maxAmmo = Math.max(1, Number(item?.maxAmmo) || 100);
    const duration = Math.max(0.1, Number(item?.sprayDurationSec) || SPRAY_DURATION_SEC);
    return { maxAmmo, drainPerSec: maxAmmo / duration };
  }

  /** 是否联机权威库存。 */
  function isOnlineAuthority() {
    return Boolean(window.LpInventoryNet?.isActive?.());
  }

  /**
   * 将手槽灭火器弹药推到服务端（仅联机）。
   * @param {{ index: number, stack?: { ammo?: number } }} held
   * @param {number} ammo
   * @param {{ force?: boolean }} [opts]
   */
  function syncAmmoToAuthority(held, ammo, opts = {}) {
    if (!isOnlineAuthority() || !held) return;
    const value = Number(ammo);
    if (!Number.isFinite(value)) return;
    if (
      !opts.force &&
      lastNetAmmo != null &&
      Math.abs(lastNetAmmo - value) < 0.05
    ) {
      return;
    }
    lastNetAmmo = value;
    window.LpInventoryNet.sendOp({
      action: 'set_ammo',
      bag: { bag: 'hands', index: held.index },
      ammo: value,
    });
  }

  /** 是否为手提灭火器。 */
  function isExtinguisher(itemOrId) {
    const item = typeof itemOrId === 'string' ? Catalog?.getItem?.(itemOrId) : itemOrId;
    return Boolean(item && item.id === ITEM_ID);
  }

  /** 当前选中手槽上的灭火器。 */
  function getHeldSlot() {
    const hands = window.LpInventory?.getHandsInventory?.();
    if (!hands || !Catalog) return null;
    const preferred = window.LpHandsHud?.getActiveIndex?.();
    if (preferred !== 0 && preferred !== 1 && preferred !== 2) return null;
    if (preferred >= hands.size()) return null;
    if (hands.isCovered?.(preferred)) return null;
    let stack = hands.getSlot(preferred);
    if (!stack || !isExtinguisher(stack.itemId)) return null;
    const item = Catalog.getItem(stack.itemId);
    if (!item) return null;
    const { maxAmmo } = ammoStats(item);
    if (stack.ammo == null) {
      stack = hands.updateSlot?.(preferred, { ammo: maxAmmo }) || {
        ...stack,
        ammo: maxAmmo,
      };
    }
    return { hands, index: preferred, stack, item };
  }

  /** 是否正持用灭火器（开火改走喷射）。 */
  function isHolding() {
    return Boolean(getHeldSlot());
  }

  /** 在 [lo, hi] 均匀随机。 */
  function randRange(lo, hi) {
    return lo + Math.random() * (hi - lo);
  }

  /**
   * 收集灭火器站世界包围盒中心列表（已放置设施 + 调试站）。
   * @returns {Array<{ x: number, y: number, halfW: number, halfH: number, source: string }>}
   */
  function listStationCenters() {
    const out = [];
    const layouts = window.LpFacilityEdit?.getLayouts?.() || {};
    for (const [carId, list] of Object.entries(layouts)) {
      if (!Array.isArray(list)) continue;
      const grid = Spec?.facilityGridFor?.(carId);
      if (!grid) continue;
      for (const p of list) {
        if (!p || p.itemId !== STATION_ID) continue;
        const size = Catalog?.getFacilitySize?.(STATION_ID) || { w: 2, h: 3 };
        const w = size.w * grid.cell;
        const h = size.h * grid.cell;
        const x = grid.originX + p.col * grid.cell + w / 2;
        const y = grid.originY + p.row * grid.cell + h / 2;
        out.push({ x, y, halfW: w / 2, halfH: h / 2, source: 'placed' });
      }
    }
    for (const s of debugStations) {
      out.push(s);
    }
    return out;
  }

  /** 玩家是否在某灭火器站附近。 */
  function findNearbyStation(worldX, worldY) {
    const px = Number(worldX);
    const py = Number(worldY);
    if (!Number.isFinite(px)) return null;
    const y = Number.isFinite(py) ? py : Spec?.FLOOR_Y ?? 0;
    let best = null;
    let bestDist = Infinity;
    for (const st of listStationCenters()) {
      const dx = px - st.x;
      const dy = y - st.y;
      const dist = Math.hypot(dx, dy);
      const reach = REFILL_RANGE + Math.max(st.halfW, st.halfH) * 0.35;
      if (dist <= reach && dist < bestDist) {
        best = st;
        bestDist = dist;
      }
    }
    return best;
  }

  /** 是否可靠近站台装填。 */
  function canRefillHere(worldX, worldY) {
    const held = getHeldSlot();
    if (!held) return false;
    const { maxAmmo } = ammoStats(held.item);
    const ammo = Number(held.stack.ammo);
    if (Number.isFinite(ammo) && ammo >= maxAmmo - 0.05) return false;
    return Boolean(findNearbyStation(worldX, worldY));
  }

  /** 靠近站台时用 R 将弹药补至满罐（不走武器换弹）；联机同步权威。 */
  function tryRefill(worldX, worldY) {
    const held = getHeldSlot();
    if (!held) return false;
    if (!findNearbyStation(worldX, worldY)) {
      window.LiminalInteract?.showToast?.('附近没有灭火器站');
      return false;
    }
    const { maxAmmo } = ammoStats(held.item);
    const ammo = Number(held.stack.ammo);
    if (Number.isFinite(ammo) && ammo >= maxAmmo - 0.05) {
      window.LiminalInteract?.showToast?.('灭火器已满');
      return false;
    }
    held.hands.updateSlot?.(held.index, { ammo: maxAmmo });
    emptyToastShown = false;
    syncAmmoToAuthority(held, maxAmmo, { force: true });
    window.LpInventory?.persistAndRender?.();
    window.LpHandsHud?.render?.();
    window.LiminalInteract?.showToast?.('已从灭火器站补满');
    return true;
  }

  /** 喷嘴世界坐标（手持贴图前端）。 */
  function getNozzleWorld(avatar, aim) {
    const item = getHeldSlot()?.item;
    if (item && window.LpWeaponHold?.getMuzzleWorld && avatar) {
      return window.LpWeaponHold.getMuzzleWorld(avatar, aim, item);
    }
    const facing = avatar?.facing >= 0 ? 1 : -1;
    return {
      x: (avatar?.x ?? 0) + facing * 28,
      y: (avatar?.y ?? 0) - 52,
    };
  }

  /** 生成一簇干粉/水雾粒子。 */
  function spawnMist(ox, oy, dirX, dirY, intensity) {
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;
    const count = Math.max(2, Math.round(5 * intensity));
    const cone = (SPRAY_CONE_DEG * Math.PI) / 180;
    for (let i = 0; i < count; i += 1) {
      if (mist.length >= MAX_MIST) mist.shift();
      const ang = (Math.random() - 0.5) * cone;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const rx = nx * c - ny * s;
      const ry = nx * s + ny * c;
      const spd = randRange(220, 420) * (0.75 + 0.25 * intensity);
      mist.push({
        x: ox + (Math.random() - 0.5) * 4,
        y: oy + (Math.random() - 0.5) * 4,
        vx: rx * spd,
        vy: ry * spd + randRange(-20, 10),
        life: randRange(0.22, 0.48),
        age: 0,
        size: randRange(3.5, 8),
      });
    }
  }

  /**
   * 扣弹药；返回实际喷射强度 0–1（空罐为 0）。
   * 联机只做乐观本地更新，由 tick 节流推送 set_ammo。
   */
  function consumeAmmo(held, dt) {
    const { hands, index, stack, item } = held;
    const { maxAmmo, drainPerSec } = ammoStats(item);
    let ammo = Number(stack.ammo);
    if (!Number.isFinite(ammo)) ammo = maxAmmo;
    if (ammo <= 0) return 0;
    const cost = drainPerSec * dt;
    const used = Math.min(ammo, cost);
    const next = Math.max(0, ammo - used);
    hands.updateSlot?.(index, { ammo: next });
    stack.ammo = next;
    if ((Math.floor(ammo) !== Math.floor(next) || next <= 0) && Math.random() < 0.2) {
      window.LpInventory?.persistAndRender?.();
      window.LpHandsHud?.render?.();
    } else {
      window.LpHandsHud?.render?.();
    }
    return used / Math.max(1e-6, cost);
  }

  /**
   * 每帧：按住开火则向准星喷雾、扣弹、削弱本车火灾；联机节流同步弹药。
   * @param {number} dt
   * @param {{ fireHeld: boolean, aimX: number, aimY: number, avatar?: object, selfX?: number, selfY?: number }} ctx
   */
  function tick(dt, ctx = {}) {
    const step = Math.max(0, Math.min(0.05, dt || 0));
    for (let i = mist.length - 1; i >= 0; i -= 1) {
      const p = mist[i];
      p.age += step;
      if (p.age >= p.life) {
        mist.splice(i, 1);
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      p.vx *= 0.92;
      p.vy *= 0.92;
      p.vy += 40 * step;
      p.size += 10 * step;
    }

    if (!ctx.fireHeld || !isHolding()) {
      if (wasSpraying) {
        const released = getHeldSlot();
        if (released) {
          syncAmmoToAuthority(released, Number(released.stack.ammo), { force: true });
        }
        netAmmoAccum = 0;
      }
      wasSpraying = false;
      spraying = false;
      emptyToastShown = false;
      return null;
    }
    if (window.LpPlayerDeath?.isIncapacitated?.()) {
      if (wasSpraying) {
        const released = getHeldSlot();
        if (released) {
          syncAmmoToAuthority(released, Number(released.stack.ammo), { force: true });
        }
        netAmmoAccum = 0;
      }
      wasSpraying = false;
      spraying = false;
      emptyToastShown = false;
      return null;
    }

    const held = getHeldSlot();
    if (!held) {
      wasSpraying = false;
      spraying = false;
      return null;
    }
    const intensity = consumeAmmo(held, step);
    if (intensity <= 0) {
      spraying = false;
      wasSpraying = false;
      syncAmmoToAuthority(held, Number(held.stack.ammo) || 0, { force: true });
      netAmmoAccum = 0;
      if (Number(held.stack.ammo) <= 0 && !emptyToastShown) {
        emptyToastShown = true;
        window.LiminalInteract?.showToast?.('灭火器已空');
      }
      return { empty: true };
    }

    emptyToastShown = false;
    spraying = true;
    wasSpraying = true;
    netAmmoAccum += step;
    if (netAmmoAccum >= NET_AMMO_INTERVAL) {
      netAmmoAccum = 0;
      syncAmmoToAuthority(held, Number(held.stack.ammo));
    }

    const avatar = ctx.avatar;
    const aim = { x: ctx.aimX, y: ctx.aimY };
    const nozzle = getNozzleWorld(avatar, aim);
    const dirX = aim.x - nozzle.x;
    const dirY = aim.y - nozzle.y;
    spawnMist(nozzle.x, nozzle.y, dirX, dirY, intensity);

    const selfX = ctx.selfX ?? avatar?.x ?? nozzle.x;
    const car = Spec?.carriageAt?.(selfX);
    if (car && window.LpCarriageFire?.getIntensity?.(car.id) > 0) {
      /* 首通：在着火车厢内喷射即按时间削弱（锥形命中留作后续）。 */
      window.LpCarriageFire.reduceFire(car.id, FIRE_DAMP_PER_SEC * step * intensity);
    }
    return { spraying: true, intensity };
  }

  /** 绘制喷雾粒子。 */
  function draw(ctx) {
    if (!ctx || !mist.length) return;
    ctx.save();
    for (const p of mist) {
      const t = p.age / p.life;
      const alpha = (1 - t) * 0.55;
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = t < 0.35 ? 'rgb(240, 248, 255)' : 'rgb(200, 210, 220)';
      const s = p.size * (0.6 + t);
      ctx.beginPath();
      ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** 更新靠近站台时的装填提示。 */
  function updatePrompt(worldX, worldY) {
    if (!isHolding()) {
      if (lastPromptKey) {
        lastPromptKey = '';
      }
      return;
    }
    const near = canRefillHere(worldX, worldY);
    const key = near ? 'refill' : '';
    if (key === lastPromptKey) return;
    lastPromptKey = key;
    if (near) {
      window.LiminalInteract?.showToast?.('靠近灭火器站 · 按 R 装填');
    }
  }

  /** 调试：在玩家脚下生成临时灭火器站（不扣仓储）。 */
  function debugSpawnStation(worldX) {
    const x =
      worldX != null ? Number(worldX) : Number(window.LpGame?.getLocalX?.());
    if (!Number.isFinite(x)) return null;
    const cell = Spec?.FACILITY_CELL || 64;
    const st = {
      x,
      y: (Spec?.FLOOR_Y ?? 0) - cell * 0.55,
      halfW: cell,
      halfH: cell * 0.55,
      source: 'debug',
    };
    debugStations.push(st);
    window.LiminalInteract?.showToast?.('已调试生成灭火器站');
    return st;
  }

  /** 清除调试站台。 */
  function clearDebugStations() {
    debugStations = [];
  }

  /** 是否正在喷射（供 hold-fire 判定）。 */
  function isSpraying() {
    return spraying;
  }

  window.LpFireExtinguisher = {
    ITEM_ID,
    STATION_ID,
    SPRAY_DURATION_SEC,
    drainPerSecFor: (item) => ammoStats(item).drainPerSec,
    isExtinguisher,
    isHolding,
    getHeldSlot,
    tryRefill,
    canRefillHere,
    findNearbyStation,
    tick,
    draw,
    updatePrompt,
    debugSpawnStation,
    clearDebugStations,
    isSpraying,
    listStationCenters,
  };
})();
