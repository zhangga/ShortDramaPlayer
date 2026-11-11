const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FishingService } = require('../../src/server/services/fishingService');
const { FishingSupabase } = require('../../src/server/services/fishingSupabase');

function fixture({ cloud, start = '2026-11-11T10:00:00+08:00', state = {} } = {}) {
  let wall = Date.parse(start);
  let tick = 0;
  const store = {
    getFishing: () => state.fishing || {},
    async mutate(update) { state = update(state).state; }
  };
  const fishing = new FishingService({ store, cloud, now: () => wall, monotonic: () => tick });
  const step = (milliseconds, mode) => {
    wall += milliseconds;
    tick += milliseconds;
    fishing.updatePlayback(mode);
  };
  function play(mode, milliseconds) {
    step(0, mode);
    while (milliseconds > 0) {
      const interval = Math.min(1000, milliseconds);
      step(interval, mode);
      milliseconds -= interval;
    }
  }
  return { fishing, step, play, state: () => state };
}

test('scores each mode separately, persists remainders and skips pauses and sleep', async () => {
  const { fishing, step, play, state } = fixture();
  assert.equal(fishing.status().nickname, null);
  play('taskbar', 11 * 60_000);
  step(0);
  step(120_000);
  play('compact', 8 * 60_000);
  play('large', 7 * 60_000);
  step(150_000, 'large');
  play('taskbar', 11 * 60_000);
  assert.deepEqual(fishing.status().today, { seconds: 2220, fish: [2, 1, 2], total: 5 });
  assert.match(await fishing.finish(), /今天摸鱼 37 分钟，捞了 5 条鱼/);
  const restored = fixture({ state: state() }).fishing;
  assert.deepEqual(restored.status().today, fishing.status().today);
});

test('splits a playing interval at Beijing midnight and shows the previous day once', async () => {
  const { fishing, step, play } = fixture({ start: '2026-11-11T23:57:00+08:00' });
  play('large', 179_500);
  step(1000, 'large');
  assert.match(fishing.takeRecap(), /昨天摸鱼 3 分钟，捞了 1 条鱼/);
  assert.equal(fishing.takeRecap(), null);
  play('large', 179_500);
  assert.deepEqual(fishing.status().today, { seconds: 180, fish: [0, 0, 1], total: 1 });
  await fishing.setRecaps(false);
  assert.equal(await fishing.finish(), null);
});

test('sends only daily fish snapshots after opt-in, retries offline and withdraws', async () => {
  const calls = [];
  let offline = true;
  const session = { accessToken: 'user', refreshToken: 'refresh', expiresAt: Infinity };
  const cloud = {
    async session(previous) { return previous || session; },
    async rpc(name, body) {
      calls.push({ name, body });
      if (offline) throw new Error('offline');
    }
  };
  const initial = fixture({ cloud });
  const { fishing, play } = initial;
  play('large', 180_000);
  await fishing.sync();
  assert.deepEqual(calls, []);
  await assert.rejects(fishing.join('  '), /昵称/);
  await fishing.join('摸鱼仔');
  await fishing.sync();
  assert.equal(fishing.status().pending, true);
  const score = {
    name: 'fishing_submit',
    body: { p_day: '2026-11-11', p_nickname: '摸鱼仔', p_taskbar: 0, p_compact: 0, p_large: 1 }
  };
  assert.deepEqual(calls, [score]);
  offline = false;
  const restored = fixture({ cloud, state: initial.state() }).fishing;
  await restored.sync();
  assert.equal(restored.status().pending, false);
  await restored.sync();
  assert.deepEqual(calls, [score, score]);
  await restored.leave();
  await restored.sync();
  assert.equal(restored.status().nickname, null);
  assert.equal(restored.status().withdrawing, false);
  assert.equal(restored.status().today.total, 1);
  assert.deepEqual(calls.at(-1), { name: 'fishing_leave', body: {} });
});

test('uses publishable and per-user credentials correctly, including empty RPC responses', async () => {
  const requests = [];
  const cloud = new FishingSupabase('https://example.supabase.co', 'sb_publishable_test', async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (url.includes('/auth/')) {
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    return new Response(null, { status: 204 });
  });
  const session = await cloud.session();
  assert.deepEqual(requests[0], {
    url: 'https://example.supabase.co/auth/v1/signup',
    headers: { apikey: 'sb_publishable_test', 'Content-Type': 'application/json' }, body: { data: {} }
  });
  assert.equal(await cloud.session(session), session);
  await cloud.session({ ...session, expiresAt: 0 });
  assert.deepEqual(requests[1].body, { refresh_token: 'refresh' });
  await cloud.rpc('fishing_leave', {}, session);
  assert.equal(requests[2].headers.Authorization, 'Bearer access');
  await cloud.rpc('fishing_leaderboard', { p_period: 'week' });
  assert.equal(requests[3].headers.Authorization, undefined);
});
