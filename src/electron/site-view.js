// SPDX-License-Identifier: GPL-3.0-only
const WORLD_ID = 1001;
const VIDEO_CLASS = 'shortdrama-dock-video';
const PREVIEW_CLASS = 'shortdrama-dock-preview';
const PREVIEW_STYLE = `
  html.${PREVIEW_CLASS}, html.${PREVIEW_CLASS} body {
    margin: 0 !important; overflow: hidden !important; background: #000 !important;
  }
  html.${PREVIEW_CLASS} body * { visibility: hidden !important; }
  html.${PREVIEW_CLASS} body :has(.${VIDEO_CLASS}) { overflow: visible !important; transform: none !important; }
  html.${PREVIEW_CLASS} body .${VIDEO_CLASS} {
    visibility: visible !important; position: fixed !important; inset: 0 !important;
    width: 100vw !important; height: 100vh !important; max-width: none !important;
    max-height: none !important; margin: 0 !important; transform: none !important;
    object-fit: contain !important; object-position: center !important;
  }
`;

const DOUYIN_VIDEO = `(() => {
  if (document.documentElement.classList.contains('${PREVIEW_CLASS}')) {
    const selected = document.querySelector('video.${VIDEO_CLASS}');
    return selected?.videoHeight ? selected : null;
  }
  let active = null;
  let largestArea = 0;
  for (const video of document.querySelectorAll('video')) {
    if (!video.videoHeight || video.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) === false) continue;
    const rect = video.getBoundingClientRect();
    const width = Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
    const height = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top));
    const area = width * height;
    if (!area) continue;
    if (!active || (active.paused && !video.paused) || (active.paused === video.paused && area > largestArea)) {
      active = video;
      largestArea = area;
    }
  }
  return active;
})()`;

const sites = {
  bilibili: {
    title: 'B 站',
    home: 'https://www.bilibili.com/',
    partition: 'persist:shortdrama-bilibili',
    allowsHost: host => host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com'),
    canPreview({ hostname, pathname }) {
      if (hostname === 'live.bilibili.com') return /^\/[1-9]\d{0,17}\/?$/.test(pathname);
      return ['www.bilibili.com', 'm.bilibili.com', 'bilibili.com'].includes(hostname) &&
        /^\/video\/(?:BV[A-Za-z0-9]{10}|av[1-9]\d{0,17})\/?$/i.test(pathname);
    },
    video: "document.querySelector('#live-player video, #bilibili-player video, .bpx-player-container video') || document.querySelector('video')",
    keepPreviewWhenVideoMissing: true
  },
  douyin: {
    title: '抖音',
    home: 'https://www.douyin.com/series',
    partition: 'persist:shortdrama-douyin',
    allowsHost: host => host === 'douyin.com' || host.endsWith('.douyin.com'),
    canPreview: ({ hostname }) => hostname === 'www.douyin.com' || hostname === 'douyin.com',
    video: DOUYIN_VIDEO
  }
};

function siteURL(site, input) {
  try {
    const url = new URL(input);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && site.allowsHost(url.hostname)) return url;
  } catch (_) {}
  return null;
}

function createSiteView(site, isActive, isPreview) {
  const { WebContentsView, session } = require('electron');
  const profile = session.fromPartition(site.partition);
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
    if (!siteURL(site, event.url ?? target) || isPreview()) event.preventDefault();
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.setWindowOpenHandler(({ url }) => {
    if (isActive() && !isPreview() && siteURL(site, url)) navigate(url).catch(console.error);
    return { action: 'deny' };
  });

  const canPreview = input => {
    const url = siteURL(site, input);
    return Boolean(url && site.canPreview(url));
  };
  const run = code => siteURL(site, contents.getURL()) ?
    contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }]) : Promise.resolve(null);
  let cssKey;
  async function aspect(markVideo = false) {
    if (!canPreview(contents.getURL())) return null;
    return run(`(() => {
      const video = ${site.video};
      if (${markVideo}) {
        document.querySelectorAll('.${VIDEO_CLASS}').forEach(previous => {
          if (previous !== video) previous.classList.remove('${VIDEO_CLASS}');
        });
        if (video?.videoHeight) {
          video.classList.add('${VIDEO_CLASS}');
          document.documentElement.classList.add('${PREVIEW_CLASS}');
        }
      }
      return video?.videoHeight ? video.videoWidth / video.videoHeight : null;
    })()`);
  }

  return {
    title: site.title,
    keepPreviewWhenVideoMissing: site.keepPreviewWhenVideoMissing,
    view,
    contents,
    canPreview,
    aspect,
    async open(input) {
      const target = siteURL(site, input || site.home);
      if (target && (input || !siteURL(site, contents.getURL()))) await navigate(target.href);
    },
    async enablePreview() {
      const videoAspect = await aspect(true);
      if (videoAspect) cssKey = await contents.insertCSS(PREVIEW_STYLE, { cssOrigin: 'user' });
      return videoAspect;
    },
    async disablePreview() {
      const key = cssKey;
      cssKey = null;
      if (key) await contents.removeInsertedCSS(key).catch(() => {});
      await run(`
        document.documentElement.classList.remove('${PREVIEW_CLASS}');
        document.querySelectorAll('.${VIDEO_CLASS}').forEach(video => video.classList.remove('${VIDEO_CLASS}'));
      `);
    },
    toggle: () => run(`(() => {
      const video = ${site.video};
      if (video?.paused) video.play().catch(() => {});
      else video?.pause();
    })()`),
    pause: () => run("document.querySelectorAll('video, audio').forEach(media => media.pause())")
  };
}

module.exports = { sites, siteURL, createSiteView };
