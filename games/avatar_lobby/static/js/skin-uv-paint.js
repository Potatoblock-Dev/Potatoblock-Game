/**
 * 皮套 UV 画板：复用你画我猜 DrawingBoard，在 Avatar 编辑器内画整张 683×512 UV。
 * 画完结果走 SkinEditorApi.applyAtlasImage，与「导入完整 UV」同一管线。
 */
(() => {
  const layout = window.UVLayout;
  const OWNER_ID = 'skin-painter';
  const PALETTE = [
    '#ef4444', '#f97316', '#facc15', '#22c55e',
    '#3b82f6', '#a855f7', '#111827', '#ffffff',
    '#f8fafc', '#94a3b8', '#78716c', '#f472b6',
  ];

  const root = document.getElementById('skinUvPaint');
  const openButton = document.getElementById('editorOpenUvPaintButton');
  const closeButton = document.getElementById('uvPaintCloseButton');
  const applyButton = document.getElementById('uvPaintApplyButton');
  const clearButton = document.getElementById('uvPaintClearButton');
  const undoButton = document.getElementById('uvPaintUndoButton');
  const redoButton = document.getElementById('uvPaintRedoButton');
  const guideToggle = document.getElementById('uvPaintGuideToggle');
  const canvas = document.getElementById('uvPaintCanvas');
  const guideCanvas = document.getElementById('uvPaintGuideCanvas');
  const paletteEl = document.getElementById('uvPaintPalette');
  const colorPicker = document.getElementById('uvPaintColorPicker');
  const sizeInput = document.getElementById('uvPaintSizeInput');
  const statusEl = document.getElementById('uvPaintStatus');
  const stage = document.getElementById('uvPaintStage');

  if (!root || !canvas || typeof window.DrawingBoard !== 'function') return;

  const board = new window.DrawingBoard(canvas, {
    width: layout.ATLAS_WIDTH,
    height: layout.ATLAS_HEIGHT,
    transparent: true,
    background: '#ffffff',
    onError: (message) => setStatus(message, true),
  });

  let strokes = [];
  let redoStack = [];
  let tool = 'brush';
  let color = '#111827';
  let brushSize = 5;
  let drawing = false;
  let strokeId = null;
  let lastPoint = null;
  let guideVisible = true;
  let previewTimer = null;

  /** 更新状态栏文案。 */
  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('is-error', isError);
  }

  /** 刷新工具按钮的选中态。 */
  function syncToolButtons() {
    for (const button of root.querySelectorAll('[data-uv-tool]')) {
      const active = button.dataset.uvTool === tool;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  /** 刷新色板选中态与色轮值。 */
  function syncColorUi() {
    colorPicker.value = color;
    for (const chip of paletteEl.querySelectorAll('.uv-paint-chip')) {
      chip.classList.toggle('is-active', chip.dataset.color === color);
    }
  }

  /** 把 UV 模板画到引导层（不进入导出）。 */
  function paintGuideOverlay() {
    guideCanvas.width = layout.ATLAS_WIDTH;
    guideCanvas.height = layout.ATLAS_HEIGHT;
    const template = window.UVTemplate.renderTemplateCanvas();
    const ctx = guideCanvas.getContext('2d');
    ctx.clearRect(0, 0, guideCanvas.width, guideCanvas.height);
    ctx.globalAlpha = 0.55;
    ctx.drawImage(template, 0, 0);
    ctx.globalAlpha = 1;
  }

  /** 切换模板引导层显隐。 */
  function setGuideVisible(visible) {
    guideVisible = visible;
    guideCanvas.classList.toggle('hidden', !visible);
    guideToggle.setAttribute('aria-pressed', visible ? 'true' : 'false');
    guideToggle.textContent = visible ? '隐藏模板' : '显示模板';
  }

  /** 重绘笔迹并刷新舞台预览。 */
  function redraw() {
    board.setStrokes(strokes, true);
    schedulePreview();
  }

  /** 节流：把当前画板内容预览到舞台小人。 */
  function schedulePreview() {
    if (previewTimer) return;
    previewTimer = window.setTimeout(() => {
      previewTimer = null;
      if (root.classList.contains('hidden')) return;
      window.StageAvatar.previewUvAtlas(canvas);
    }, 80);
  }

  /** 指针坐标 → 画板归一化点。 */
  function pointerPoint(event) {
    return board.normalizePoint(event.clientX, event.clientY);
  }

  /** 追加一段笔迹并即时绘制。 */
  function paintSegment(segment) {
    board.appendSegment(strokes, OWNER_ID, strokeId, segment);
    if (segment.tool === 'fill') {
      board.floodFill(segment);
    } else {
      board.drawSegment(segment);
    }
    schedulePreview();
  }

  /** 开始一笔（画笔/橡皮连续线，或填充单次）。 */
  function beginStroke(event) {
    if (root.classList.contains('hidden')) return;
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const point = pointerPoint(event);
    strokeId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    redoStack = [];
    if (tool === 'fill') {
      paintSegment({ tool: 'fill', x: point.x, y: point.y, color });
      strokeId = null;
      return;
    }
    drawing = true;
    lastPoint = point;
    canvas.setPointerCapture(event.pointerId);
    paintSegment({
      tool,
      x1: point.x,
      y1: point.y,
      x2: point.x,
      y2: point.y,
      color,
      size: brushSize,
    });
  }

  /** 拖动续写当前笔。 */
  function moveStroke(event) {
    if (!drawing || !lastPoint || !strokeId) return;
    const point = pointerPoint(event);
    const dx = point.x - lastPoint.x;
    const dy = point.y - lastPoint.y;
    const minDist = 0.5 / Math.max(board.logicalWidth, board.logicalHeight, 1);
    if ((dx * dx + dy * dy) < (minDist * minDist)) return;
    paintSegment({
      tool,
      x1: lastPoint.x,
      y1: lastPoint.y,
      x2: point.x,
      y2: point.y,
      color,
      size: brushSize,
    });
    lastPoint = point;
  }

  /** 结束当前笔。 */
  function endStroke() {
    drawing = false;
    strokeId = null;
    lastPoint = null;
  }

  /** 撤销最近一笔。 */
  function undo() {
    if (!board.undoLatest(strokes, redoStack, OWNER_ID)) return;
    redraw();
  }

  /** 重做一笔。 */
  function redo() {
    if (!board.redoLatest(redoStack)) return;
    redraw();
  }

  /** 清空画布（保留透明底）。 */
  function clearBoard() {
    strokes = [];
    redoStack = [];
    board.setStrokes([], true);
    schedulePreview();
    setStatus('画布已清空');
  }

  /** 打开 UV 画板全屏层。 */
  function openPaint() {
    if (typeof window.SkinEditorApi?.ensureOpen === 'function') {
      window.SkinEditorApi.ensureOpen();
    }
    root.classList.remove('hidden');
    paintGuideOverlay();
    setGuideVisible(true);
    redraw();
    setStatus(`在 ${layout.ATLAS_WIDTH}×${layout.ATLAS_HEIGHT} 透明 UV 上绘制，完成后点「应用到编辑器」`);
    window.dispatchEvent(new CustomEvent('stagepanelchange', {
      detail: { id: 'skinUvPaint', open: true },
    }));
  }

  /** 关闭画板（不丢笔迹，便于再次打开继续）。 */
  function closePaint() {
    endStroke();
    root.classList.add('hidden');
    window.dispatchEvent(new CustomEvent('stagepanelchange', {
      detail: { id: 'skinUvPaint', open: false },
    }));
  }

  /** 导出透明 PNG 并交给皮套编辑器按完整 UV 解析。 */
  async function applyToEditor() {
    setStatus('应用中…');
    const blob = await board.exportBlob(layout.ATLAS_WIDTH, 'image/png', 1);
    if (!blob) {
      setStatus('导出失败', true);
      return;
    }
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      const ok = window.SkinEditorApi.applyAtlasImage(image, '画板绘制 UV');
      if (ok) {
        setStatus('已应用到编辑器，可继续微调或生成皮套');
        closePaint();
      } else {
        setStatus('应用到编辑器失败', true);
        URL.revokeObjectURL(url);
      }
    };
    image.onerror = () => {
      setStatus('预览图加载失败', true);
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }

  /** 构建色板芯片。 */
  function buildPalette() {
    paletteEl.replaceChildren(...PALETTE.map((hex) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'uv-paint-chip';
      button.dataset.color = hex;
      button.style.background = hex;
      button.setAttribute('aria-label', hex);
      button.addEventListener('click', () => {
        color = hex;
        syncColorUi();
      });
      return button;
    }));
  }

  openButton?.addEventListener('click', openPaint);
  closeButton.addEventListener('click', closePaint);
  applyButton.addEventListener('click', () => {
    applyToEditor().catch((error) => setStatus(error.message || '应用失败', true));
  });
  clearButton.addEventListener('click', clearBoard);
  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  guideToggle.addEventListener('click', () => setGuideVisible(!guideVisible));

  for (const button of root.querySelectorAll('[data-uv-tool]')) {
    button.addEventListener('click', () => {
      tool = button.dataset.uvTool;
      syncToolButtons();
    });
  }

  colorPicker.addEventListener('input', () => {
    color = colorPicker.value.toLowerCase();
    syncColorUi();
  });
  sizeInput.addEventListener('input', () => {
    brushSize = Math.max(1, Math.min(32, Number(sizeInput.value) || 5));
    sizeInput.value = String(brushSize);
  });

  canvas.addEventListener('pointerdown', beginStroke);
  canvas.addEventListener('pointermove', moveStroke);
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
    canvas.addEventListener(eventName, endStroke);
  }

  window.addEventListener('keydown', (event) => {
    if (root.classList.contains('hidden')) return;
    if (event.target instanceof HTMLInputElement) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.code === 'KeyZ' && !event.shiftKey) {
      event.preventDefault();
      undo();
      return;
    }
    if (mod && (event.code === 'KeyY' || (event.code === 'KeyZ' && event.shiftKey))) {
      event.preventDefault();
      redo();
      return;
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      closePaint();
      return;
    }
    if (event.code === 'KeyB') tool = 'brush';
    if (event.code === 'KeyE') tool = 'eraser';
    if (event.code === 'KeyG') tool = 'fill';
    syncToolButtons();
  });

  // 防止在画板上拖出页面滚动
  stage.addEventListener('touchmove', (event) => {
    if (event.target === canvas) event.preventDefault();
  }, { passive: false });

  buildPalette();
  syncToolButtons();
  syncColorUi();
  board.setStrokes([], true);

  window.SkinUvPaint = { open: openPaint, close: closePaint };
})();
