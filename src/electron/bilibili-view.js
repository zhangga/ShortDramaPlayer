// SPDX-License-Identifier: GPL-3.0-only
const { WebContentsView, session } = require('electron');

const HOME = 'https://www.bilibili.com/';
const PARTITION = 'persist:shortdrama-bilibili';
const WORLD_ID = 1001;
const VIDEO = "document.querySelector('#live-player video, #bilibili-player video, .bpx-player-container video') || document.querySelector('video')";
const VIDEO_CLASS = 'shortdrama-dock-video';
const PREVIEW_STYLE = `
  html, body { margin: 0 !important; overflow: hidden !important; background: #000 !important; }
  body * { visibility: hidden !important; }
  body :has(.${VIDEO_CLASS}) { overflow: visible !important; transform: none !important; }
  body .${VIDEO_CLASS} {
    visibility: visible !important; position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; max-width: none !important;
    max-height: none !important; margin: 0 !important; transform: none !important;
    object-fit: contain !important; object-position: center !important;
  }
`;

function bilibiliURL(input) {
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password &&
        (url.hostname === 'b23.tv' || url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com'))) return url;
  } catch (_) {}
  return null;
}

function isVideoPage(input) {
  const url = bilibiliURL(input);
  if (!url) return false;
  if (url.hostname === 'live.bilibili.com') return /^\/[1-9]\d{0,17}\/?$/.test(url.pathname);
  return ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(url.hostname) &&
    /^\/video\/(?:BV[A-Za-z0-9]{10}|av[1-9]\d{0,17})\/?$/i.test(url.pathname);
}

function createBilibiliView(isActive, isPreview) {
  const profile = session.fromPartition(PARTITION);
  profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  profile.setPermissionCheckHandler(() => false);

  const view = new WebContentsView({ webPreferences: {
    session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false
  } });
  const contents = view.webContents;
  const navigate = url => contents.loadURL(url).catch(error => {
    if (error.code !== 'ERR_ABORTED') throw error;
  });
  const guard = (event, target) => {
    if (event.isMainFrame === false) return;
    if (!bilibiliURL(event.url ?? target) || isPreview()) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (isActive() && !isPreview() && bilibiliURL(url)) navigate(url).catch(console.error);
    return { action: 'deny' };
  });

  const run = code => bilibiliURL(contents.getURL()) ?
    contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]) : Promise.resolve(null);
  let cssKey;
  return {
    view,
    contents,
    async open(input) {
      const target = bilibiliURL(input || HOME);
      if (target && (input || !bilibiliURL(contents.getURL()))) await navigate(target.href);
    },
    async aspect(markVideo = false) {
      if (!isVideoPage(contents.getURL())) return null;
      return run(`(() => {
        const video = ${VIDEO};
        if (${markVideo}) {
          document.querySelectorAll('.${VIDEO_CLASS}').forEach(previous => {
            if (previous !== video) previous.classList.remove('${VIDEO_CLASS}');
          });
          video?.classList.add('${VIDEO_CLASS}');
        }
        return video?.videoHeight ? video.videoWidth / video.videoHeight : null;
      })()`);
    },
    async enablePreview() {
      cssKey = await contents.insertCSS(PREVIEW_STYLE, { cssOrigin: 'user' });
      return this.aspect(true);
    },
    async disablePreview() {
      const key = cssKey;
      cssKey = null;
      if (key) await contents.removeInsertedCSS(key).catch(() => {});
      await run(`document.querySelectorAll('.${VIDEO_CLASS}').forEach(video => video.classList.remove('${VIDEO_CLASS}'))`);
    },
    toggle: () => run(`(() => {
      const video = ${VIDEO};
      if (video?.paused) video.play().catch(() => {});
      else video?.pause();
    })()`),
    pause: () => run("document.querySelectorAll('video, audio').forEach(media => media.pause())")
  };
}

module.exports = { createBilibiliView, bilibiliURL, isVideoPage };
