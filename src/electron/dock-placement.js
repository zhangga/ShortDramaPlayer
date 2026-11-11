// SPDX-License-Identifier: GPL-3.0-only
const GAP = 6;
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

function dockPreviewBounds(display, dock, aspect) {
  const { bounds, workArea } = display;
  const size = fitSize(Math.min(150, workArea.width), Math.min(104, workArea.height), aspect);
  if (dock && bottom(dock) >= bottom(bounds) - 24 && dock.height <= bounds.height * 0.25) {
    for (const x of [right(dock) + GAP, dock.x - GAP - size.width]) {
      if (x >= bounds.x + GAP && x + size.width <= right(bounds) - GAP) {
        return { ...size, x: Math.round(x), y: Math.round(bottom(dock) - size.height) };
      }
    }
    return keepInArea({ ...size, x: right(dock) - size.width, y: dock.y - size.height - GAP }, workArea);
  }
  if (dock && dock.x <= bounds.x + 24) {
    return keepInArea({ ...size, x: right(dock) + GAP, y: bottom(workArea) - size.height - GAP }, workArea);
  }
  const edge = dock ? dock.x : right(workArea);
  return keepInArea({ ...size, x: edge - size.width - GAP, y: bottom(workArea) - size.height - GAP }, workArea);
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

module.exports = { findDock, dockPreviewBounds, expandedPreviewBounds, keepInArea, clamp, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM };
