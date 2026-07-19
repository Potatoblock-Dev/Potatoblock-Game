/**
 * UV 模板图：只含骨骼节点与节点间色块，读取区留白与槽位一致，槽间有分割线。
 * 与 UVLayout.PARTS 同源，下载的 PNG 可被「导入完整 UV」直接按 rect 解析。
 */
(() => {
  const JOINT_FILL = '#111827';
  const LINE = '#94a3b8';
  const LABEL = '#64748b';

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  /** 在推荐区内画上下关节圆与中间色块（四肢）。 */
  function paintLimb(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    const [r, g, b] = hexToRgb(part.color);
    ctx.fillStyle = `rgb(${r} ${g} ${b})`;
    const blockX = cx + Math.floor(cw * 0.2);
    const blockW = Math.max(4, Math.floor(cw * 0.6));
    const jointR = Math.max(3, Math.floor(cw * 0.18));
    const topY = cy + jointR;
    const botY = cy + ch - jointR;
    ctx.fillRect(blockX, topY, blockW, Math.max(4, botY - topY));

    ctx.fillStyle = JOINT_FILL;
    ctx.beginPath();
    ctx.arc(cx + cw / 2, topY, jointR, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx + cw / 2, botY, jointR, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 身体：色块 + 肩/髋节点。 */
  function paintBody(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    ctx.fillStyle = part.color;
    ctx.fillRect(cx, cy, cw, ch);
    const jointR = 5;
    ctx.fillStyle = JOINT_FILL;
    // 双肩
    ctx.beginPath();
    ctx.arc(cx + cw * 0.2, cy + 8, jointR, 0, Math.PI * 2);
    ctx.arc(cx + cw * 0.8, cy + 8, jointR, 0, Math.PI * 2);
    ctx.fill();
    // 双髋
    ctx.beginPath();
    ctx.arc(cx + cw * 0.28, cy + ch - 10, jointR, 0, Math.PI * 2);
    ctx.arc(cx + cw * 0.72, cy + ch - 10, jointR, 0, Math.PI * 2);
    ctx.fill();
  }

  /** 头部：推荐脸部色块 + 颈关节；整身读取区其余留白。 */
  function paintHead(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    ctx.fillStyle = part.color;
    ctx.fillRect(cx, cy, cw, ch);
    // 眼睛标记，方便辨认朝向
    ctx.fillStyle = JOINT_FILL;
    ctx.fillRect(cx + cw * 0.62, cy + ch * 0.32, Math.max(6, cw * 0.12), Math.max(6, ch * 0.14));
    // 颈关节（脸部下沿中点）
    ctx.beginPath();
    ctx.arc(cx + cw / 2, cy + ch - 4, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 把标准模板画到 512×512 canvas（透明底）。
   * @returns {HTMLCanvasElement}
   */
  function renderTemplateCanvas() {
    const layout = window.UVLayout;
    const canvas = document.createElement('canvas');
    canvas.width = layout.ATLAS_SIZE;
    canvas.height = layout.ATLAS_SIZE;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (const part of Object.values(layout.PARTS)) {
      const [x, y, w, h] = part.rect;
      // 槽位分割线（读取范围边界）
      ctx.strokeStyle = LINE;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

      // 推荐区虚线框
      if (part.coreRect) {
        const [cx, cy, cw, ch] = part.coreRect;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
        ctx.restore();
      }

      if (part.kind === 'limb') paintLimb(ctx, part);
      else if (part.kind === 'body') paintBody(ctx, part);
      else if (part.kind === 'head') paintHead(ctx, part);

      ctx.fillStyle = LABEL;
      ctx.fillText(part.label, x + 4, y + 4);
    }

    // 页脚说明（画在空白区）
    ctx.fillStyle = LABEL;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('UV 模板 v2 · 实线=读取范围 · 虚线=推荐区 · 圆点=骨骼节点', 8, 492);

    return canvas;
  }

  /** 触发浏览器下载模板 PNG。 */
  function downloadTemplate(filename = 'avatar-uv-template-v2.png') {
    const canvas = renderTemplateCanvas();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    }, 'image/png');
  }

  window.UVTemplate = { renderTemplateCanvas, downloadTemplate };
})();
