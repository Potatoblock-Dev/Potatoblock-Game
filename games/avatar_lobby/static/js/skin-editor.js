/**
 * 皮套 UV 图编辑器：导入素材 → 拖拽裁剪 → 分配部位 → 平移微调 → 合成上传。
 *
 * 版式由 uv-layout.js 定义；合成结果画在离屏 canvas 上，
 * 编辑期间直接挂到舞台小人做实时预览，导出时转成 PNG 走皮套上传接口。
 */
(() => {
  const layout = window.UVLayout;
  const editor = document.getElementById('skinEditor');
  const openButton = document.getElementById('openSkinEditorButton');
  const closeButton = document.getElementById('closeSkinEditorButton');
  const importInput = document.getElementById('editorImportInput');
  const atlasImportInput = document.getElementById('editorAtlasImportInput');
  const downloadTemplateButton = document.getElementById('editorDownloadTemplateButton');
  const sourceList = document.getElementById('editorSourceList');
  const cropCanvas = document.getElementById('editorCropCanvas');
  const cropCtx = cropCanvas.getContext('2d');
  const cropHint = document.getElementById('editorCropHint');
  const cropFullscreenButton = document.getElementById('editorCropFullscreenButton');
  const cropExitButton = document.getElementById('editorCropExitButton');
  const partList = document.getElementById('editorPartList');
  const partHint = document.getElementById('editorPartHint');
  const clearPartButton = document.getElementById('editorClearPartButton');
  const resetPositionButton = document.getElementById('editorResetPositionButton');
  const positionValue = document.getElementById('editorPositionValue');
  const partScaleInput = document.getElementById('editorPartScaleInput');
  const partScaleValue = document.getElementById('editorPartScaleValue');
  const partStretchXInput = document.getElementById('editorPartStretchXInput');
  const partStretchXValue = document.getElementById('editorPartStretchXValue');
  const partStretchYInput = document.getElementById('editorPartStretchYInput');
  const partStretchYValue = document.getElementById('editorPartStretchYValue');
  const resetTransformButton = document.getElementById('editorResetTransformButton');
  const atlasCanvas = document.getElementById('editorAtlasCanvas');
  atlasCanvas.width = layout.ATLAS_WIDTH;
  atlasCanvas.height = layout.ATLAS_HEIGHT;
  const atlasCtx = atlasCanvas.getContext('2d');
  const exportForm = document.getElementById('editorExportForm');
  const skinNameInput = document.getElementById('editorSkinNameInput');
  const heightScaleInput = document.getElementById('editorHeightScaleInput');
  const heightScaleValue = document.getElementById('editorHeightScaleValue');
  const statusLabel = document.getElementById('editorStatus');

  // 导出用的干净合成图；可见的 atlasCanvas 上还会叠加槽位参考线。
  const atlasBuffer = document.createElement('canvas');
  atlasBuffer.width = layout.ATLAS_WIDTH;
  atlasBuffer.height = layout.ATLAS_HEIGHT;
  const bufferCtx = atlasBuffer.getContext('2d');

  const sources = [];       // { id, name, image }
  // 每个部位保存独立素材、裁剪区、目标槽平移与缩放参数。
  const assignments = {};   // partId -> crop + offset + scale/stretch + fitMode
  let nextSourceId = 1;
  let activeSourceId = null;
  let activePartId = null;
  let cropRect = null;      // 当前框选区域（源图像素坐标）
  let cropRectDirty = false; // true = 用户新拖的框，尚未应用到部位
  let cropDragStart = null;
  let editorSkinId = null;  // 本次会话已保存皮套的 id，用于重复保存时覆盖更新

  function setStatus(text, isError = false) {
    statusLabel.textContent = text;
    statusLabel.classList.toggle('is-error', isError);
  }

  function activeSource() {
    return sources.find((source) => source.id === activeSourceId) || null;
  }

  function currentHeightScale() {
    return Number(heightScaleInput.value) / 100;
  }

  function updateHeightPreview() {
    heightScaleValue.value = `${heightScaleInput.value}%`;
    if (!editor.classList.contains('hidden')) {
      window.StageAvatar.previewHeightScale(currentHeightScale());
    }
  }

  heightScaleInput.addEventListener('input', updateHeightPreview);

  // ---- 打开 / 关闭 ----

  function notifyEditorState(open) {
    window.dispatchEvent(new CustomEvent('stagepanelchange', {
      detail: { id: 'skinEditor', open },
    }));
  }

  function openEditor() {
    window.StageUI.closeAllPanels();
    editor.classList.remove('hidden');
    notifyEditorState(true);
    composeAndPreview();
  }

  function closeEditor() {
    setCropFullscreen(false);
    editor.classList.add('hidden');
    notifyEditorState(false);
    window.StageAvatar.endPreview();
  }

  openButton.addEventListener('click', openEditor);
  closeButton.addEventListener('click', closeEditor);
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'Escape' || editor.classList.contains('hidden')) return;
    // 全屏裁剪时 Esc 先退出全屏，再按一次才关闭编辑器。
    if (cropFullscreen) {
      setCropFullscreen(false);
    } else {
      closeEditor();
    }
  });

  // ---- 全屏裁剪 ----

  const CROP_CANVAS_SIZE = { width: 480, height: 300 };
  let cropFullscreen = false;

  // 全屏时画布按视口分辨率重建，素材以更大比例显示，便于精确框选。
  function setCropFullscreen(active) {
    if (cropFullscreen === active) return;
    cropFullscreen = active;
    cropCanvas.classList.toggle('is-fullscreen', active);
    cropExitButton.classList.toggle('hidden', !active);
    cropFullscreenButton.textContent = active ? '退出全屏' : '全屏裁剪';
    cropCanvas.width = active ? window.innerWidth : CROP_CANVAS_SIZE.width;
    cropCanvas.height = active ? window.innerHeight : CROP_CANVAS_SIZE.height;
    drawCropCanvas();
  }

  cropFullscreenButton.addEventListener('click', () => setCropFullscreen(!cropFullscreen));
  cropExitButton.addEventListener('click', () => setCropFullscreen(false));
  window.addEventListener('resize', () => {
    if (!cropFullscreen) return;
    cropCanvas.width = window.innerWidth;
    cropCanvas.height = window.innerHeight;
    drawCropCanvas();
  });

  // ---- 素材导入与选择 ----

  importInput.addEventListener('change', () => {
    for (const file of importInput.files) {
      const image = new Image();
      image.onload = () => {
        sources.push({ id: nextSourceId, name: file.name, image });
        activeSourceId = nextSourceId;
        nextSourceId += 1;
        cropRect = null;
        cropRectDirty = false;
        renderSources();
        drawCropCanvas();
      };
      image.src = URL.createObjectURL(file);
    }
    importInput.value = '';
  });

  downloadTemplateButton.addEventListener('click', () => {
    window.UVTemplate.downloadTemplate();
    setStatus('已下载 UV 模板（可直接「导入完整 UV」解析）');
  });

  // 完整 UV 已经包含各部位槽位，不再走手动裁剪；拆成各槽 assignment
  // 可继续使用现有平移、预览和导出流程。
  atlasImportInput.addEventListener('change', () => {
    const file = atlasImportInput.files[0];
    if (!file) return;
    const image = new Image();
    image.onload = () => {
      const squareLegacy = image.width === 512 && image.height === 512;
      const matchesLayout = image.width === layout.ATLAS_WIDTH && image.height === layout.ATLAS_HEIGHT;
      if (!matchesLayout && !squareLegacy) {
        setStatus(`完整 UV 须为 ${layout.ATLAS_WIDTH}×${layout.ATLAS_HEIGHT}（4:3）或旧版 512×512`, true);
        URL.revokeObjectURL(image.src);
        return;
      }

      const sourceId = nextSourceId;
      sources.push({ id: sourceId, name: `${file.name}（完整 UV）`, image });
      activeSourceId = sourceId;
      nextSourceId += 1;
      cropRect = null;
      cropRectDirty = false;
      const importParts = layout.resolveParts(image);
      for (const [partId, part] of Object.entries(importParts)) {
        const [sx, sy, sw, sh] = part.rect;
        assignments[partId] = {
          sourceId, sx, sy, sw, sh,
          offsetX: 0, offsetY: 0,
          scale: 1, stretchX: 1, stretchY: 1,
          fitMode: 'exact',
        };
      }
      activePartId = null;
      renderSources();
      renderParts();
      drawCropCanvas();
      composeAndPreview();
      setStatus(`已载入完整 UV：${file.name}（${image._uvLayoutId || 'auto'}）`);
      partHint.textContent = '完整 UV 已按图集版式自动分配到全部部位，可直接预览或生成皮套';
    };
    image.src = URL.createObjectURL(file);
    atlasImportInput.value = '';
  });

  function renderSources() {
    sourceList.replaceChildren(...sources.map((source) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.classList.toggle('is-active', source.id === activeSourceId);
      const thumb = document.createElement('img');
      thumb.src = source.image.src;
      thumb.alt = source.name;
      const name = document.createElement('span');
      name.textContent = source.name;
      const assignedParts = Object.entries(assignments)
        .filter(([, assignment]) => assignment.sourceId === source.id)
        .map(([partId]) => layout.PARTS[partId].label);
      const category = document.createElement('small');
      const categoryText = assignedParts.length > 0
        ? assignedParts.join('、')
        : '未分类';
      category.textContent = `${source.image.width}×${source.image.height} · ${categoryText}`;
      button.append(thumb, name, category);
      button.addEventListener('click', () => {
        activeSourceId = source.id;
        cropRect = null;
        cropRectDirty = false;
        renderSources();
        drawCropCanvas();
      });
      item.append(button);
      return item;
    }));
  }

  // ---- 裁剪画布 ----

  // 源图在裁剪画布上的等比缩放与居中偏移。
  function cropViewTransform(image) {
    const scale = Math.min(cropCanvas.width / image.width, cropCanvas.height / image.height);
    return {
      scale,
      offsetX: (cropCanvas.width - image.width * scale) / 2,
      offsetY: (cropCanvas.height - image.height * scale) / 2,
    };
  }

  // PointerEvent → 源图像素坐标（画布 CSS 尺寸可能被拉伸，先换算回内部坐标）。
  function pointerToImage(event, image) {
    const bounds = cropCanvas.getBoundingClientRect();
    const canvasX = (event.clientX - bounds.left) * (cropCanvas.width / bounds.width);
    const canvasY = (event.clientY - bounds.top) * (cropCanvas.height / bounds.height);
    const view = cropViewTransform(image);
    return {
      x: Math.max(0, Math.min(image.width, (canvasX - view.offsetX) / view.scale)),
      y: Math.max(0, Math.min(image.height, (canvasY - view.offsetY) / view.scale)),
    };
  }

  function drawCropCanvas() {
    cropCtx.fillStyle = '#0b1220';
    cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
    const source = activeSource();
    if (!source) {
      cropHint.textContent = '导入并选中一张图片后开始裁剪';
    } else if (cropRectDirty) {
      cropHint.textContent = '裁剪区已选择，请在步骤 3 点击匹配的身体部位';
    } else if (cropRect) {
      cropHint.textContent = '黄色框是已选部位的裁剪区；拖拽新框可重新调整';
    } else {
      cropHint.textContent = '先拖拽选择裁剪区，再选择匹配部位（自动吸附，按住 Alt 关闭）';
    }
    if (!source) return;

    const view = cropViewTransform(source.image);
    cropCtx.imageSmoothingEnabled = true;
    cropCtx.drawImage(
      source.image,
      view.offsetX, view.offsetY,
      source.image.width * view.scale, source.image.height * view.scale
    );
    drawAssignedCropBoxes(source, view);
    if (cropRect) {
      cropCtx.save();
      cropCtx.strokeStyle = '#fbbf24';
      cropCtx.lineWidth = 2;
      cropCtx.setLineDash([6, 4]);
      cropCtx.strokeRect(
        view.offsetX + cropRect.sx * view.scale,
        view.offsetY + cropRect.sy * view.scale,
        cropRect.sw * view.scale,
        cropRect.sh * view.scale
      );
      cropCtx.restore();
    }
    drawSnapGuides(view, source);
  }

  // 已应用到各部位的裁剪框以灰色常驻显示，方便对照与再次调整。
  function drawAssignedCropBoxes(source, view) {
    cropCtx.save();
    cropCtx.lineWidth = 1;
    cropCtx.font = '11px sans-serif';
    for (const [partId, assignment] of Object.entries(assignments)) {
      if (assignment.sourceId !== source.id) continue;
      const x = view.offsetX + assignment.sx * view.scale;
      const y = view.offsetY + assignment.sy * view.scale;
      const w = assignment.sw * view.scale;
      const h = assignment.sh * view.scale;
      cropCtx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
      cropCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      cropCtx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      cropCtx.fillText(layout.PARTS[partId].label, x + 3, y + 12);
    }
    cropCtx.restore();
  }

  // ---- 自动对齐（吸附）----

  let snapGuides = { x: null, y: null }; // 命中吸附时的参考线位置（源图坐标）

  function drawSnapGuides(view, source) {
    if (snapGuides.x === null && snapGuides.y === null) return;
    cropCtx.save();
    cropCtx.strokeStyle = '#22d3ee';
    cropCtx.lineWidth = 1;
    cropCtx.setLineDash([4, 4]);
    if (snapGuides.x !== null) {
      const x = view.offsetX + snapGuides.x * view.scale;
      cropCtx.beginPath();
      cropCtx.moveTo(x, view.offsetY);
      cropCtx.lineTo(x, view.offsetY + source.image.height * view.scale);
      cropCtx.stroke();
    }
    if (snapGuides.y !== null) {
      const y = view.offsetY + snapGuides.y * view.scale;
      cropCtx.beginPath();
      cropCtx.moveTo(view.offsetX, y);
      cropCtx.lineTo(view.offsetX + source.image.width * view.scale, y);
      cropCtx.stroke();
    }
    cropCtx.restore();
  }

  cropCanvas.addEventListener('pointerdown', (event) => {
    const source = activeSource();
    if (!source) return;
    const view = cropViewTransform(source.image);
    const raw = pointerToImage(event, source.image);
    cropDragStart = window.SkinEditorUtils.snapPoint(
      raw, source, view, event.altKey, assignments
    ).point;
    cropRect = { sx: cropDragStart.x, sy: cropDragStart.y, sw: 0, sh: 0 };
    cropCanvas.setPointerCapture(event.pointerId);
    drawCropCanvas();
  });

  cropCanvas.addEventListener('pointermove', (event) => {
    if (!cropDragStart) return;
    const source = activeSource();
    const view = cropViewTransform(source.image);
    const raw = pointerToImage(event, source.image);
    const snapped = window.SkinEditorUtils.snapPoint(
      raw, source, view, event.altKey, assignments
    );
    snapGuides = { x: snapped.guideX, y: snapped.guideY };
    const point = snapped.point;
    cropRect = {
      sx: Math.min(cropDragStart.x, point.x),
      sy: Math.min(cropDragStart.y, point.y),
      sw: Math.abs(point.x - cropDragStart.x),
      sh: Math.abs(point.y - cropDragStart.y),
    };
    drawCropCanvas();
  });

  for (const eventName of ['pointerup', 'pointercancel']) {
    cropCanvas.addEventListener(eventName, () => {
      if (!cropDragStart) return;
      cropDragStart = null;
      snapGuides = { x: null, y: null };
      // 框太小视为误触，回退为未框选（分配时用整张图）。
      if (cropRect.sw < 2 || cropRect.sh < 2) {
        cropRect = null;
        cropRectDirty = false;
      } else {
        cropRectDirty = true;
      }
      renderParts();
      drawCropCanvas();
    });
  }

  // ---- 部位分配与平移 ----

  function renderParts() {
    partList.replaceChildren(...Object.entries(layout.PARTS).map(([partId, part]) => {
      const button = document.createElement('button');
      button.type = 'button';
      const partName = document.createElement('span');
      partName.textContent = part.label;
      const assignment = assignments[partId];
      const sourceName = document.createElement('small');
      sourceName.textContent = assignment
        ? sources.find((source) => source.id === assignment.sourceId).name
        : '未分配';
      button.append(partName, sourceName);
      button.classList.toggle('is-active', partId === activePartId);
      button.classList.toggle('is-assigned', Boolean(assignment));
      button.classList.toggle('is-target-choice', cropRectDirty);
      button.addEventListener('click', () => assignToPart(partId));
      return button;
    }));
    updatePositionLabel();
    updateTransformControls();
  }

  function loadAssignedCrop(partId, assignment) {
    activeSourceId = assignment.sourceId;
    cropRect = { sx: assignment.sx, sy: assignment.sy, sw: assignment.sw, sh: assignment.sh };
    cropRectDirty = false;
    const label = layout.PARTS[partId].label;
    partHint.textContent = `已载入 ${label} 的裁剪框；拖拽新框后再点 ${label} 应用调整`;
  }

  function applyPendingCrop(partId, source) {
    const previous = assignments[partId];
    const sameSource = previous && previous.sourceId === source.id;
    assignments[partId] = {
      sourceId: source.id,
      sx: cropRect.sx,
      sy: cropRect.sy,
      sw: cropRect.sw,
      sh: cropRect.sh,
      // 同一素材重新裁剪时，保留关节位置与尺寸调节。
      offsetX: sameSource ? previous.offsetX : 0,
      offsetY: sameSource ? previous.offsetY : 0,
      scale: sameSource ? (previous.scale ?? 1) : 1,
      stretchX: sameSource ? (previous.stretchX ?? 1) : 1,
      stretchY: sameSource ? (previous.stretchY ?? 1) : 1,
      fitMode: sameSource ? (previous.fitMode ?? 'contain') : 'contain',
    };
    cropRectDirty = false;
    const label = layout.PARTS[partId].label;
    partHint.textContent = `已把裁剪区匹配到 ${label}；可继续调整位置和大小`;
  }

  function assignToPart(partId) {
    activePartId = partId;
    const source = activeSource();
    const previous = assignments[partId];
    const label = layout.PARTS[partId].label;

    if (cropRectDirty && source && cropRect) {
      applyPendingCrop(partId, source);
    } else if (previous) {
      loadAssignedCrop(partId, previous);
    } else {
      cropRect = null;
      cropRectDirty = false;
      partHint.textContent = `请先在步骤 2 框选素材，再选择 ${label}`;
    }

    renderSources();
    renderParts();
    drawCropCanvas();
    composeAndPreview();
  }

  clearPartButton.addEventListener('click', () => {
    if (activePartId === null || !(activePartId in assignments)) return;
    delete assignments[activePartId];
    partHint.textContent = `已清除 ${layout.PARTS[activePartId].label} 的贴图`;
    renderSources();
    renderParts();
    composeAndPreview();
  });

  // 平移裁剪结果在目标部位槽中的位置；槽本身负责裁切溢出内容。
  function panActivePart(dx, dy) {
    const assignment = activePartId !== null ? assignments[activePartId] : null;
    if (!assignment) {
      partHint.textContent = '先选中一个已分配贴图的部位再平移';
      return;
    }
    const step = activePartId === 'head' ? 4 : 1;
    assignment.offsetX += dx * step;
    assignment.offsetY += dy * step;
    updatePositionLabel();
    composeAndPreview();
  }

  function updatePositionLabel() {
    const assignment = activePartId !== null ? assignments[activePartId] : null;
    positionValue.value = assignment
      ? `X ${assignment.offsetX} · Y ${assignment.offsetY}`
      : 'X 0 · Y 0';
  }

  function updateTransformControls() {
    const assignment = activePartId !== null ? assignments[activePartId] : null;
    const controls = [
      [partScaleInput, partScaleValue, assignment?.scale ?? 1],
      [partStretchXInput, partStretchXValue, assignment?.stretchX ?? 1],
      [partStretchYInput, partStretchYValue, assignment?.stretchY ?? 1],
    ];
    for (const [input, output, value] of controls) {
      input.disabled = !assignment;
      input.value = String(Math.round(value * 100));
      output.value = `${Math.round(value * 100)}%`;
    }
    resetTransformButton.disabled = !assignment;
  }

  function bindTransformInput(input, output, property) {
    input.addEventListener('input', () => {
      const assignment = activePartId !== null ? assignments[activePartId] : null;
      if (!assignment) return;
      assignment[property] = Number(input.value) / 100;
      output.value = `${input.value}%`;
      composeAndPreview();
    });
  }

  bindTransformInput(partScaleInput, partScaleValue, 'scale');
  bindTransformInput(partStretchXInput, partStretchXValue, 'stretchX');
  bindTransformInput(partStretchYInput, partStretchYValue, 'stretchY');

  resetTransformButton.addEventListener('click', () => {
    const assignment = activePartId !== null ? assignments[activePartId] : null;
    if (!assignment) return;
    assignment.scale = 1;
    assignment.stretchX = 1;
    assignment.stretchY = 1;
    updateTransformControls();
    composeAndPreview();
  });

  resetPositionButton.addEventListener('click', () => {
    const assignment = activePartId !== null ? assignments[activePartId] : null;
    if (!assignment) return;
    assignment.offsetX = 0;
    assignment.offsetY = 0;
    updatePositionLabel();
    composeAndPreview();
  });

  for (const button of document.querySelectorAll('[data-editor-pan]')) {
    const [dx, dy] = button.dataset.editorPan.split(',').map(Number);
    button.addEventListener('click', () => panActivePart(dx, dy));
  }

  window.addEventListener('keydown', (event) => {
    if (editor.classList.contains('hidden')) return;
    if (event.target instanceof HTMLInputElement) return;
    const arrows = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    if (!(event.code in arrows)) return;
    event.preventDefault();
    panActivePart(...arrows[event.code]);
  });

  // ---- 合成与导出 ----

  function composeAndPreview() {
    bufferCtx.clearRect(0, 0, atlasBuffer.width, atlasBuffer.height);
    for (const [partId, assignment] of Object.entries(assignments)) {
      const source = sources.find((item) => item.id === assignment.sourceId);
      const destination = window.SkinEditorUtils.assignmentDestination(
        partId, assignment, layout.PARTS
      );
      const [x, y, w, h] = destination.slot;
      bufferCtx.save();
      bufferCtx.beginPath();
      bufferCtx.rect(x, y, w, h);
      bufferCtx.clip();
      bufferCtx.imageSmoothingEnabled = true;
      bufferCtx.drawImage(
        source.image,
        assignment.sx, assignment.sy, assignment.sw, assignment.sh,
        ...destination.draw
      );
      bufferCtx.restore();
    }

    // 可见预览：合成图 + 读取区实线 + 推荐区虚线（参考线不进导出文件）。
    atlasCtx.fillStyle = '#0b1220';
    atlasCtx.fillRect(0, 0, atlasCanvas.width, atlasCanvas.height);
    atlasCtx.drawImage(atlasBuffer, 0, 0);
    atlasCtx.lineWidth = 1;
    atlasCtx.font = '14px sans-serif';
    atlasCtx.fillStyle = 'rgba(255,255,255,0.45)';
    for (const part of Object.values(layout.PARTS)) {
      const [x, y, w, h] = part.rect;
      atlasCtx.strokeStyle = 'rgba(255,255,255,0.35)';
      atlasCtx.setLineDash([]);
      atlasCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      if (part.coreRect) {
        const [cx, cy, cw, ch] = part.coreRect;
        atlasCtx.strokeStyle = 'rgba(148, 163, 184, 0.7)';
        atlasCtx.setLineDash([4, 3]);
        atlasCtx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
        atlasCtx.setLineDash([]);
      }
      atlasCtx.fillText(part.label, x + 5, y + 17);
    }
    drawHeadSafeArea();
    drawActivePartAnchor();

    if (!editor.classList.contains('hidden')) {
      // 空图集会让小人隐形；未分配任何部位时保持当前皮套可见。
      if (Object.keys(assignments).length > 0) {
        window.StageAvatar.previewUvAtlas(atlasBuffer);
      } else {
        window.StageAvatar.endPreview();
      }
      window.StageAvatar.previewHeightScale(currentHeightScale());
    }
  }

  // 整身头部图层中的实线框表示原本的头部轮廓，长发可画到框外。
  function drawHeadSafeArea() {
    const head = layout.PARTS.head;
    if (!head.drawRect || !head.safeRect) return;
    const [slotX, slotY, slotWidth, slotHeight] = head.rect;
    const [drawX, drawY, drawWidth, drawHeight] = head.drawRect;
    const [safeX, safeY, safeWidth, safeHeight] = head.safeRect;
    const scaleX = slotWidth / drawWidth;
    const scaleY = slotHeight / drawHeight;
    atlasCtx.save();
    atlasCtx.strokeStyle = '#fbbf24';
    atlasCtx.lineWidth = 2;
    atlasCtx.strokeRect(
      slotX + (safeX - drawX) * scaleX,
      slotY + (safeY - drawY) * scaleY,
      safeWidth * scaleX,
      safeHeight * scaleY
    );
    atlasCtx.restore();
  }

  // 黄色十字只画在编辑器预览中，用来对齐各肢体靠近躯干的关节端。
  function drawActivePartAnchor() {
    if (activePartId === null) return;
    const part = layout.PARTS[activePartId];
    const [x, y, w, h] = part.rect;
    let anchorX = x + w / 2;
    let anchorY = y + 4;
    if (activePartId === 'head' && part.drawRect && part.safeRect) {
      const [drawX, drawY, drawWidth, drawHeight] = part.drawRect;
      const [safeX, safeY, safeWidth, safeHeight] = part.safeRect;
      anchorX = x + ((safeX + safeWidth / 2 - drawX) / drawWidth) * w;
      anchorY = y + ((safeY + safeHeight - drawY) / drawHeight) * h;
    }
    atlasCtx.save();
    atlasCtx.strokeStyle = '#fbbf24';
    atlasCtx.lineWidth = 2;
    atlasCtx.beginPath();
    atlasCtx.moveTo(anchorX - 6, anchorY);
    atlasCtx.lineTo(anchorX + 6, anchorY);
    atlasCtx.moveTo(anchorX, Math.max(y, anchorY - 6));
    atlasCtx.lineTo(anchorX, Math.min(y + h, anchorY + 6));
    atlasCtx.stroke();
    atlasCtx.restore();
  }

  async function exportSkin({ saveAsNew = false } = {}) {
    if (Object.keys(assignments).length === 0) {
      setStatus('还没有分配任何部位贴图', true);
      return;
    }
    setStatus('生成中…');
    const blob = await new Promise((resolve) => atlasBuffer.toBlob(resolve, 'image/png'));
    const params = new URLSearchParams({
      name: skinNameInput.value || '自制 UV 皮套',
      kind: 'uv',
      height_scale: String(currentHeightScale()),
    });
    // 「另存为新」清空会话 id；「更新当前」在已有 id 时覆盖。
    if (saveAsNew) editorSkinId = null;
    if (editorSkinId) params.set('skin_id', editorSkinId);
    const response = await fetch(`/avatar-lobby/skins?${params.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
      body: blob,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      setStatus(payload.detail || `上传失败（${response.status}）`, true);
      return;
    }
    const payload = await response.json();
    const isUpdate = !saveAsNew && editorSkinId === payload.skin.id;
    editorSkinId = payload.skin.id;
    await window.SkinLibrary.refresh();
    window.SkinLibrary.apply(payload.skin.id);
    setStatus(`${isUpdate ? '已更新' : '已生成并应用'}：${payload.skin.name}`);
  }

  exportForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitter = event.submitter;
    const saveAsNew = submitter?.dataset?.saveMode === 'new';
    await exportSkin({ saveAsNew });
  });

  renderParts();
  updateHeightPreview();
  composeAndPreview();
  drawCropCanvas();
})();
