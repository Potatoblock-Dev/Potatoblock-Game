/**
 * UV 绘画参考模板：关节节点 + 矩形连线 + 分色标注。
 * 与 UVLayout.PARTS 同源；下载的 PNG 可被「导入完整 UV」按 rect 解析。
 */
(() => {
  const JOINT_FILL = '#111827';
  const JOINT_RING = '#f8fafc';
  const GUIDE = '#94a3b8';

  function hexToRgb(hex) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  function withAlpha(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function paintJoint(ctx, x, y, radius) {
    ctx.fillStyle = JOINT_FILL;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = JOINT_RING;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** 四肢：上下关节 + 中间色块矩形连线。 */
  function paintLimb(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    const midX = cx + cw / 2;
    const jointR = Math.max(4, Math.floor(cw * 0.2));
    const topY = cy + jointR + 1;
    const botY = cy + ch - jointR - 1;
    const boneW = Math.max(6, Math.floor(cw * 0.42));

    ctx.fillStyle = withAlpha(part.color, 0.92);
    ctx.fillRect(midX - boneW / 2, topY, boneW, Math.max(4, botY - topY));

    paintJoint(ctx, midX, topY, jointR);
    paintJoint(ctx, midX, botY, jointR);
  }

  /** 身体：色块 + 肩/髋关节。 */
  function paintBody(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    ctx.fillStyle = withAlpha(part.color, 0.88);
    ctx.fillRect(cx, cy, cw, ch);

    const jointR = 6;
    const shoulderY = cy + 10;
    const hipY = cy + ch - 12;
    paintJoint(ctx, cx + cw * 0.22, shoulderY, jointR);
    paintJoint(ctx, cx + cw * 0.78, shoulderY, jointR);
    paintJoint(ctx, cx + cw * 0.3, hipY, jointR);
    paintJoint(ctx, cx + cw * 0.7, hipY, jointR);

    // 肩→髋的示意矩形（躯干中轴）
    const spineW = Math.max(10, Math.floor(cw * 0.18));
    ctx.fillStyle = withAlpha(part.color, 0.55);
    ctx.fillRect(cx + (cw - spineW) / 2, shoulderY, spineW, Math.max(4, hipY - shoulderY));
  }

  /** 头部：脸部色块 + 颈关节；朝右眼点。 */
  function paintHead(ctx, part) {
    const [cx, cy, cw, ch] = part.coreRect;
    ctx.fillStyle = withAlpha(part.color, 0.92);
    ctx.fillRect(cx, cy, cw, ch);

    ctx.fillStyle = JOINT_FILL;
    const eyeW = Math.max(5, cw * 0.12);
    const eyeH = Math.max(5, ch * 0.14);
    ctx.fillRect(cx + cw * 0.62, cy + ch * 0.32, eyeW, eyeH);

    paintJoint(ctx, cx + cw / 2, cy + ch - 3, 5);
  }

  function paintSlotGuides(ctx, part) {
    const [x, y, w, h] = part.rect;
    ctx.strokeStyle = part.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

    if (part.coreRect) {
      const [cx, cy, cw, ch] = part.coreRect;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = withAlpha(part.color, 0.75);
      ctx.lineWidth = 1;
      ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
      ctx.restore();
    }
  }

  function paintLabels(ctx, part) {
    const [x, y, w] = part.rect;
    const code = part.code || '';
    const line = part.tagLine || part.label;

    ctx.textBaseline = 'top';
    ctx.fillStyle = part.color;
    ctx.font = 'bold 13px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillText(code, x + 6, y + 6);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '10px system-ui, sans-serif';
    // 长标注在窄槽里换行感：单行截断到槽宽
    const maxWidth = w - 12;
    let text = line;
    while (text.length > 3 && ctx.measureText(text).width > maxWidth) {
      text = text.slice(0, -2);
    }
    if (text !== line) text = `${text}…`;
    ctx.fillText(text, x + 6, y + 22);
  }

  /**
   * 把标准绘画模板画到 4:3 canvas（透明底，右侧留白）。
   * @returns {HTMLCanvasElement}
   */
  function renderTemplateCanvas() {
    const layout = window.UVLayout;
    const canvas = document.createElement('canvas');
    canvas.width = layout.ATLAS_WIDTH;
    canvas.height = layout.ATLAS_HEIGHT;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const part of Object.values(layout.PARTS)) {
      paintSlotGuides(ctx, part);
      if (part.kind === 'limb') paintLimb(ctx, part);
      else if (part.kind === 'body') paintBody(ctx, part);
      else if (part.kind === 'head') paintHead(ctx, part);
      paintLabels(ctx, part);
    }

    // 图例放在右侧留白区
    ctx.fillStyle = GUIDE;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const legendX = layout.CONTENT_WIDTH + 12;
    const legendY = 24;
    ctx.fillText('绘画模板 v5 · 4:3', legendX, legendY);
    ctx.fillText('左侧 = 部位槽', legendX, legendY + 16);
    ctx.fillText('右侧 = 留白', legendX, legendY + 32);
    ctx.fillText('实线框 = 读取范围', legendX, legendY + 56);
    ctx.fillText('虚线框 = 推荐区', legendX, legendY + 72);
    ctx.fillText('圆点 = 关节', legendX, legendY + 88);
    ctx.fillText('色块矩形 = 骨骼连线', legendX, legendY + 104);
    ctx.fillText('朝右：RA/RL=右侧', legendX, legendY + 128);
    ctx.fillText('LA/LL=左侧', legendX, legendY + 144);

    return canvas;
  }

  /** 触发浏览器下载模板 PNG。 */
  function downloadTemplate(filename = 'avatar-uv-paint-template-v5.png') {
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
