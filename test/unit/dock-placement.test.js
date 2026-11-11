// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findDock, dockPreviewBounds, expandedPreviewBounds } = require('../../src/electron/dock-placement');

const display = {
  bounds: { x: 0, y: 0, width: 1440, height: 900 },
  workArea: { x: 0, y: 24, width: 1440, height: 810 }
};
const portrait = 9 / 16;

test('Dock preview aligns with the Dock bottom when either side fits', () => {
  const centered = { x: 420, y: 834, width: 600, height: 60 };
  assert.deepEqual(dockPreviewBounds(display, centered, portrait), { x: 1026, y: 790, width: 59, height: 104 });
  const toTheRight = { ...centered, x: 120, width: 1310 };
  assert.deepEqual(dockPreviewBounds(display, toTheRight, portrait), { x: 55, y: 790, width: 59, height: 104 });
});

test('Dock preview moves above a wide Dock and clears a Dock on either side', () => {
  const wideDock = { x: 24, y: 834, width: 1392, height: 60 };
  assert.deepEqual(dockPreviewBounds(display, wideDock, 16 / 9), { x: 1266, y: 744, width: 150, height: 84 });
  const left = { x: 4, y: 300, width: 50, height: 400 };
  const right = { ...left, x: 1386 };
  const leftDisplay = { ...display, workArea: { x: 58, y: 24, width: 1382, height: 876 } };
  const rightDisplay = { ...display, workArea: { x: 0, y: 24, width: 1382, height: 876 } };
  assert.equal(dockPreviewBounds(leftDisplay, left, portrait).x, 60);
  assert.equal(dockPreviewBounds(rightDisplay, right, portrait).x, 1321);
});

test('Dock preview scales proportionally with its bottom still aligned', () => {
  const dock = { x: 420, y: 834, width: 600, height: 60 };
  assert.deepEqual(dockPreviewBounds(display, dock, portrait, 0.5), { x: 1026, y: 842, width: 29, height: 52 });
  assert.deepEqual(dockPreviewBounds(display, dock, portrait, 2), { x: 1026, y: 686, width: 117, height: 208 });
});

test('dragging along a bottom Dock avoids its icons and the edge of the screen', () => {
  const dock = { x: 420, y: 834, width: 600, height: 60 };
  assert.deepEqual(dockPreviewBounds(display, dock, portrait, 1, { x: 550, y: 100 }),
    { x: 355, y: 790, width: 59, height: 104 });
  assert.deepEqual(dockPreviewBounds(display, dock, portrait, 1, { x: 1500, y: 100 }),
    { x: 1375, y: 790, width: 59, height: 104 });
  const wideDock = { ...dock, x: 24, width: 1392 };
  assert.deepEqual(dockPreviewBounds(display, wideDock, 16 / 9, 1, { x: 200, y: 100 }),
    { x: 200, y: 744, width: 150, height: 84 });
  assert.deepEqual(dockPreviewBounds(display, undefined, portrait, 1, { x: 200, y: 100 }),
    { x: 200, y: 724, width: 59, height: 104 });
});

test('dragging along a side Dock changes only the vertical position', () => {
  const left = { x: 4, y: 300, width: 50, height: 400 };
  const right = { ...left, x: 1386 };
  const leftDisplay = { ...display, workArea: { x: 58, y: 24, width: 1382, height: 876 } };
  const rightDisplay = { ...display, workArea: { x: 0, y: 24, width: 1382, height: 876 } };
  assert.deepEqual(dockPreviewBounds(leftDisplay, left, portrait, 1, { x: 400, y: 150 }),
    { x: 60, y: 150, width: 59, height: 104 });
  assert.deepEqual(dockPreviewBounds(rightDisplay, right, portrait, 1, { x: 400, y: -10 }),
    { x: 1321, y: 24, width: 59, height: 104 });
});

test('Dock detection ignores windows for other displays and hidden edge strips', () => {
  const hidden = { x: 0, y: 898, width: 1440, height: 2 };
  const otherDisplay = { x: -1200, y: 850, width: 600, height: 50 };
  const dock = { x: 420, y: 840, width: 600, height: 56 };
  assert.equal(findDock(display.bounds, [hidden, otherDisplay, dock]), dock);
  assert.equal(findDock(display.bounds, [hidden, otherDisplay]), undefined);
});

test('expanded playback fits the full image, clamps to the work area, and restores the zoom', () => {
  const anchor = { x: 1390, y: 796, width: 50, height: 104 };
  const bounds = expandedPreviewBounds(display.workArea, anchor, portrait, 0.35);
  assert.deepEqual(bounds, { x: 1281, y: 550, width: 159, height: 284 });
  const moved = expandedPreviewBounds(display.workArea, anchor, portrait, 0.35, { x: -20, y: 120 });
  assert.deepEqual(moved, { ...bounds, x: 0, y: 120 });
  assert.deepEqual(expandedPreviewBounds(display.workArea, anchor, portrait, 0.35), bounds);
});
