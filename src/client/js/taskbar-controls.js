// SPDX-License-Identifier: GPL-3.0-only
function createTaskbarControls(send, canDrag = () => true) {
  let drag = null;
  let wasDragged = false;

  function handleTaskbarClick(event) {
    if (event.detail === 0) send('toggle');
    else if (event.detail === 1 && !wasDragged) send('click');
  }

  function handleTaskbarDoubleClick() {
    if (!wasDragged) send('toggle');
  }

  function startTaskbarDrag(event) {
    if (event.button !== 0) return;
    drag = null;
    wasDragged = false;
    if (event.pointerType !== 'mouse' || !canDrag()) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, x: event.screenX, y: event.screenY };
    send('drag-start', { x: event.screenX, y: event.screenY });
  }

  function moveTaskbarDrag(event) {
    if (drag?.pointerId !== event.pointerId || !(event.buttons & 1)) return;
    if (!wasDragged && Math.hypot(event.screenX - drag.x, event.screenY - drag.y) < 4) return;
    wasDragged = true;
    send('drag-move', { x: event.screenX, y: event.screenY });
  }

  function finishTaskbarDrag(event) {
    if (drag?.pointerId !== event.pointerId) return;
    drag = null;
    send('drag-end');
  }

  function zoomTaskbarFromWheel(event) {
    if (event.deltaY) send(event.deltaY < 0 ? 'zoom-in' : 'zoom-out');
  }

  return { handleTaskbarClick, handleTaskbarDoubleClick, startTaskbarDrag, moveTaskbarDrag, finishTaskbarDrag, zoomTaskbarFromWheel };
}
