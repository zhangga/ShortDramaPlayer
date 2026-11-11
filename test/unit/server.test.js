const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../../src/server');
const http = require('node:http');
const { EventEmitter } = require('node:events');

test('occupied preferred ports fall back without crashing or disturbing the existing service', async t => {
  const existing = http.createServer((req, res) => res.end('existing instance'));
  await new Promise(resolve => existing.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => existing.close(resolve)));
  const occupiedPort = existing.address().port;
  const { server, port } = await startServer(occupiedPort);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.notEqual(port, occupiedPort);
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(server.address().port, port);
  assert.equal(await (await fetch(`http://127.0.0.1:${occupiedPort}`)).text(), 'existing instance');
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
});

test('concurrent startup requests receive distinct listening servers', async t => {
  const first = await startServer(0);
  t.after(() => new Promise(resolve => first.server.close(resolve)));
  const others = await Promise.all([startServer(first.port), startServer(first.port)]);
  for (const { server } of others) t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(new Set([first.port, ...others.map(result => result.port)]).size, 3);
  for (const { port } of others) assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
});

test('startup rejects non-conflict and fallback bind failures without reading a null address', async t => {
  const original = http.createServer;
  t.after(() => { http.createServer = original; });
  for (const codes of [['EACCES'], ['EADDRINUSE', 'EACCES']]) {
    const ports = [];
    const attempts = [];
    http.createServer = () => {
      const server = new EventEmitter();
      server.address = () => { assert.fail('failed servers have no listening address'); };
      server.listen = (port, host) => {
        ports.push(port);
        assert.equal(host, '127.0.0.1');
        const code = codes[attempts.length - 1];
        queueMicrotask(() => server.emit('error', Object.assign(new Error('bind failed'), { code })));
      };
      attempts.push(server);
      return server;
    };
    await assert.rejects(startServer(8899), error => error.code === 'EACCES');
    assert.deepEqual(ports, codes.length === 1 ? [8899] : [8899, 0]);
    for (const server of attempts) assert.equal(server.listenerCount('listening'), 0);
  }
});

test('loopback API blocks foreign origins and hosts and returns JSON errors', async t => {
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(base);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(home.headers.get('content-security-policy'), /(?:^|; )frame-src https:\/\/player\.bilibili\.com;/);
  assert.equal((await fetch(`${base}/api/history`)).status, 401);
  assert.equal((await fetch(`${base}/API/history`)).status, 401);
  assert.equal((await fetch(`${base}/Api/History`)).status, 401);
  const rawSetCookie = home.headers.get('set-cookie');
  const Cookie = rawSetCookie.split(';')[0];
  const apiFetch = (url, options = {}) => fetch(url, { ...options, headers: { Cookie, ...options.headers } });
  assert.equal((await apiFetch(`${base}/api/history`)).status, 200);
  assert.equal((await apiFetch(`${base}/API/history`)).status, 200);
  assert.equal((await apiFetch(`${base}/api/history`, { headers: { Origin: base } })).status, 200);
  for (const headers of [{ Origin: 'https://evil.example' }, { Host: `evil.example:${port}` }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const status = await new Promise((resolve, reject) => {
      http.get(`${base}/api/history`, { headers }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  const missing = await apiFetch(`${base}/api/missing`);
  assert.equal(missing.status, 404);
  assert.equal(typeof (await missing.json()).error, 'string');
  assert.equal((await apiFetch(`${base}/api/progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
});

test('API exceptions do not expose filesystem or upstream request details', async t => {
  const service = require('../../src/server/services/dramaService');
  const original = service.getSeriesDetail;
  service.getSeriesDetail = async () => { throw new Error('secret /private/data/file.json?auth=private'); };
  t.after(() => { service.getSeriesDetail = original; });
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(base);
  const response = await fetch(`${base}/api/series/1`, { headers: { Cookie: home.headers.get('set-cookie').split(';')[0] } });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, '操作失败，请稍后重试');
});

test('Douyin accepts episode links and resolves share short links without following foreign redirects', async t => {
  const fetchLocal = globalThis.fetch;
  const calls = [];
  const id = '7445134423600762164';
  const destinations = {
    Episode: `https://www.iesdouyin.com/share/video/${id}/?tracking=1`,
    Foreign: `https://douyin.com.example.org/video/${id}`,
    Series: 'https://www.iesdouyin.com/share/playlet/detail/7581665379895511081/'
  };
  globalThis.fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    calls.push(url);
    const code = new URL(url).pathname.split('/')[1];
    return new Response(null, { status: 302, headers: { location: destinations[code] } });
  };
  t.after(() => { globalThis.fetch = fetchLocal; });
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetchLocal(base);
  const Cookie = home.headers.get('set-cookie').split(';')[0];
  const resolveShare = text => fetchLocal(`${base}/api/douyin/share-link`, {
    method: 'POST', headers: { Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ text })
  });
  const video = `https://www.douyin.com/video/${id}`;
  for (const input of [video, `复制打开抖音 https://v.douyin.com/Episode/。 03/20`]) {
    const response = await resolveShare(input);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url: video });
  }
  const episode = `https://www.douyin.com/series?modal_id=${id}`;
  assert.deepEqual(await (await resolveShare(episode + '&tracking=1')).json(), { url: episode });
  assert.equal((await resolveShare('https://v.douyin.com@foreign.example/Episode/')).status, 400);
  assert.equal((await resolveShare('https://v.douyin.com/Foreign/')).status, 422);
  const series = await resolveShare('https://v.douyin.com/Series/');
  assert.equal(series.status, 422);
  assert.match((await series.json()).error, /单|某一集/);
  assert.deepEqual(calls, ['Episode', 'Foreign', 'Series'].map(code => `https://v.douyin.com/${code}/`));
});

test('Bilibili short links resolve only to HTTPS video pages on Bilibili', async t => {
  const fetchLocal = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    const location = url.endsWith('/Ab12Z')
      ? 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2'
      : 'https://elsewhere.example/video/BV1GJ411x7h7';
    return new Response(null, { status: 302, headers: { location } });
  };
  t.after(() => { globalThis.fetch = fetchLocal; });

  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetchLocal(base);
  const Cookie = home.headers.get('set-cookie').split(';')[0];
  const resolve = code => fetchLocal(`${base}/api/bilibili/short-link?code=${encodeURIComponent(code)}`, { headers: { Cookie } });

  const good = await resolve('Ab12Z');
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { url: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2' });
  assert.equal((await resolve('Elsewhere')).status, 422);
  assert.equal((await resolve('../private')).status, 400);
  assert.deepEqual(calls, [
    { url: 'https://b23.tv/Ab12Z', redirect: 'manual' },
    { url: 'https://b23.tv/Elsewhere', redirect: 'manual' }
  ]);
});

test('servers on different ports isolate cookies via port-specific cookie names', async t => {
  const s1 = await startServer(0);
  t.after(() => new Promise(resolve => s1.server.close(resolve)));
  const s2 = await startServer(0);
  t.after(() => new Promise(resolve => s2.server.close(resolve)));

  const home1 = await fetch(`http://127.0.0.1:${s1.port}`);
  const home2 = await fetch(`http://127.0.0.1:${s2.port}`);

  const cookies1 = typeof home1.headers.getSetCookie === 'function' ? home1.headers.getSetCookie() : [home1.headers.get('set-cookie')];
  const portCookie1 = cookies1.find(c => c.startsWith(`player_session_${s1.port}=`))?.split(';')[0];
  assert.ok(portCookie1, `Must set port-specific cookie player_session_${s1.port}`);

  const cookies2 = typeof home2.headers.getSetCookie === 'function' ? home2.headers.getSetCookie() : [home2.headers.get('set-cookie')];
  const s2GenericToken = cookies2.find(c => c.startsWith('player_session='))?.split(';')[0];

  const browserCookieHeader = `${s2GenericToken}; ${portCookie1}`;
  const res1 = await fetch(`http://127.0.0.1:${s1.port}/api/history`, {
    headers: { Cookie: browserCookieHeader }
  });
  assert.equal(res1.status, 200);
});

test('system log diagnostics endpoints return 200 and open paths', async t => {
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const home = await fetch(base);
  const Cookie = home.headers.get('set-cookie').split(';')[0];
  const apiFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { Cookie, ...opts.headers } });

  const getLogsRes = await apiFetch(`${base}/api/system/logs`);
  assert.equal(getLogsRes.status, 200);
  const logsData = await getLogsRes.json();
  assert.ok(logsData.logFile);
  assert.ok(logsData.logDir);

  const openDirRes = await apiFetch(`${base}/api/system/open-log-dir`, { method: 'POST' });
  assert.equal(openDirRes.status, 200);
  const openDirData = await openDirRes.json();
  assert.equal(openDirData.success, true);
  assert.ok(openDirData.logDir);

  const openFileRes = await apiFetch(`${base}/api/system/open-log-file`, { method: 'POST' });
  assert.equal(openFileRes.status, 200);
  const openFileData = await openFileRes.json();
  assert.equal(openFileData.success, true);
  assert.ok(openFileData.logFile);
});

test('all GitHub Actions workflow files are valid YAML', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const jsyaml = require('js-yaml');
  const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
  if (fs.existsSync(workflowsDir)) {
    const files = fs.readdirSync(workflowsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
    assert.ok(files.length > 0, 'Must have at least one workflow file');
    for (const file of files) {
      const fullPath = path.join(workflowsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');
      const parsed = jsyaml.load(content);
      assert.ok(parsed && typeof parsed === 'object', `Workflow ${file} must parse into a YAML object`);
      assert.ok(parsed.name, `Workflow ${file} must have a name attribute`);
    }
  }
});

test('near-end prefetch endpoint requires a session and validates the episode', async t => {
  const service = require('../../src/server/services/streamService');
  const original = service.prefetch;
  const calls = [];
  service.prefetch = (...args) => calls.push(args);
  t.after(() => { service.prefetch = original; });
  const { server, port } = await startServer(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/prefetch/123`, { method: 'POST' })).status, 401);
  const home = await fetch(base);
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const options = { method: 'POST', headers: { Cookie: cookie } };
  assert.equal((await fetch(`${base}/api/prefetch/invalid`, options)).status, 400);
  assert.equal((await fetch(`${base}/api/prefetch/123`, options)).status, 202);
  assert.equal((await fetch(`${base}/api/prefetch/124?next_vids=125,126`, options)).status, 202);
  assert.deepEqual(calls, [
    ['123', 'auto', true, 45000, []],
    ['124', 'auto', true, 45000, ['125', '126']]
  ]);
});
