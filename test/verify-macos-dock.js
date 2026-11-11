// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function until(read, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const response = JSON.parse(event.data);
    pending.get(response.id)?.(response);
  });
  async function send(method, params) {
    const id = ++nextId;
    try {
      const response = await Promise.race([
        new Promise(resolve => {
          pending.set(id, resolve);
          socket.send(JSON.stringify({ id, method, params }));
        }),
        delay(5000, null, { ref: false })
      ]);
      if (!response || response.error) throw new Error(response?.error?.message ?? `${method} timed out`);
      return response.result;
    } finally {
      pending.delete(id);
    }
  }
  return {
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async click(button, clickCount) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 15, y: 15 });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: 15, y: 15, button, clickCount });
      }
    },
    async drag(dx, dy) {
      const x = 25;
      const y = 40;
      const mouse = (type, x, y, button, buttons) =>
        send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
      await mouse('mouseMoved', x, y, 'none', 0);
      await mouse('mousePressed', x, y, 'left', 1);
      await mouse('mouseMoved', x + dx, y + dy, 'none', 1);
      await mouse('mouseReleased', x + dx, y + dy, 'left', 0);
    },
    wheel: (deltaY, deltaX = 0) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 15, y: 15, deltaX, deltaY }),
    activate: () => send('Page.bringToFront'),
    close: () => socket.close()
  };
}

async function verify(executable) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'shortdrama-dock-'));
  const app = spawn(executable, ['--remote-debugging-port=0', `--user-data-dir=${profile}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exitCode;
  app.on('exit', code => { exitCode = code; });
  app.stdout.on('data', chunk => { output += chunk; });
  app.stderr.on('data', chunk => { output += chunk; });
  const clients = [];
  try {
    const port = await until(async () => {
      if (exitCode !== undefined) throw new Error(`App exited with ${exitCode}`);
      return /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(output)?.[1] ??
        (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0];
    }, 'the packaged app to start');
    const page = async pathname => {
      const target = await until(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        return (await response.json()).find(item => item.type === 'page' && item.url.endsWith(pathname));
      }, pathname);
      const client = await connect(target.webSocketDebuggerUrl);
      clients.push(client);
      return client;
    };
    const player = await page('/');
    await until(() => player.evaluate('Boolean(window.shortDramaDesktop && document.querySelector(".mac-player-controls"))'), 'the player toolbar');
    await player.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 144;
      canvas.height = 256;
      const context = canvas.getContext('2d');
      setInterval(() => {
        context.fillStyle = '#244768';
        context.fillRect(0, 0, 144, 256);
      }, 40);
      const fixture = document.createElement('div');
      fixture.className = 'theater-view';
      const video = document.createElement('video');
      video.id = 'dock-test-video';
      video.className = 'video-element';
      video.muted = true;
      video.srcObject = canvas.captureStream(20);
      fixture.append(video);
      document.body.append(fixture);
      window.shortDramaDesktop.onMessage(message => {
        if (message === 'taskbar:play') {
          if (video.paused) video.play();
          else video.pause();
        }
      });
      await video.play();
    })()`);
    const enter = async () => {
      await player.evaluate("document.querySelector('.mac-player-controls button:last-child').click()");
      const overlay = await page('/mac-preview.html');
      await until(() => player.evaluate("document.documentElement.classList.contains('taskbar-preview')"), 'preview mode');
      await until(() => overlay.evaluate('Math.abs(innerWidth / innerHeight - 9 / 16) < 0.01'), 'portrait preview size');
      await overlay.activate();
      // Wait for compositor input with a horizontal wheel event that leaves the zoom alone.
      await overlay.evaluate("document.addEventListener('wheel', () => window.dockSmokeReady = true, { once: true })");
      await until(async () => {
        await overlay.wheel(0, 100);
        return overlay.evaluate('Boolean(window.dockSmokeReady)');
      }, 'overlay pointer input');
      return overlay;
    };
    let overlay = await enter();
    const size = () => overlay.evaluate('[innerWidth, innerHeight]');
    const position = () => overlay.evaluate('[screenX, screenY]');
    const expanded = () => overlay.evaluate("document.documentElement.classList.contains('taskbar-expanded')");
    const paused = () => player.evaluate("document.getElementById('dock-test-video').paused");
    const dragPreview = async label => {
      const start = await position();
      const moved = async () => {
        const point = await position();
        return point.some((value, index) => value !== start[index]) && point;
      };
      await overlay.drag(18, -20);
      // A bottom Dock can leave space on only one side of the preview.
      const firstMove = await until(moved, label, 1000).catch(() => null);
      if (firstMove) return firstMove;
      await overlay.drag(-18, -20);
      return until(moved, label);
    };
    await overlay.evaluate(`(() => {
      window.dockSmokeEvents = [];
      for (const name of ['pointerdown', 'pointerup', 'click']) {
        document.addEventListener(name, event => dockSmokeEvents.push([name, event.target.tagName, event.detail]), true);
      }
    })()`);
    await overlay.click('left', 1);
    try {
      await until(paused, 'single click to pause');
    } catch (error) {
      console.error('Dock overlay input:', await overlay.evaluate('JSON.stringify({ focus: document.hasFocus(), events: dockSmokeEvents, hit: document.elementFromPoint(15, 15)?.tagName })'));
      throw error;
    }
    await overlay.click('left', 1);
    await until(async () => !(await paused()), 'single click to resume');

    const [, initialHeight] = await size();
    await overlay.wheel(-100);
    const dockedSize = await until(async () => {
      const next = await size();
      return next[1] > initialHeight && next;
    }, 'wheel zoom in while docked');
    assert.ok(Math.abs(dockedSize[0] / dockedSize[1] - 9 / 16) < 0.01);
    await overlay.wheel(100);
    await until(async () => (await size())[1] < dockedSize[1], 'wheel zoom out while docked');
    await overlay.wheel(-100);
    await until(async () => (await size())[1] === dockedSize[1], 'restore docked test size');
    const dockedPosition = await dragPreview('drag the docked preview');
    assert.equal(await expanded(), false);

    const toggle = async () => {
      await overlay.click('left', 1);
      await overlay.click('left', 2);
    };
    const expand = async () => {
      await toggle();
      await until(expanded, 'double click to expand');
      await until(async () => (await size())[1] > dockedSize[1], 'expanded preview size');
    };
    await expand();
    assert.equal(await paused(), false);
    const [width, height] = await size();
    assert.ok(Math.abs(width / height - 9 / 16) < 0.01);
    await overlay.wheel(-100);
    await until(async () => (await size())[1] > height, 'wheel zoom');
    const remembered = await size();
    await dragPreview('drag the expanded preview');
    await toggle();
    await until(async () => !(await expanded()) && (await size())[1] === dockedSize[1], 'double click to dock again');
    assert.deepEqual(await size(), dockedSize);
    assert.deepEqual(await position(), dockedPosition);
    const leave = async () => {
      // macOS can destroy the overlay on right-button press before CDP acknowledges release.
      const click = overlay.click('right', 1).catch(error => error);
      try {
        await until(() => player.evaluate("!document.documentElement.classList.contains('taskbar-preview') && document.querySelector('.mac-player-controls').textContent.includes('大窗')"), 'right click to return to the compact player');
      } catch (error) {
        throw (await click) ?? error;
      }
    };
    await leave();
    overlay = await enter();
    assert.deepEqual(await size(), dockedSize);
    assert.deepEqual(await position(), dockedPosition);
    await expand();
    assert.deepEqual(await size(), remembered);
    await leave();
    console.log('Verified packaged arm64 player, docked and expanded zoom and dragging, pause/play, and right-click return.');
  } catch (error) {
    console.error(output.slice(-12000));
    throw error;
  } finally {
    for (const client of clients) client.close();
    app.kill();
    await until(() => exitCode !== undefined, 'app shutdown', 5000).catch(() => app.kill('SIGKILL'));
    await rm(profile, { recursive: true, force: true });
  }
}

verify(process.argv[2]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
