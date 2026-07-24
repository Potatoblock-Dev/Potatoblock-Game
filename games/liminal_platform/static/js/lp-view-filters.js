/**
 * 视口后处理滤镜栈：有序命名滤镜，可启用/禁用与互斥激活。
 * 世界背景独立；本模块只做屏幕空间叠层，供未来恐怖调色（去饱和、暗角、色差、颗粒等）。
 */
(() => {
  /** @typedef {{ id: string, enabled: boolean, apply: (ctx: CanvasRenderingContext2D, meta: object) => void }} ViewFilter */

  /** @type {ViewFilter[]} */
  const filters = [];
  /** 当前互斥激活 id；`none` 表示不强制单选（仍尊重各滤镜 enabled）。 */
  let activeId = 'none';

  /**
   * 按 id 查找滤镜。
   * @param {string} id
   * @returns {ViewFilter | null}
   */
  function find(id) {
    for (let i = 0; i < filters.length; i += 1) {
      if (filters[i].id === id) return filters[i];
    }
    return null;
  }

  /**
   * 注册或替换命名滤镜（保持调用顺序；同 id 替换 apply/enabled）。
   * @param {string} id
   * @param {(ctx: CanvasRenderingContext2D, meta: object) => void} applyFn
   * @param {{ enabled?: boolean }} [opts]
   */
  function register(id, applyFn, opts = {}) {
    if (!id || typeof applyFn !== 'function') return;
    const existing = find(id);
    if (existing) {
      existing.apply = applyFn;
      if (opts.enabled != null) existing.enabled = Boolean(opts.enabled);
      return;
    }
    filters.push({
      id: String(id),
      enabled: opts.enabled != null ? Boolean(opts.enabled) : false,
      apply: applyFn,
    });
  }

  /**
   * 启用或禁用指定滤镜（不改 activeId）。
   * @param {string} id
   * @param {boolean} on
   */
  function setEnabled(id, on) {
    const f = find(id);
    if (!f || f.id === 'none') return;
    f.enabled = Boolean(on);
  }

  /**
   * 启用滤镜。
   * @param {string} id
   */
  function enable(id) {
    setEnabled(id, true);
  }

  /**
   * 禁用滤镜。
   * @param {string} id
   */
  function disable(id) {
    setEnabled(id, false);
  }

  /**
   * 互斥激活：启用 id，关闭其它非 none；传 `none` 则全部关闭。
   * @param {string} id
   */
  function setActiveFilter(id) {
    const want = id == null ? 'none' : String(id);
    activeId = want;
    for (const f of filters) {
      if (f.id === 'none') {
        f.enabled = want === 'none';
        continue;
      }
      f.enabled = want !== 'none' && f.id === want;
    }
  }

  /**
   * 当前互斥激活 id。
   * @returns {string}
   */
  function getActiveFilter() {
    return activeId;
  }

  /**
   * 列出滤镜快照（id / enabled）。
   * @returns {{ id: string, enabled: boolean }[]}
   */
  function list() {
    return filters.map((f) => ({ id: f.id, enabled: f.enabled }));
  }

  /**
   * 按注册顺序对已启用滤镜做屏幕空间叠画（identity / none 跳过）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ width?: number, height?: number, dpr?: number, timeSec?: number }} [meta]
   */
  function apply(ctx, meta = {}) {
    if (!ctx || !ctx.canvas) return;
    const width = meta.width != null ? meta.width : ctx.canvas.width;
    const height = meta.height != null ? meta.height : ctx.canvas.height;
    const payload = {
      width,
      height,
      dpr: meta.dpr != null ? meta.dpr : 1,
      timeSec:
        meta.timeSec != null ? meta.timeSec : performance.now() * 0.001,
    };
    for (const f of filters) {
      if (!f.enabled || f.id === 'none') continue;
      f.apply(ctx, payload);
    }
  }

  /**
   * 无操作占位（默认激活）。
   * @param {CanvasRenderingContext2D} _ctx
   * @param {object} _meta
   */
  function applyNone(_ctx, _meta) {}

  /**
   * 轻度去饱和叠层：心理恐怖基调预览（默认关）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ width: number, height: number }} meta
   */
  function applyDesatSoft(ctx, meta) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'saturation';
    ctx.fillStyle = 'rgba(128, 128, 128, 0.28)';
    ctx.fillRect(0, 0, meta.width, meta.height);
    ctx.globalCompositeOperation = 'source-over';
    /* 冷青偏色，压暖色 */
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = 'rgba(40, 70, 90, 1)';
    ctx.fillRect(0, 0, meta.width, meta.height);
    ctx.restore();
  }

  /**
   * 暗角 + 极淡边缘病绿：空洞压迫感（默认关）。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ width: number, height: number }} meta
   */
  function applyVignetteHorror(ctx, meta) {
    const { width, height } = meta;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const cx = width * 0.5;
    const cy = height * 0.48;
    const r = Math.max(width, height) * 0.72;
    const g = ctx.createRadialGradient(cx, cy, r * 0.28, cx, cy, r);
    g.addColorStop(0, 'rgba(0, 0, 0, 0)');
    g.addColorStop(0.55, 'rgba(0, 0, 0, 0.08)');
    g.addColorStop(0.82, 'rgba(8, 12, 10, 0.28)');
    g.addColorStop(1, 'rgba(4, 6, 8, 0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  /* 内置：none + 恐怖向占位（默认不启用，便于日后 CRT/色差/颗粒扩展） */
  register('none', applyNone, { enabled: true });
  register('desat-soft', applyDesatSoft, { enabled: false });
  register('vignette-horror', applyVignetteHorror, { enabled: false });
  activeId = 'none';

  window.LpViewFilters = {
    register,
    setEnabled,
    enable,
    disable,
    setActiveFilter,
    getActiveFilter,
    list,
    apply,
  };
})();
