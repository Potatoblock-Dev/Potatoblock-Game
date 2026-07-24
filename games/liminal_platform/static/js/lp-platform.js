/**
 * 月台首通：列车 / 月台两套场景切换（连接处 F 下月台；月台回车点 F 上车）。
 * - 停靠：路线进度接近站点且车速≈0 → atPlatform（亦可 debugDock）
 * - 自动驾驶：LpAutoAutopilot 读传感近站急刹；本模块钳制路线避免冲过站
 * - 回车重生在离开时的同一连接处索引
 * - 月台灰矩形占位 + 编辑台（会话内编组顺序/空车·仓储显隐）
 * - 发车锁：任一玩家仍在月台场景时禁止非零油门
 */
(() => {
  const Spec = () => window.LiminalCarriageSpec;
  const GREY = '#c8c8c8';
  const GREY_DARK = '#9a9a9a';
  const GREY_EDIT = '#b0b0b0';

  /** 站点间距（路线单位；与速度积分同量纲）。 */
  const STATION_SPACING = 4200;
  /** 前方有月台传感距离（对齐 LpAutoSensors.PLATFORM_AHEAD_DIST）。 */
  const AHEAD_DIST = 800;
  /**
   * 可停靠距离阈值（路线单位）。
   * 须宽于自动驾驶近站急刹后的滑行余量；过窄会冲过站永远停不上。
   */
  const DOCK_DIST = 160;
  /**
   * 进站钳制：距站小于此值时不再让 route 冲过站点（等车停稳后 dock）。
   * 对齐自动驾驶 DIST_EMERGENCY / DIST_CREEP 量级。
   */
  const CAPTURE_DIST = 300;
  /** 车速视为停稳。 */
  const STOP_SPEED = 0.08;
  /** 连接处交互半宽（世界）。 */
  const COUPLER_RADIUS = 90;
  /** 月台场景尺寸（世界）。 */
  const PLAT_W = 2200;
  const PLAT_H = 900;
  const PLAT_FLOOR_Y = 720;
  const PLAT_WALK_LEFT = 120;
  const PLAT_WALK_RIGHT = PLAT_W - 120;

  /** @type {'train'|'platform'} */
  let scene = 'train';
  let routeX = 0;
  let atPlatform = false;
  let forceDock = false;
  /** 离开火车时记住的连接处索引（回车用）。 */
  let exitCouplerIndex = 0;
  /** 月台场景内本地 X（相对月台原点）。 */
  let platformLocalX = PLAT_WALK_LEFT + 200;
  let editOpen = false;

  const editRoot = document.getElementById('lpPlatformEditRoot');
  const editList = document.getElementById('lpPlatformEditList');
  const editAdd = document.getElementById('lpPlatformEditAdd');
  const editStatus = document.getElementById('lpPlatformEditStatus');

  /** @type {{ carId: string, pointerId: number, startX: number }|null} */
  let editDrag = null;

  /**
   * 编组连接处列表（节间连廊中心）。
   * @returns {Array<{ index: number, worldX: number, leftCarId: string, rightCarId: string }>}
   */
  function listCouplers() {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars?.length) return [];
    const out = [];
    for (let i = 0; i < cars.length - 1; i += 1) {
      const left = cars[i];
      const right = cars[i + 1];
      const leftEdge = left.worldX + S.WALK_RIGHT;
      const rightEdge = right.worldX + S.WALK_LEFT;
      out.push({
        index: i,
        worldX: (leftEdge + rightEdge) / 2,
        leftCarId: left.id,
        rightCarId: right.id,
      });
    }
    return out;
  }

  /** 最近连接处；过远返回 null。 */
  function nearestCoupler(worldX) {
    const list = listCouplers();
    let best = null;
    let bestD = Infinity;
    for (const c of list) {
      const d = Math.abs(worldX - c.worldX);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD > COUPLER_RADIUS) return null;
    return best;
  }

  /** 连接处世界 X；越界夹到合法索引。 */
  function couplerWorldX(index) {
    const list = listCouplers();
    if (!list.length) return Spec()?.defaultSpawnX?.() ?? 0;
    const i = Math.max(0, Math.min(list.length - 1, index | 0));
    return list[i].worldX;
  }

  /** 到下一站点的前方距离（路线单位）。对齐站心时为 0。 */
  function distanceToStation() {
    if (forceDock) return 0;
    const mod = ((routeX % STATION_SPACING) + STATION_SPACING) % STATION_SPACING;
    /* mod≈0 表示正好处在站心（非整站间距外的「下一站」） */
    if (mod < 0.75) return 0;
    return STATION_SPACING - mod;
  }

  /** 刷新 LpAutoSensors 月台 stub。 */
  function syncSensorStub() {
    const dist = distanceToStation();
    window.LpAutoSensors?.setPlatformStub?.({
      platformAhead: atPlatform || dist <= AHEAD_DIST,
      atPlatform,
      distanceAhead: atPlatform ? 0 : dist,
    });
  }

  /** 是否停靠月台。 */
  function isAtPlatform() {
    return atPlatform;
  }

  /** 本机是否在月台场景。 */
  function isLocalOnPlatform() {
    return scene === 'platform';
  }

  /** 当前场景。 */
  function getScene() {
    return scene;
  }

  /**
   * 联机远端或本机是否仍有人在月台。
   * @returns {boolean}
   */
  function anyPlayerOnPlatform() {
    if (scene === 'platform') return true;
    const remotes = window.LiminalSession?.remotes?.();
    if (!remotes) return false;
    for (const remote of remotes.values()) {
      if (remote._lpDisconnected) continue;
      if (remote._lpScene === 'platform') return true;
    }
    return false;
  }

  /** 是否允许离开空档发车。 */
  function canDepart() {
    return atPlatform ? !anyPlayerOnPlatform() : true;
  }

  /** 发车锁文案；可发车时 null。 */
  function getDepartBlockReason() {
    if (!atPlatform) return null;
    if (!anyPlayerOnPlatform()) return null;
    if (scene === 'platform') return '你仍在月台 — 回车后再发车';
    return '仍有玩家在月台 — 全员回车后才能发车';
  }

  /** 月台行走边界（供主循环）。 */
  function getPlatformWalkBounds() {
    return {
      left: PLAT_WALK_LEFT + 40,
      right: PLAT_WALK_RIGHT - 40,
      floorY: PLAT_FLOOR_Y,
    };
  }

  /** 月台交互点（回车 / 编辑台）。 */
  function platformSpots() {
    const returnX = PLAT_WALK_LEFT + 280;
    const editX = PLAT_WALK_LEFT + 900;
    return [
      {
        id: 'platform-board',
        action: 'boardTrain',
        actionLabel: '返回列车',
        worldX: returnX,
        interactRadiusX: 110,
        rect: { x: returnX - 70, y: PLAT_FLOOR_Y - 160, w: 140, h: 160 },
      },
      {
        id: 'platform-edit',
        action: 'openPlatformEdit',
        actionLabel: '打开编组编辑台',
        worldX: editX,
        interactRadiusX: 120,
        rect: { x: editX - 80, y: PLAT_FLOOR_Y - 140, w: 160, h: 140 },
      },
    ];
  }

  /**
   * 当前可交互节点（列车连接处或月台点）。
   * @param {{ x: number, onGround?: boolean, y?: number }} local
   */
  function findActive(local) {
    if (!local?.onGround) return null;
    if (scene === 'platform') {
      let best = null;
      let bestD = Infinity;
      for (const spot of platformSpots()) {
        const d = Math.abs(local.x - spot.worldX);
        if (d > spot.interactRadiusX) continue;
        if (d < bestD) {
          bestD = d;
          best = spot;
        }
      }
      return best;
    }
    if (!atPlatform) return null;
    const c = nearestCoupler(local.x);
    if (!c) return null;
    return {
      id: `coupler-${c.index}`,
      action: 'enterPlatform',
      actionLabel: '进入月台',
      worldX: c.worldX,
      couplerIndex: c.index,
      interactRadiusX: COUPLER_RADIUS,
    };
  }

  /** 切入月台场景（记住连接处）。 */
  function enterPlatformFromCoupler(couplerIndex, trainLocal) {
    exitCouplerIndex = Math.max(0, couplerIndex | 0);
    scene = 'platform';
    platformLocalX = platformSpots()[0].worldX;
    if (trainLocal) {
      trainLocal.x = platformLocalX;
      trainLocal.vx = 0;
      trainLocal.y = 0;
      trainLocal.onGround = true;
    }
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(true);
    window.LiminalInteract?.showToast?.('已进入月台');
    window.dispatchEvent(
      new CustomEvent('liminal:platform-scene', { detail: { scene } })
    );
  }

  /** 从月台回车到记住的连接处。 */
  function boardTrain(trainLocal) {
    scene = 'train';
    const x = couplerWorldX(exitCouplerIndex);
    if (trainLocal) {
      trainLocal.x = x;
      trainLocal.vx = 0;
      trainLocal.y = 0;
      trainLocal.onGround = true;
    } else {
      window.LpGame?.teleportToCoupler?.(exitCouplerIndex);
    }
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(false);
    closeEdit();
    window.LiminalInteract?.showToast?.(
      `已返回列车（连接处 ${exitCouplerIndex + 1}）`
    );
    window.dispatchEvent(
      new CustomEvent('liminal:platform-scene', { detail: { scene } })
    );
    return true;
  }

  /** 打开编组编辑 UI。 */
  function openEdit() {
    if (!editRoot) {
      window.LiminalInteract?.showToast?.('编组编辑台未就绪');
      return false;
    }
    editOpen = true;
    editRoot.hidden = false;
    editRoot.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-platform-edit-open');
    renderEditList();
    return true;
  }

  /** 关闭编组编辑 UI。 */
  function closeEdit() {
    editOpen = false;
    if (editRoot) {
      editRoot.hidden = true;
      editRoot.setAttribute('aria-hidden', 'true');
    }
    document.body.classList.remove('lp-platform-edit-open');
  }

  /** 是否打开编组编辑。 */
  function isEditOpen() {
    return editOpen;
  }

  /**
   * 应用编组顺序（可变车：empty / storage 可隐；核心车固定保留）。
   * @param {string[]} orderIds
   */
  function applyComposition(orderIds) {
    const S = Spec();
    if (!S?.CARRIAGES) return false;
    const byId = Object.fromEntries(S.CARRIAGES.map((c) => [c.id, c]));
    const core = ['guard', 'power', 'huigui', 'shuji'];
    const optional = ['storage', 'empty'];
    const next = [];
    const seen = new Set();
    for (const id of orderIds) {
      if (!byId[id] || seen.has(id)) continue;
      if (!core.includes(id) && !optional.includes(id)) continue;
      next.push(byId[id]);
      seen.add(id);
    }
    for (const id of core) {
      if (!seen.has(id) && byId[id]) {
        next.push(byId[id]);
        seen.add(id);
      }
    }
    if (next.length < 2) return false;
    S.CARRIAGES.length = 0;
    for (let i = 0; i < next.length; i += 1) {
      const car = next[i];
      car.worldX = S.COUPLER_JOIN_OFFSET * i;
      S.CARRIAGES.push(car);
    }
    window.LiminalInteract?.rebuildInteractables?.();
    window.LpGame?.refreshWalkBounds?.();
    window.LpTrainMinimap?.refresh?.();
    window.LpTrainMap?.refresh?.();
    if (editStatus) {
      editStatus.textContent = '已应用本会话编组（联机权威同步后续接入）';
    }
    return true;
  }

  /** 刷新编辑台：横向编组图 + 拖拽换位 + 可选车移除/加回。 */
  function renderEditList() {
    if (!editList) return;
    const S = Spec();
    const cars = S?.CARRIAGES || [];
    editList.innerHTML = '';
    editDrag = null;

    cars.forEach((car, index) => {
      if (index > 0) {
        const coupler = document.createElement('li');
        coupler.className = 'lp-platform-edit-coupler';
        coupler.setAttribute('aria-hidden', 'true');
        editList.appendChild(coupler);
      }

      const entry = S.mapEntryFor?.(car) || {
        id: car.id,
        label: car.label || car.id,
        shortLabel: car.map?.shortLabel || car.label || car.id,
        kind: car.map?.kind || 'default',
        tone: car.map?.tone,
        icon: car.icon,
      };
      const kindClass = `lp-map-car--${entry.kind || 'default'}`;
      const item = document.createElement('li');
      item.className = `lp-platform-edit-car lp-train-map-car ${kindClass}`;
      item.dataset.carId = car.id;
      item.dataset.index = String(index);
      if (entry.tone) item.style.setProperty('--lp-map-tone', entry.tone);
      item.title = `${entry.label} · 拖拽调整位置`;

      const body = document.createElement('button');
      body.type = 'button';
      body.className = 'lp-train-map-car-body lp-platform-edit-car-handle';
      body.setAttribute('aria-label', `拖拽 ${entry.label}`);
      if (entry.icon) {
        const img = document.createElement('img');
        img.className = 'lp-train-map-car-icon';
        img.src = entry.icon;
        img.alt = '';
        img.draggable = false;
        body.appendChild(img);
        body.classList.add('has-icon');
      }
      const short = document.createElement('span');
      short.className = 'lp-train-map-car-label';
      short.textContent = entry.shortLabel;
      body.appendChild(short);
      const name = document.createElement('span');
      name.className = 'lp-train-map-car-name';
      name.textContent = entry.label;
      body.appendChild(name);
      item.appendChild(body);

      if (car.id === 'empty' || car.id === 'storage') {
        const rem = document.createElement('button');
        rem.type = 'button';
        rem.className = 'lp-platform-edit-remove';
        rem.textContent = '移除';
        rem.addEventListener('click', (ev) => {
          ev.stopPropagation();
          removeOptional(car.id);
        });
        item.appendChild(rem);
      }

      body.addEventListener('pointerdown', (ev) => {
        if (ev.button != null && ev.button !== 0) return;
        beginEditDrag(ev, car.id, item);
      });

      editList.appendChild(item);
    });

    if (editAdd) {
      editAdd.innerHTML = '';
      let any = false;
      for (const id of ['storage', 'empty']) {
        if (cars.some((c) => c.id === id)) continue;
        const tpl = carTemplate(id);
        if (!tpl) continue;
        any = true;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lp-platform-edit-add-btn';
        btn.textContent = `+ ${tpl.label}`;
        btn.addEventListener('click', () => addOptional(id));
        editAdd.appendChild(btn);
      }
      editAdd.hidden = !any;
    }
  }

  /**
   * 开始拖拽换位。
   * @param {PointerEvent} ev
   * @param {string} carId
   * @param {HTMLElement} item
   */
  function beginEditDrag(ev, carId, item) {
    if (!editList || editDrag) return;
    editDrag = {
      carId,
      pointerId: ev.pointerId,
      startX: ev.clientX,
    };
    item.classList.add('is-dragging');
    try {
      item.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* ignore */
    }
    const onMove = (e) => {
      if (!editDrag || e.pointerId !== editDrag.pointerId) return;
      updateEditDragHover(e.clientX);
    };
    const onUp = (e) => {
      if (!editDrag || e.pointerId !== editDrag.pointerId) return;
      const targetIndex = editInsertIndexAt(e.clientX);
      const fromId = editDrag.carId;
      endEditDrag();
      if (targetIndex != null) reorderCarToIndex(fromId, targetIndex);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    updateEditDragHover(ev.clientX);
  }

  /** 清除拖拽态与插入高亮。 */
  function endEditDrag() {
    editDrag = null;
    editList?.querySelectorAll('.lp-platform-edit-car').forEach((node) => {
      node.classList.remove('is-dragging', 'is-drop-before', 'is-drop-after');
    });
  }

  /**
   * 根据指针 X 计算插入下标（落在某节中线左侧=该下标，右侧=下标+1）。
   * @param {number} clientX
   * @returns {number|null}
   */
  function editInsertIndexAt(clientX) {
    if (!editList) return null;
    const nodes = [...editList.querySelectorAll('.lp-platform-edit-car')];
    if (!nodes.length) return null;
    let best = nodes.length;
    for (let i = 0; i < nodes.length; i += 1) {
      const rect = nodes[i].getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      if (clientX < mid) {
        best = i;
        break;
      }
    }
    return best;
  }

  /** 拖拽过程中高亮落点。 */
  function updateEditDragHover(clientX) {
    if (!editList || !editDrag) return;
    const nodes = [...editList.querySelectorAll('.lp-platform-edit-car')];
    const insertAt = editInsertIndexAt(clientX);
    nodes.forEach((node, i) => {
      node.classList.toggle('is-drop-before', insertAt === i);
      node.classList.toggle('is-drop-after', insertAt === nodes.length && i === nodes.length - 1);
    });
  }

  /**
   * 将车厢移到目标下标（考虑拖起后原位腾出）。
   * @param {string} carId
   * @param {number} insertAt
   */
  function reorderCarToIndex(carId, insertAt) {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars) return;
    const from = cars.findIndex((c) => c.id === carId);
    if (from < 0) return;
    let to = Math.max(0, Math.min(cars.length, insertAt | 0));
    if (to > from) to -= 1;
    if (to === from) {
      renderEditList();
      return;
    }
    const ids = cars.map((c) => c.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    applyComposition(ids);
    renderEditList();
  }

  /** 可选车厢模板（从当前或默认描述重建）。 */
  function carTemplate(id) {
    const S = Spec();
    const existing = S?.carriageById?.(id);
    if (existing) return existing;
    if (id === 'storage') {
      return {
        id: 'storage',
        label: '仓储车厢',
        image: '/static/games/liminal-platform/img/cars/storage-car.png?v=5',
        icon: '/static/games/liminal-platform/img/cars/storage-car-icon.png?v=1',
        worldX: 0,
        facilityEditable: true,
        map: { shortLabel: '仓储', kind: 'cargo', tone: '#64748b' },
      };
    }
    if (id === 'empty') {
      return {
        id: 'empty',
        label: '空车厢',
        image: '/static/games/liminal-platform/img/cars/empty-car.png?v=1',
        icon: '/static/games/liminal-platform/img/cars/empty-car-icon.png?v=1',
        worldX: 0,
        facilityEditable: true,
        map: { shortLabel: '空车', kind: 'cargo', tone: '#475569' },
      };
    }
    return null;
  }

  /** 移动车厢相对顺序。 */
  function moveCar(carId, delta) {
    const S = Spec();
    const cars = S?.CARRIAGES;
    if (!cars) return;
    const i = cars.findIndex((c) => c.id === carId);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= cars.length) return;
    const tmp = cars[i];
    cars[i] = cars[j];
    cars[j] = tmp;
    applyComposition(cars.map((c) => c.id));
    renderEditList();
  }

  /** 移除可选车厢。 */
  function removeOptional(carId) {
    const S = Spec();
    if (!S?.CARRIAGES) return;
    if (carId !== 'empty' && carId !== 'storage') return;
    applyComposition(S.CARRIAGES.filter((c) => c.id !== carId).map((c) => c.id));
    renderEditList();
  }

  /** 添加可选车厢到尾部核心车之前。 */
  function addOptional(carId) {
    const S = Spec();
    if (!S?.CARRIAGES) return;
    if (S.CARRIAGES.some((c) => c.id === carId)) return;
    const tpl = carTemplate(carId);
    if (!tpl) return;
    const clone = { ...tpl, map: { ...(tpl.map || {}) } };
    const ids = S.CARRIAGES.map((c) => c.id);
    const powerIdx = ids.indexOf('power');
    if (powerIdx >= 0) ids.splice(powerIdx, 0, carId);
    else ids.push(carId);
    S.CARRIAGES.push(clone);
    applyComposition(ids);
    renderEditList();
  }

  /**
   * 尝试交互（连接处下月台 / 月台回车 / 编辑台）。
   * @param {{ x: number, onGround?: boolean, y?: number, vx?: number }} local
   */
  function tryInteract(local) {
    const spot = findActive(local);
    if (!spot) return false;
    if (spot.action === 'enterPlatform') {
      enterPlatformFromCoupler(spot.couplerIndex ?? 0, local);
      return true;
    }
    if (spot.action === 'boardTrain') {
      return boardTrain(local);
    }
    if (spot.action === 'openPlatformEdit') {
      return openEdit();
    }
    return false;
  }

  /**
   * 每帧：积分路线、更新停靠、同步传感与环境音。
   * @param {number} dt
   */
  function tick(dt) {
    const drive = window.LpTrainDrive;
    const speed = Number(drive?.getState?.()?.speed) || 0;
    const throttle = Number(drive?.getState?.()?.throttle) || 0;
    const step = Math.max(0, Number(dt) || 0);
    const absSpeed = Math.abs(speed);

    if (!atPlatform && !forceDock) {
      const distBefore = distanceToStation();
      /* 进站捕捉：接近站点时钳制 route，避免冲过 DOCK 窗后永远到不了站 */
      const brakingIn =
        absSpeed > STOP_SPEED &&
        distBefore <= CAPTURE_DIST &&
        (Math.abs(throttle) < 0.5 ||
          Boolean(window.LpAutoAutopilot?.isEngaged?.()));
      if (brakingIn) {
        const advance = absSpeed * 220 * step;
        if (advance >= distBefore) {
          /* 贴到本站：route 对齐站台零点（mod≈0） */
          routeX = Math.floor(routeX / STATION_SPACING + 1e-9) * STATION_SPACING + STATION_SPACING;
        } else {
          routeX += advance;
        }
      } else {
        routeX += absSpeed * 220 * step;
      }
    }

    const dist = distanceToStation();
    const stopped = absSpeed <= STOP_SPEED;

    if (forceDock) {
      atPlatform = true;
    } else if (atPlatform) {
      /* 全员回车且油门离开空档、开始移动后离站 */
      if (canDepart() && Math.abs(throttle) > 0.01 && absSpeed > STOP_SPEED) {
        atPlatform = false;
        routeX = Math.floor(routeX / STATION_SPACING) * STATION_SPACING + 4;
      }
    } else if (stopped && dist <= DOCK_DIST) {
      atPlatform = true;
      /* 对齐站心，传感 distanceAhead=0 */
      routeX = Math.floor(routeX / STATION_SPACING + 1e-9) * STATION_SPACING + STATION_SPACING;
      window.LiminalInteract?.showToast?.('列车已停靠月台 — 连接处按 F 进入');
    }

    syncSensorStub();
    window.LpPlatformAmbience?.setPlayerOnPlatformStub?.(
      scene === 'platform' ? true : false
    );

    /* 停靠且有人在月台：本地也锁油门（离线/联机提示） */
    if (atPlatform && anyPlayerOnPlatform()) {
      const th = Number(drive?.getState?.()?.throttle) || 0;
      if (Math.abs(th) > 0.01) {
        drive?.setThrottle?.(0);
        const reason = getDepartBlockReason();
        if (reason) window.LiminalInteract?.showToast?.(reason, 1200);
      }
    }
  }

  /**
   * 绘制月台场景灰矩形占位（仅 platform 场景）。
   * @param {CanvasRenderingContext2D} ctx
   */
  function draw(ctx) {
    if (scene !== 'platform') return;
    const S = Spec();
    const floorY = PLAT_FLOOR_Y;

    ctx.fillStyle = '#1a1f2a';
    ctx.fillRect(0, 0, PLAT_W, PLAT_H);

    /* 站台主体 */
    ctx.fillStyle = GREY;
    ctx.fillRect(80, floorY - 40, PLAT_W - 160, 220);
    ctx.fillStyle = GREY_DARK;
    ctx.fillRect(80, floorY - 40, PLAT_W - 160, 12);

    /* 轨侧示意条 */
    ctx.fillStyle = '#6b7280';
    ctx.fillRect(40, floorY + 8, 48, 16);
    ctx.fillRect(PLAT_W - 88, floorY + 8, 48, 16);

    for (const spot of platformSpots()) {
      const r = spot.rect;
      ctx.fillStyle = spot.action === 'openPlatformEdit' ? GREY_EDIT : '#d4d4d4';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = 'rgba(30,30,30,0.45)';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      ctx.fillStyle = '#333';
      ctx.font = `${Math.max(14, (S?.scaleArt?.(18) || 18))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        spot.action === 'boardTrain' ? '回车' : '编辑台',
        r.x + r.w / 2,
        r.y + r.h / 2
      );
    }

    /* 标题 */
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('月台（占位）', 100, 80);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(`回车连接处 #${exitCouplerIndex + 1}`, 100, 108);
  }

  /**
   * 雷达月台标：相对列车航向前方的站点位置（世界近似）。
   * @returns {{ x: number, y: number, label?: string }|null}
   */
  function getRadarPlatformBlip() {
    const S = Spec();
    if (!S?.CARRIAGES?.length) return null;
    const mid =
      (S.CARRIAGES[0].worldX +
        S.CARRIAGES[S.CARRIAGES.length - 1].worldX +
        S.MODULE_W) /
      2;
    const dist = atPlatform ? 0 : distanceToStation();
    const forward = S.TRAIN_FORWARD_X >= 0 ? 1 : -1;
    return {
      x: mid + forward * dist * 0.85,
      y: S.FLOOR_Y,
      label: '月台',
    };
  }

  /**
   * 雷达铁轨折线（世界点，含拐弯）；以编组中心为原点沿前进轴延伸并侧向偏折。
   * @returns {Array<{ x: number, y: number }>}
   */
  function getRadarTrackPolyline() {
    const S = Spec();
    if (!S?.CARRIAGES?.length) return [];
    const midY = S.FLOOR_Y;
    const midX =
      (S.CARRIAGES[0].worldX +
        S.CARRIAGES[S.CARRIAGES.length - 1].worldX +
        S.MODULE_W) /
      2;
    const forward = S.TRAIN_FORWARD_X >= 0 ? 1 : -1;
    const lateral = S.scaleArt?.(180) || 180;
    const seg = S.scaleArt?.(520) || 520;
    /* 前进轴 ≈ 世界 +X；俯视雷达里会再转到航向。折线含一段侧向弯。 */
    return [
      { x: midX - forward * seg * 2.2, y: midY },
      { x: midX - forward * seg * 0.6, y: midY },
      { x: midX + forward * seg * 0.2, y: midY + lateral },
      { x: midX + forward * seg * 1.4, y: midY + lateral },
      { x: midX + forward * seg * 2.4, y: midY },
    ];
  }

  /**
   * 调试强制停靠；传 false 取消。无参则切换。
   * @param {boolean} [on]
   */
  function debugDock(on) {
    if (on == null) forceDock = !forceDock;
    else forceDock = Boolean(on);
    if (forceDock) {
      atPlatform = true;
      window.LpTrainDrive?.setThrottle?.(0);
    } else if (scene === 'platform') {
      /* 保持场景；仅解除强制 */
    } else {
      atPlatform = false;
    }
    syncSensorStub();
    window.LiminalInteract?.showToast?.(
      forceDock ? '调试：强制停靠月台' : '调试：取消强制停靠'
    );
  }

  /* URL ?dock=1 进入即强制停靠，便于首通试玩 */
  try {
    if (new URLSearchParams(location.search).get('dock') === '1') {
      forceDock = true;
      atPlatform = true;
    }
  } catch (_) {
    /* ignore */
  }

  editRoot?.querySelector('#lpPlatformEditClose')?.addEventListener('click', () => {
    closeEdit();
  });

  window.LpPlatform = {
    getScene,
    isAtPlatform,
    isLocalOnPlatform,
    anyPlayerOnPlatform,
    canDepart,
    getDepartBlockReason,
    findActive,
    tryInteract,
    tick,
    draw,
    getPlatformWalkBounds,
    getRadarPlatformBlip,
    getRadarTrackPolyline,
    debugDock,
    listCouplers,
    couplerWorldX,
    getExitCouplerIndex: () => exitCouplerIndex,
    openEdit,
    closeEdit,
    isEditOpen,
    enterPlatformFromCoupler,
    boardTrain,
  };

  syncSensorStub();
})();
