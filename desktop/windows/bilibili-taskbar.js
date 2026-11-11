// SPDX-License-Identifier: GPL-3.0-only
function mountBilibiliTaskbar(send) {
  const root = document.documentElement;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'shortdrama-taskbar-input';
  button.title = '单击播放或暂停，双击展开或缩回，右键返回 B 站，滚轮缩放';
  button.setAttribute('aria-label', '展开或缩回直播和视频画面');
  button.style.cssText = 'position:fixed!important;inset:0!important;width:100%!important;height:100%!important;'
    + 'padding:0!important;border:0!important;background:transparent!important;visibility:visible!important;'
    + 'z-index:2147483647!important;touch-action:none!important;cursor:pointer!important;';
  const isExpanded = () => root.classList.contains('shortdrama-taskbar-expanded');
  const controls = createTaskbarControls(send, isExpanded);
  const listen = (name, action, prevent = false) => {
    button.addEventListener(name, event => {
      event.stopImmediatePropagation();
      if (prevent) event.preventDefault();
      if (event.isTrusted) action(event);
    });
  };
  listen('click', controls.handleTaskbarClick);
  listen('dblclick', controls.handleTaskbarDoubleClick, true);
  listen('pointerdown', controls.startTaskbarDrag);
  listen('pointermove', controls.moveTaskbarDrag);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(name, controls.finishTaskbarDrag);
  listen('wheel', controls.zoomTaskbarFromWheel, true);
  listen('contextmenu', () => send('exit'), true);
  listen('keydown', event => {
    const action = { Escape: 'back', Home: 'fit', End: 'max', ' ': 'play', k: 'play' }[event.key];
    if (action) {
      event.preventDefault();
      send(action);
    }
  });
  document.body.append(button);
  button.focus();
}
