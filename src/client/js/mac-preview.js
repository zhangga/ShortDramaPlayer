// SPDX-License-Identifier: GPL-3.0-only
const desktop = window.shortDramaDesktop;
const root = document.documentElement;
const video = document.querySelector('.preview-video');
const returnButton = document.querySelector('.preview-return');
const send = (command, point) => desktop.send('taskbar:' + command, point);
const controls = createTaskbarControls(send);

video.addEventListener('click', controls.handleTaskbarClick);
video.addEventListener('dblclick', controls.handleTaskbarDoubleClick);
video.addEventListener('pointerdown', controls.startTaskbarDrag);
video.addEventListener('pointermove', controls.moveTaskbarDrag);
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  video.addEventListener(type, controls.finishTaskbarDrag);
}
returnButton.addEventListener('click', () => send('exit'));
window.addEventListener('wheel', event => {
  event.preventDefault();
  controls.zoomTaskbarFromWheel(event);
}, { passive: false });
window.addEventListener('contextmenu', event => {
  event.preventDefault();
  send('exit');
});
window.addEventListener('keydown', event => {
  if (event.metaKey || event.altKey || event.ctrlKey || event.repeat) return;
  if (event.key === ' ' && event.target === returnButton) return;
  const action = { Escape: 'back', Home: 'fit', End: 'max', ' ': 'play', k: 'play' }[event.key];
  if (action) {
    event.preventDefault();
    send(action);
  }
});
desktop.onMessage(({ expanded }) => root.classList.toggle('taskbar-expanded', expanded));
