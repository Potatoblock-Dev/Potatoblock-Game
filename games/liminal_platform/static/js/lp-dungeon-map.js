/**
 * 完整地牢地图叠层（小型月台按 M / 点小地图）。
 * 结构绘制与 FoW 复用 LpDungeonMinimap.paintInto；列车上仍由 LpTrainMap 处理 M。
 */
(() => {
  const root = document.getElementById('lpDungeonMapRoot');
  const stage = document.getElementById('lpDungeonMapStage');
  const canvas = document.getElementById('lpDungeonMapCanvas');
  const floorEl = document.getElementById('lpDungeonMapFloor');
  const closeBtn = document.getElementById('lpDungeonMapClose');
  const hintEl = document.getElementById('lpDungeonMapHint');
  if (!root || !canvas || !stage) return;

  let open = false;

  /** 面板是否打开。 */
  function isOpen() {
    return open;
  }

  /** 当前是否应使用地牢完整地图（而非列车编组图）。 */
  function shouldHandle() {
    return Boolean(window.LpDungeonMinimap?.shouldShow?.());
  }

  /** 同步关闭提示文案。 */
  function syncHint() {
    if (!hintEl) return;
    const key = window.LpInputBindings?.formatAction?.('trainMap') || 'M';
    hintEl.textContent = `${key} / Esc 关闭 · 点空白处关闭 · 未探索区域隐藏`;
  }

  /** 按舞台尺寸将结构绘入完整地图 canvas。 */
  function paint() {
    if (!open) return;
    const cssW = Math.max(280, stage.clientWidth || 640);
    const cssH = Math.max(220, Math.round(cssW * 0.62));
    window.LpDungeonMinimap?.paintInto?.(canvas, {
      cssW,
      cssH,
      pad: Math.max(16, Math.round(Math.min(cssW, cssH) * 0.05)),
      markerScale: 1.6,
      floorEl,
    });
  }

  /** 打开完整地牢地图。 */
  function openMap() {
    if (open) return;
    if (!shouldHandle()) return;
    open = true;
    syncHint();
    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('lp-dungeon-map-open');
    paint();
  }

  /** 关闭完整地牢地图。 */
  function closeMap() {
    if (!open) return;
    open = false;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('lp-dungeon-map-open');
  }

  /** 切换完整地牢地图。 */
  function toggle() {
    if (open) closeMap();
    else openMap();
  }

  /** 主循环挂钩：打开时每帧重绘（玩家/队友位移与 FoW）。 */
  function tick() {
    if (open) paint();
  }

  closeBtn?.addEventListener('click', () => closeMap());
  root.querySelector('.lp-dungeon-map-backdrop')?.addEventListener('click', () => closeMap());

  /* 角标小地图：点击 / Enter / Space 打开完整地图 */
  const minimap = document.getElementById('lpDungeonMinimap');
  /** 从小地图入口打开或关闭完整地图（物品栏打开时忽略）。 */
  function toggleFromMinimap() {
    if (open) {
      closeMap();
      return;
    }
    if (window.LpInventory?.isOpen?.()) return;
    if (!shouldHandle()) return;
    openMap();
  }
  minimap?.addEventListener('click', () => toggleFromMinimap());
  minimap?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggleFromMinimap();
  });

  window.addEventListener('lp:bindings-changed', () => {
    if (open) syncHint();
  });

  window.addEventListener('resize', () => {
    if (open) {
      window.LpDungeonMinimap?.invalidate?.(canvas);
      paint();
    }
  });

  window.LpDungeonMap = {
    isOpen,
    shouldHandle,
    open: openMap,
    close: closeMap,
    toggle,
    tick,
  };
})();
