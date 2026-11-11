// SPDX-License-Identifier: GPL-3.0-only
const { powerMonitor } = require('electron');
const { getFishing } = require('../server/services/fishingService');

const PLAYER_VIDEO = "document.querySelector('.theater-view video.video-element')";
const BILIBILI_VIDEO = "document.querySelector('#live-player video, #bilibili-player video, .bpx-player-container video') || document.querySelector('video')";

function isVideoPlaying(source, selector) {
  return source.executeJavaScript(`(() => {
    const video = (${selector});
    return !!(video && !video.paused && !video.ended && !video.error && (video.currentSrc || video.srcObject));
  })()`);
}

function isPlayerVideoPlaying(contents) {
  const frame = contents.mainFrame.frames.find(child => child.url.startsWith('https://player.bilibili.com/player.html?'));
  return frame ? isVideoPlaying(frame, BILIBILI_VIDEO) : isVideoPlaying(contents, PLAYER_VIDEO);
}

function trackFishing(window, readMode) {
  const fishing = getFishing();
  fishing.start();
  let locked = false;
  let suspended = false;
  let sampling = false;
  let revision = 0;
  const stopPlayback = () => {
    revision++;
    fishing.updatePlayback();
  };
  const onLock = () => { locked = true; stopPlayback(); };
  const onUnlock = () => { locked = false; stopPlayback(); };
  const onSuspend = () => { suspended = true; stopPlayback(); };
  const onResume = () => { suspended = false; stopPlayback(); };
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('unlock-screen', onUnlock);
  powerMonitor.on('suspend', onSuspend);
  powerMonitor.on('resume', onResume);
  window.on('minimize', stopPlayback);
  window.on('hide', stopPlayback);

  const timer = setInterval(async () => {
    if (locked || suspended || sampling) return;
    const current = revision;
    sampling = true;
    let mode;
    try { mode = await readMode(); }
    catch { /* A frame can disappear while reading its playback state. */ }
    finally { sampling = false; }
    if (current === revision) fishing.updatePlayback(mode);
  }, 1000);

  return () => {
    clearInterval(timer);
    stopPlayback();
    powerMonitor.removeListener('lock-screen', onLock);
    powerMonitor.removeListener('unlock-screen', onUnlock);
    powerMonitor.removeListener('suspend', onSuspend);
    powerMonitor.removeListener('resume', onResume);
    window.removeListener('minimize', stopPlayback);
    window.removeListener('hide', stopPlayback);
  };
}

module.exports = { trackFishing, isPlayerVideoPlaying, isVideoPlaying };
