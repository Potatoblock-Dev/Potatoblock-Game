/**
 * Kenney Particle Pack 枪口火光：预加载灰度 PNG，source-atop 调成暖橙黄后 additive 绘制。
 * 供 LpCombat.drawMuzzleFlash / 卫士塔复用；未就绪时调用方回退程序化焰舌。
 */
(() => {
  const BASE = '/static/games/liminal-platform/img/particles';
  const ASSET_V = '1';

  /**
   * 枪口暖色板（相对 Kenney 原白片调色）：外橙 → 中琥珀 → 核淡黄。
   * 阈限车厢偏冷灰，火光略偏琥珀以免发粉发紫。
   */
  const TINT = {
    outer: '#e85a12',
    mid: '#ff9a28',
    core: '#fff1b8',
  };

  const MUZZLE_URLS = [
    `${BASE}/muzzle_01.png?v=${ASSET_V}`,
    `${BASE}/muzzle_02.png?v=${ASSET_V}`,
    `${BASE}/muzzle_03.png?v=${ASSET_V}`,
    `${BASE}/muzzle_04.png?v=${ASSET_V}`,
  ];
  const FLARE_URL = `${BASE}/flare_01.png?v=${ASSET_V}`;

  /** @type {HTMLCanvasElement[]} */
  const muzzleTinted = [];
  /** @type {HTMLCanvasElement|null} */
  let flareTinted = null;
  let ready = false;

  /**
   * 将白灰透明精灵染成指定色（保留 alpha 轮廓）。
   * @param {CanvasImageSource} src
   * @param {string} color CSS 颜色
   * @returns {HTMLCanvasElement}
   */
  function tintSprite(src, color) {
    const w = /** @type {HTMLImageElement} */ (src).naturalWidth || src.width;
    const h = /** @type {HTMLImageElement} */ (src).naturalHeight || src.height;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = color;
    g.fillRect(0, 0, w, h);
    return c;
  }

  /**
   * 加载单张图；失败则 reject。
   * @param {string} url
   * @returns {Promise<HTMLImageElement>}
   */
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`muzzle sprite failed: ${url}`));
      img.src = url;
    });
  }

  /**
   * 预加载并预染色所有枪口精灵（启动一次；共享 Image/Canvas，开火只 drawImage）。
   * @returns {Promise<void>}
   */
  async function preload() {
    try {
      const [flareImg, ...muzzleImgs] = await Promise.all([
        loadImage(FLARE_URL),
        ...MUZZLE_URLS.map(loadImage),
      ]);
      muzzleTinted.length = 0;
      const midTints = [TINT.mid, TINT.outer, TINT.mid, TINT.outer];
      for (let i = 0; i < muzzleImgs.length; i += 1) {
        muzzleTinted.push(tintSprite(muzzleImgs[i], midTints[i] || TINT.mid));
      }
      flareTinted = tintSprite(flareImg, TINT.core);
      ready = muzzleTinted.length > 0 && flareTinted != null;
    } catch (err) {
      ready = false;
      console.warn('[LpMuzzleFlash]', err);
    }
  }

  /**
   * 是否已可绘制精灵火光。
   * @returns {boolean}
   */
  function isReady() {
    return ready;
  }

  /**
   * 按寿命挑选枪口片索引（短促闪帧感，非真动画表）。
   * @param {number} t 剩余寿命 1→0
   * @param {number} jitter 每发随机相位
   * @returns {number}
   */
  function pickMuzzleIndex(t, jitter) {
    const n = muzzleTinted.length;
    if (n <= 0) return 0;
    const phase = (1 - t) * 3.7 + (jitter || 0) * 1.7;
    return Math.abs(Math.floor(phase)) % n;
  }

  /**
   * 在炮口绘制调色后的 Kenney 火光（调用前 ctx 已 translate 到炮口；本函数再 rotate）。
   * Kenney muzzle 朝图像上方，底边为枪口锚点；故 rotate(angle + π/2)。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{
   *   angle?: number,
   *   t: number,
   *   flashR?: number,
   *   jitter?: number,
   *   scale?: number,
   * }} opts
   */
  function drawSprites(ctx, opts) {
    if (!ready || !flareTinted || muzzleTinted.length === 0) return;
    const t = Math.max(0, Math.min(1, Number(opts.t) || 0));
    if (t <= 0.001) return;
    const age = 1 - t;
    const punch = Math.max(0, 1 - age / 0.3);
    const tongue = Math.pow(t, 0.8);
    const coreFade = punch * 0.55 + t * t * 0.45;
    const flashR = (opts.flashR ?? 16) * (opts.scale ?? 1);
    const size = flashR * (2.35 + 0.55 * punch + 0.25 * t);
    const jitter = opts.jitter || 0;
    const muzzle = muzzleTinted[pickMuzzleIndex(t, jitter)];

    ctx.save();
    ctx.rotate((opts.angle || 0) + Math.PI / 2);
    ctx.globalCompositeOperation = 'lighter';

    /* 主焰舌：底边锚在炮口，沿瞄准方向伸出 */
    ctx.globalAlpha = 0.72 * tongue + 0.18 * punch;
    ctx.drawImage(muzzle, -size * 0.5, -size * 0.92, size, size);

    /* 第二层略缩小 + 微抖，叠出瞬时厚度 */
    const size2 = size * (0.62 + 0.12 * punch);
    ctx.globalAlpha = 0.45 * coreFade;
    ctx.rotate(jitter * 0.08);
    ctx.drawImage(
      muzzleTinted[(pickMuzzleIndex(t, jitter) + 1) % muzzleTinted.length],
      -size2 * 0.5,
      -size2 * 0.88,
      size2,
      size2
    );

    /* 核部十字 flare：略前移，偏亮核黄 */
    const flareS = flashR * (1.15 + 0.85 * punch);
    ctx.globalAlpha = 0.9 * coreFade;
    ctx.drawImage(flareTinted, flareS * 0.15 - flareS * 0.5, -flareS * 0.5, flareS, flareS);

    ctx.restore();
  }

  preload();

  window.LpMuzzleFlash = {
    preload,
    isReady,
    drawSprites,
    TINT,
  };
})();
