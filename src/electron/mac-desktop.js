// SPDX-License-Identifier: GPL-3.0-only
const { app, BaseWindow, WebContentsView, globalShortcut, screen, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createBilibiliView, bilibiliURL, isVideoPage } = require('./bilibili-view');
const { findDock, dockPreviewBounds, expandedPreviewBounds, clamp, MIN_ZOOM, MAX_ZOOM, DEFAULT_ZOOM } = require('./dock-placement');

const runFile = promisify(execFile);
const HEADER_HEIGHT = 60;
const SHORTCUT = 'Control+Alt+F9';
const COMMAND = 'shortdrama:command';
const STATE = 'shortdrama:state';
const PAUSE = "document.querySelectorAll('video, audio').forEach(media => media.pause())";
const ASPECT = "(() => { const video = document.querySelector('.theater-view video.video-element'); return video?.videoHeight ? video.videoWidth / video.videoHeight : null; })()";
const LOCAL_VIEW = { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'mac-preload.js') };

function createMacDesktop(windowOptions, appUrl) {
  const { webPreferences, ...options } = windowOptions;
  const window = new BaseWindow(options);
  const player = new WebContentsView({ webPreferences: { ...webPreferences, ...LOCAL_VIEW } });
  const contents = player.webContents;
  window.contentView.addChildView(player);

  const helper = app.isPackaged ? path.join(process.resourcesPath, 'dock-helper/dock-geometry') :
    path.join(__dirname, '../../build/dock-helper', process.arch, 'dock-geometry');
  const zoomFile = path.join(app.getPath('userData'), 'dock-expanded-zoom.json');
  let zoom = DEFAULT_ZOOM;
  try {
    const value = JSON.parse(fs.readFileSync(zoomFile, 'utf8'));
    if (Number.isFinite(value)) zoom = clamp(value, MIN_ZOOM, MAX_ZOOM);
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Unable to load Dock preview size:', error.message);
  }

  let bilibili;
  let browsing = false;
  let navigationRevision = 0;
  let compact = false;
  let regularBounds;
  let wasMaximized = false;
  let preview;
  let hidden = false;
  let dock = { windows: [], doubleClickMs: 500 };
  let dockProbe;
  let pendingClick;
  let queue = Promise.resolve();
  const shortcutRegistered = globalShortcut.register(SHORTCUT, () => enqueue(toggleHidden));
  const enqueue = action => {
    queue = queue.then(() => !window.isDestroyed() && action()).catch(error => console.error('Mac player:', error));
    return queue;
  };

  const state = () => {
    if (!contents.isDestroyed()) contents.send(STATE, { compact, browsing, shortcut: shortcutRegistered });
  };
  contents.on('did-finish-load', state);

  function layoutMain() {
    if (window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    if (preview?.source !== player) player.setBounds({ x: 0, y: 0, width, height });
    if (bilibili && preview?.source !== bilibili.view) {
      bilibili.view.setBounds({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT) });
    }
  }
  window.on('resize', layoutMain);
  layoutMain();

  function setCompact(value) {
    if (compact === value || window.isDestroyed()) return;
    if (value) {
      wasMaximized = window.isMaximized();
      if (wasMaximized) window.unmaximize();
      regularBounds = window.getNormalBounds();
      const { workArea } = screen.getDisplayMatching(window.getBounds());
      const width = Math.min(workArea.width, 420);
      const height = Math.min(workArea.height, 710);
      window.setMinimumSize(Math.min(360, width), Math.min(400, height));
      window.setBounds({ x: workArea.x + workArea.width - width, y: workArea.y + workArea.height - height, width, height });
    } else {
      window.setMinimumSize(options.minWidth, options.minHeight);
      window.setBounds(regularBounds);
      if (wasMaximized) window.maximize();
    }
    compact = value;
    window.setAlwaysOnTop(value);
    state();
  }

  function updateMute() {
    contents.setAudioMuted(hidden || browsing);
    bilibili?.contents.setAudioMuted(hidden || !browsing);
  }

  function pause() {
    return browsing ? bilibili.pause() : contents.executeJavaScript(PAUSE);
  }

  function browseBilibili(input) {
    if (preview || (input && !bilibiliURL(input))) return;
    if (!bilibili) {
      bilibili = createBilibiliView(() => browsing, () => Boolean(preview));
      bilibili.contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
        if (!mainFrame || !preview) return;
        if (isVideoPage(url)) refreshPreview(preview);
        else enqueue(leavePreview);
      });
    }
    if (!browsing) {
      browsing = true;
      state();
      updateMute();
      window.contentView.addChildView(bilibili.view);
      layoutMain();
      contents.executeJavaScript(PAUSE).catch(console.error);
    }
    const revision = ++navigationRevision;
    bilibili.open(input).catch(error => {
      enqueue(async () => {
        if (!browsing || preview || revision !== navigationRevision) return;
        console.error('Bilibili navigation:', error);
        await returnToPlayer();
        showMessage('无法打开 B 站页面，请重试。');
      });
    });
  }

  async function returnToPlayer() {
    if (!browsing || preview) return;
    navigationRevision++;
    browsing = false;
    window.contentView.removeChildView(bilibili.view);
    state();
    updateMute();
    await bilibili.pause();
    if (!window.isDestroyed()) contents.focus();
  }

  function showMessage(message) {
    dialog.showMessageBox(window, { type: 'info', message, buttons: ['确定'] }).catch(console.error);
  }

  function readDock() {
    if (!dockProbe) {
      dockProbe = runFile(helper, [], { timeout: 1200 }).then(({ stdout }) => {
        const result = JSON.parse(stdout);
        if (Array.isArray(result.windows) && Number.isFinite(result.doubleClickMs)) dock = result;
      }).catch(() => { dock.windows = []; }).finally(() => { dockProbe = null; });
    }
    return dockProbe;
  }

  function updatePreviewBounds(current) {
    if (current !== preview || current.window.isDestroyed()) return;
    const display = screen.getAllDisplays().find(display => display.id === current.dockDisplay) ??
      screen.getDisplayMatching(current.window.getBounds());
    current.anchor = dockPreviewBounds(display, findDock(display.bounds, dock.windows), current.aspect);
    const targetDisplay = current.location ? screen.getDisplayNearestPoint(current.location) : display;
    const bounds = current.expanded ?
      expandedPreviewBounds(targetDisplay.workArea, current.anchor, current.aspect, zoom, current.location) : current.anchor;
    const existing = current.window.getBounds();
    if (Object.keys(bounds).some(key => existing[key] !== bounds[key])) current.window.setBounds(bounds);
    const contentBounds = { x: 0, y: 0, width: bounds.width, height: bounds.height };
    current.source.setBounds(contentBounds);
    current.input.setBounds(contentBounds);
  }

  function setPreviewLayout(current) {
    updatePreviewBounds(current);
    current.input.webContents.send(STATE, { expanded: current.expanded });
  }

  async function refreshPreview(current) {
    if (current !== preview || hidden || current.refreshing) return;
    current.refreshing = true;
    try {
      if (!current.expanded) await readDock();
      const aspect = browsing ? await bilibili.aspect(true) : await contents.executeJavaScript(ASPECT);
      if (current !== preview) return;
      if (Number.isFinite(aspect) && aspect > 0) current.aspect = aspect;
      else if (!browsing) return enqueue(leavePreview);
      if (!current.drag) updatePreviewBounds(current);
    } catch (error) {
      if (current === preview) console.warn('Dock preview refresh:', error.message);
    } finally {
      current.refreshing = false;
    }
  }

  async function enterPreview() {
    if (preview) return;
    const aspect = browsing ? await bilibili.aspect() : await contents.executeJavaScript(ASPECT);
    if (!Number.isFinite(aspect) || aspect <= 0) {
      showMessage('请先播放红果短剧、B 站视频或直播，再点「贴 Dock」。');
      return;
    }
    if (window.isDestroyed()) return;
    if (window.isFullScreen()) {
      await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          window.removeListener('leave-full-screen', done);
          resolve();
        };
        const timer = setTimeout(done, 2000);
        window.once('leave-full-screen', done);
        window.setFullScreen(false);
      });
    }
    await readDock();
    if (window.isDestroyed()) return;
    const dockDisplay = screen.getDisplayMatching(window.getBounds()).id;
    const floating = new BaseWindow({
      frame: false, show: false, width: 150, height: 104, backgroundColor: '#000000',
      acceptFirstMouse: true, alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false
    });
    floating.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    const input = new WebContentsView({ webPreferences: LOCAL_VIEW });
    input.setBackgroundColor('#00000000');
    const source = browsing ? bilibili.view : player;
    const current = { window: floating, input, source, dockDisplay, aspect, expanded: false };
    try {
      await input.webContents.loadURL(appUrl + '/mac-preview.html');
      if (window.isDestroyed()) return;
      if (browsing) await bilibili.enablePreview();
      if (window.isDestroyed()) return;
      if (!browsing) await contents.executeJavaScript("document.documentElement.classList.add('taskbar-preview')");
      if (window.isDestroyed()) return;
      preview = current;
      window.contentView.removeChildView(source);
      floating.contentView.addChildView(source);
      floating.contentView.addChildView(input);
      input.webContents.ipc.on(COMMAND, (event, message) => {
        if (event.senderFrame === input.webContents.mainFrame && event.senderFrame.url === appUrl + '/mac-preview.html' && typeof message === 'string' &&
            message.startsWith('taskbar:') && current === preview && !hidden) handleGesture(current, message.slice(8));
      });
      floating.on('close', event => {
        if (preview !== current) return;
        event.preventDefault();
        enqueue(leavePreview);
      });
      setPreviewLayout(current);
      window.hide();
      floating.show();
      input.webContents.focus();
      current.timer = setInterval(() => refreshPreview(current), 1500);
    } catch (error) {
      if (!window.isDestroyed()) {
        if (preview === current) await leavePreview();
        else if (browsing) await bilibili.disablePreview().catch(console.error);
        showMessage('无法打开贴 Dock 小窗，请重试。');
      }
      throw error;
    } finally {
      if (preview !== current) closePreviewWindow(current);
    }
  }

  function closePreviewWindow(current) {
    clearInterval(current.timer);
    if (!current.input.webContents.isDestroyed()) current.input.webContents.close();
    if (!current.window.isDestroyed()) current.window.destroy();
  }

  async function leavePreview() {
    const current = preview;
    if (!current) return;
    preview = null;
    clearTimeout(pendingClick);
    clearInterval(current.timer);
    try {
      if (browsing) await bilibili.disablePreview();
      else await contents.executeJavaScript("document.documentElement.classList.remove('taskbar-preview')");
    } finally {
      if (!current.window.isDestroyed()) current.window.contentView.removeChildView(current.source);
      if (!window.isDestroyed()) {
        window.contentView.addChildView(current.source);
        setCompact(true);
        layoutMain();
        hidden = false;
        updateMute();
        window.show();
        current.source.webContents.focus();
      }
      closePreviewWindow(current);
    }
  }

  function handleGesture(current, command) {
    switch (command) {
      case 'click':
        clearTimeout(pendingClick);
        pendingClick = setTimeout(() => {
          if (preview === current && !hidden) enqueue(togglePlayback);
        }, Math.max(250, dock.doubleClickMs) + 50);
        break;
      case 'play':
        clearTimeout(pendingClick);
        enqueue(togglePlayback);
        break;
      case 'back':
        if (!current.expanded) { enqueue(leavePreview); break; }
        // An expanded preview returns to the Dock on Escape.
        // falls through
      case 'toggle':
        clearTimeout(pendingClick);
        current.expanded = !current.expanded;
        current.location = null;
        current.drag = null;
        setPreviewLayout(current);
        break;
      case 'exit':
        enqueue(leavePreview);
        break;
      case 'drag-start':
        if (current.expanded) {
          const point = screen.getCursorScreenPoint();
          const bounds = current.window.getBounds();
          current.drag = { x: point.x - bounds.x, y: point.y - bounds.y };
        }
        break;
      case 'drag-move':
        if (current.drag) {
          const point = screen.getCursorScreenPoint();
          current.location = { x: point.x - current.drag.x, y: point.y - current.drag.y };
          updatePreviewBounds(current);
        }
        break;
      case 'drag-end':
        current.drag = null;
        break;
      case 'zoom-in':
      case 'zoom-out':
      case 'fit':
      case 'max': {
        if (!current.expanded) break;
        const next = { 'zoom-in': zoom * 1.08, 'zoom-out': zoom / 1.08, fit: DEFAULT_ZOOM, max: MAX_ZOOM }[command];
        zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
        if (current.location) {
          const { x, y } = current.window.getBounds();
          current.location = { x, y };
        }
        updatePreviewBounds(current);
        try {
          fs.mkdirSync(path.dirname(zoomFile), { recursive: true });
          fs.writeFileSync(zoomFile + '.tmp', JSON.stringify(zoom));
          fs.renameSync(zoomFile + '.tmp', zoomFile);
        } catch (error) {
          console.warn('Unable to save Dock preview size:', error.message);
        }
        break;
      }
    }
  }

  function togglePlayback() {
    if (!preview || hidden) return;
    return browsing ? bilibili.toggle() : contents.send(STATE, 'taskbar:play');
  }

  function activate() {
    const visible = preview?.window ?? window;
    if (visible.isMinimized()) visible.restore();
    hidden = false;
    updateMute();
    visible.show();
    visible.focus();
    if (preview) preview.input.webContents.focus();
  }

  async function toggleHidden() {
    const visible = preview?.window ?? window;
    if (hidden || visible.isMinimized() || !visible.isVisible()) {
      activate();
      return;
    }
    clearTimeout(pendingClick);
    hidden = true;
    updateMute();
    visible.hide();
    await pause();
  }

  const displayChanged = () => { if (preview) refreshPreview(preview); };
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, displayChanged);
  window.on('minimize', () => enqueue(pause));
  window.on('closed', () => {
    if (shortcutRegistered) globalShortcut.unregister(SHORTCUT);
    for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.removeListener(event, displayChanged);
    clearTimeout(pendingClick);
    if (preview) {
      const current = preview;
      preview = null;
      closePreviewWindow(current);
    }
    bilibili?.contents.close();
    if (!contents.isDestroyed()) contents.close();
  });
  // Bind to the local top frame. The remote Bilibili renderer has no desktop bridge.
  contents.ipc.on(COMMAND, (event, message) => {
    if (event.senderFrame !== contents.mainFrame || !['/', '/index.html'].some(route => event.senderFrame.url === appUrl + route) ||
        typeof message !== 'string' || message.length > 2070) return;
    if (message.startsWith('bilibili:browse:')) {
      enqueue(() => browseBilibili(message.slice('bilibili:browse:'.length)));
      return;
    }
    const actions = {
      'bilibili:return': returnToPlayer,
      'window:compact': () => setCompact(!compact),
      'window:dock': enterPreview
    };
    if (!preview && Object.hasOwn(actions, message)) enqueue(actions[message]);
  });

  return { window, contents, activate, toggleHidden: () => enqueue(toggleHidden) };
}

module.exports = { createMacDesktop };
