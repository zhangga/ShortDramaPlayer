// SPDX-License-Identifier: GPL-3.0-only
const GAP = 6;
const MIN_DOCK_SCALE = 0.5;
const MAX_DOCK_SCALE = 2.5;
const DEFAULT_DOCK_SCALE = 1;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 0.8;
const DEFAULT_ZOOM = 0.4;
const right = rect => rect.x + rect.width;
const bottom = rect => rect.y + rect.height;
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));

function fitSize(width, height, aspect) {
  const fittedHeight = Math.min(height, width / aspect);
  return { width: Math.max(1, Math.round(fittedHeight * aspect)), height: Math.max(1, Math.round(fittedHeight)) };
}

function keepInArea(rect, area) {
  return {
    ...rect,
    x: Math.round(clamp(rect.x, area.x, right(area) - rect.width)),
    y: Math.round(clamp(rect.y, area.y, bottom(area) - rect.height))
  };
}

function findDock(bounds, windows) {
  return windows.find(dock => {
    if (dock.width < 24 || dock.height < 24 ||
        dock.x < bounds.x - 4 || right(dock) > right(bounds) + 4 ||
        dock.y < bounds.y - 4 || bottom(dock) > bottom(bounds) + 4) return false;
    return (bottom(dock) >= bottom(bounds) - 24 && dock.height <= bounds.height * 0.25) ||
      ((dock.x <= bounds.x + 24 || right(dock) >= right(bounds) - 24) && dock.width <= bounds.width * 0.25);
  });
}

function dockPreviewBounds(display, dock, aspect, scale = DEFAULT_DOCK_SCALE, location) {
  const { bounds, workArea } = display;
  const size = fitSize(Math.min(150 * scale, workArea.width), Math.min(104 * scale, workArea.height), aspect);
  const y = bottom(workArea) - size.height - GAP;
  if (!dock) {
    return keepInArea({ ...size, x: location?.x ?? right(workArea) - size.width - GAP, y }, workArea);
  }
  if (bottom(dock) >= bottom(bounds) - 24 && dock.height <= bounds.height * 0.25) {
    const preferredX = location?.x ?? right(dock) + GAP;
    const ranges = [
      [right(dock) + GAP, right(bounds) - GAP - size.width],
      [bounds.x + GAP, dock.x - GAP - size.width]
    ];
    let x;
    for (const [min, max] of ranges) {
      if (min > max) continue;
      const candidate = clamp(preferredX, min, max);
      if (x === undefined || Math.abs(candidate - preferredX) < Math.abs(x - preferredX)) x = candidate;
    }
    if (x !== undefined) return { ...size, x: Math.round(x), y: Math.round(bottom(dock) - size.height) };
    return keepInArea({ ...size, x: location?.x ?? right(dock) - size.width, y: dock.y - size.height - GAP }, workArea);
  }
  const x = dock.x <= bounds.x + 24 ? right(dock) + GAP : dock.x - size.width - GAP;
  return keepInArea({ ...size, x, y: location?.y ?? y }, workArea);
}

function expandedPreviewBounds(area, anchor, aspect, zoom, location) {
  const size = fitSize(Math.max(1, area.width - GAP * 2),
    Math.min(area.height * MAX_ZOOM, Math.max(1, area.height * zoom)), aspect);
  return keepInArea({
    ...size,
    x: location?.x ?? right(anchor) - size.width,
    y: location?.y ?? bottom(anchor) - size.height
  }, area);
}

function dockGuideBounds(area, preview) {
  const width = Math.min(240, area.width);
  const height = Math.min(76, area.height);
  const alignedX = right(preview) - width;
  const positions = [
    { x: alignedX, y: preview.y - height - GAP },
    { x: alignedX, y: bottom(preview) + GAP },
    { x: right(preview) + GAP, y: preview.y },
    { x: preview.x - width - GAP, y: preview.y }
  ].map(position => keepInArea({ ...position, width, height }, area));
  return positions.find(guide => bottom(guide) <= preview.y || guide.y >= bottom(preview) ||
    right(guide) <= preview.x || guide.x >= right(preview)) ?? positions[0];
}

module.exports = {
  findDock, dockPreviewBounds, expandedPreviewBounds, dockGuideBounds, keepInArea, clamp,
  MIN_DOCK_SCALE, MAX_DOCK_SCALE, DEFAULT_DOCK_SCALE, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM
};
