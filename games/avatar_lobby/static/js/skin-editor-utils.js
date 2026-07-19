/**
 * 皮套编辑器纯函数：吸附、槽位几何。
 * 由 skin-editor.js 持有 DOM 与交互状态，这里只做无副作用计算。
 */
(() => {
  // 吸附目标：源图四边 + 当前素材所有已应用裁剪框的边。
  function snapCandidates(source, assignments) {
    const xs = [0, source.image.width];
    const ys = [0, source.image.height];
    for (const assignment of Object.values(assignments)) {
      if (assignment.sourceId !== source.id) continue;
      xs.push(assignment.sx, assignment.sx + assignment.sw);
      ys.push(assignment.sy, assignment.sy + assignment.sh);
    }
    return { xs, ys };
  }

  function snapAxis(value, candidates, threshold) {
    let best = null;
    let bestDistance = threshold;
    for (const candidate of candidates) {
      const distance = Math.abs(value - candidate);
      if (distance <= bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best;
  }

  // 把指针坐标吸附到最近的候选边；disabled 为 true 时关闭（如按住 Alt）。
  function snapPoint(point, source, view, disabled, assignments) {
    if (disabled) return { point, guideX: null, guideY: null };
    const threshold = 8 / view.scale;
    const candidates = snapCandidates(source, assignments);
    const snappedX = snapAxis(point.x, candidates.xs, threshold);
    const snappedY = snapAxis(point.y, candidates.ys, threshold);
    return {
      point: { x: snappedX ?? point.x, y: snappedY ?? point.y },
      guideX: snappedX,
      guideY: snappedY,
    };
  }

  // 手动素材按比例完整放入槽位；完整 UV 保持槽位原尺寸，避免二次缩放。
  function assignmentDestination(partId, assignment, parts) {
    const [x, y, w, h] = parts[partId].rect;
    let baseWidth = w;
    let baseHeight = h;
    if (assignment.fitMode !== 'exact') {
      const fitScale = Math.min(w / assignment.sw, h / assignment.sh);
      baseWidth = assignment.sw * fitScale;
      baseHeight = assignment.sh * fitScale;
    }
    const drawWidth = baseWidth * (assignment.scale ?? 1) * (assignment.stretchX ?? 1);
    const drawHeight = baseHeight * (assignment.scale ?? 1) * (assignment.stretchY ?? 1);
    return {
      slot: [x, y, w, h],
      draw: [
        x + (w - drawWidth) / 2 + assignment.offsetX,
        y + (h - drawHeight) / 2 + assignment.offsetY,
        drawWidth,
        drawHeight,
      ],
    };
  }

  window.SkinEditorUtils = {
    snapPoint,
    assignmentDestination,
  };
})();
