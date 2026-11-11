// SPDX-License-Identifier: GPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { sites, siteURL } = require('../../src/electron/site-view');

test('the Douyin view allows official HTTPS pages and confines playback to the main website', () => {
  const site = sites.douyin;
  const episode = 'https://www.douyin.com/series?modal_id=7445134423600762164';
  const account = 'https://sso.douyin.com/';
  assert.equal(siteURL(site, episode).href, episode);
  assert.equal(site.canPreview(siteURL(site, episode)), true);
  assert.equal(site.canPreview(siteURL(site, account)), false);
  for (const url of [
    'http://www.douyin.com/series', 'https://www.douyin.com:8443/series', 'https://a@douyin.com/series',
    'https://www.douyin.com.example.org/', 'https://example.org/douyin.com/', 'https://www.bilibili.com/'
  ]) assert.equal(siteURL(site, url), null, url);
});

test('the Bilibili view keeps its video and live page eligibility', () => {
  const site = sites.bilibili;
  assert.equal(site.canPreview(siteURL(site, 'https://www.bilibili.com/video/BV1MW421X7gM/?p=2')), true);
  assert.equal(site.canPreview(siteURL(site, 'https://live.bilibili.com/12345')), true);
  assert.equal(site.canPreview(siteURL(site, 'https://www.bilibili.com/')), false);
  assert.equal(siteURL(site, 'https://www.douyin.com/series'), null);
});

test('Douyin selects a visible playing video and keeps the same element in the Dock', () => {
  const video = (paused, width, height, left = 0, visible = true) => ({
    paused, videoHeight: height,
    checkVisibility: () => visible,
    getBoundingClientRect: () => ({ left, top: 0, right: left + width, bottom: height })
  });
  const playing = video(false, 135, 240);
  const videos = [video(true, 320, 180), video(false, 320, 180, 450), video(false, 320, 180, 0, false), playing];
  let preview = false;
  let marked = null;
  const select = () => vm.runInNewContext(sites.douyin.video, {
    innerWidth: 420,
    innerHeight: 600,
    document: {
      documentElement: { classList: { contains: () => preview } },
      querySelector: () => marked,
      querySelectorAll: () => videos
    }
  });
  assert.equal(select(), playing);
  preview = true;
  marked = playing;
  playing.paused = true;
  assert.equal(select(), playing);
  marked = null;
  assert.equal(select(), null);
});
