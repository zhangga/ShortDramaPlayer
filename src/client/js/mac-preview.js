// SPDX-License-Identifier: GPL-3.0-only
const desktop = window.shortDramaDesktop;
const root = document.documentElement;
const button = document.querySelector('button');
const send = (command, point) => desktop.send('taskbar:' + command, point);
const controls = createTaskbarControls(send);

button.addEventListener('click', controls.handleTaskbarClick);
button.addEventListener('dblclick', controls.handleTaskbarDoubleClick);
button.addEventListener('pointerdown', controls.startTaskbarDrag);
button.addEventListener('pointermove', controls.moveTaskbarDrag);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  button.addEventListener(type, controls.finishTaskbarDrag);
}
button.addEventListener('wheel', event => {
  event.preventDefault();
  controls.zoomTaskbarFromWheel(event);
}, { passive: false });
button.addEventListener('contextmenu', event => {
  event.preventDefault();
  send('exit');
});
window.addEventListener('keydown', event => {
  if (event.metaKey || event.altKey || event.ctrlKey || event.repeat) return;
  const action = { Escape: 'back', Home: 'fit', End: 'max', ' ': 'play', k: 'play' }[event.key];
  if (action) {
    event.preventDefault();
    send(action);
  }
});
desktop.onMessage(({ expanded }) => root.classList.toggle('taskbar-expanded', expanded));
