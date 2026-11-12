// SPDX-License-Identifier: GPL-3.0-only
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
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
  const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  return {
    async evaluate(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    move,
    async click(button, clickCount, x = 15, y = 15) {
      await move(x, y);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x, y, button, clickCount });
      }
    },
    async key(key, code, windowsVirtualKeyCode) {
      for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode });
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

async function verify(executable, profile, expectGuide) {
  await rm(path.join(profile, 'DevToolsActivePort'), { force: true });
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
    const findPage = async pathname => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await response.json()).find(item => item.type === 'page' && item.url.endsWith(pathname));
    };
    const page = async pathname => {
      const target = await until(() => findPage(pathname), pathname);
      const client = await connect(target.webSocketDebuggerUrl);
      clients.push(client);
      return client;
    };
    const guidePage = '/mac-dock-guide.html';
    const player = await page('/');
    await until(() => player.evaluate('Boolean(window.shortDramaDesktop && document.querySelector("#app[data-v-app] .mac-player-controls"))'), 'the player toolbar');
    assert.equal(await findPage(guidePage), undefined);
    if (expectGuide) {
      await player.evaluate("document.querySelector('.header-menu-btn').click()");
      await until(() => player.evaluate(`(() => {
        const entry = [...document.querySelectorAll('.header-dropdown-menu button')]
          .find(button => button.textContent.includes('快捷键指南'));
        if (!entry) return false;
        entry.click();
        return true;
      })()`), 'the shortcut guide menu entry');
      const shortcuts = await until(() => player.evaluate("document.querySelector('.dock-shortcuts')?.innerText"), 'the Mac shortcut guide');
      for (const label of ['返回小窗', '等比缩放', '移动画面', 'Esc']) assert.ok(shortcuts.includes(label), label);
      const shortcutRegistered = await player.evaluate("document.querySelector('.mac-player-controls button:last-child').title.includes('F9')");
      if (shortcutRegistered) assert.ok(shortcuts.includes('⌃⌥F9'));
      await player.evaluate("document.querySelector('.shortcuts-confirm-btn').click()");
    }
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
    const returnVisible = () => overlay.evaluate("getComputedStyle(document.querySelector('.preview-return')).opacity === '1'");
    const returnToCompact = async (action, label) => {
      // Returning can destroy the overlay before CDP acknowledges the input release.
      const input = action().catch(error => error);
      try {
        await until(() => player.evaluate("!document.documentElement.classList.contains('taskbar-preview') && document.querySelector('.mac-player-controls').textContent.includes('大窗')"), label);
      } catch (error) {
        throw (await input) ?? error;
      }
    };
    if (!expectGuide) {
      assert.deepEqual(await size(), [29, 52]);
      await overlay.move(-5, -5);
      await until(async () => !(await returnVisible()), 'the return button to hide without hover or keyboard focus');
      await overlay.key('Tab', 'Tab', 9);
      await until(returnVisible, 'the return button to appear on keyboard focus');
      await overlay.key('Tab', 'Tab', 9);
      assert.equal(await overlay.evaluate("document.activeElement.matches('.preview-return:focus-visible')"), true);
      assert.equal(await overlay.evaluate(`(() => {
        const button = document.querySelector('.preview-return');
        const bounds = button.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight &&
          button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight;
      })()`), true, 'the return label fits the smallest portrait preview');
      assert.equal(await findPage(guidePage), undefined);
      await returnToCompact(() => overlay.key(' ', 'Space', 32), 'Space on the return button to restore the player');
      assert.equal(await paused(), false);
      console.log('Verified keyboard focus and return in the minimum-size Dock preview after relaunch.');
      return;
    }

    const guide = await page(guidePage);
    const panel = await until(() => guide.evaluate(`(() => {
      const button = document.querySelector('button');
      if (!button) return;
      const bounds = button.getBoundingClientRect();
      return { text: document.body.innerText, x: screenX, y: screenY, width: innerWidth, height: innerHeight,
        dismiss: [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2] };
    })()`), 'the first Dock guide');
    assert.match(panel.text, /右键返回小窗 · 双击展开或缩回/);
    const [x, y] = await position();
    const [previewWidth, previewHeight] = await size();
    assert.ok(panel.y + panel.height <= y || panel.y >= y + previewHeight ||
      panel.x + panel.width <= x || panel.x >= x + previewWidth, 'the guide does not cover the video');
    const dismiss = guide.click('left', 1, ...panel.dismiss).catch(error => error);
    try {
      await until(async () => !(await findPage(guidePage)), 'the Dock guide to close on dismissal');
    } catch (error) {
      throw (await dismiss) ?? error;
    }
    assert.equal(JSON.parse(await readFile(path.join(profile, 'dock-guide-seen.json'), 'utf8')), true);
    await overlay.activate();
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
    await returnToCompact(() => overlay.click('right', 1), 'right click to return to the compact player');
    overlay = await enter();
    assert.equal(await findPage(guidePage), undefined);
    assert.deepEqual(await size(), dockedSize);
    assert.deepEqual(await position(), dockedPosition);
    await expand();
    assert.deepEqual(await size(), remembered);
    await overlay.move(-5, -5);
    await until(async () => !(await returnVisible()), 'the return button to hide when the pointer leaves');
    await overlay.move(15, 15);
    await until(returnVisible, 'the return button to appear on hover');
    const point = await overlay.evaluate(`(() => {
      const bounds = document.querySelector('.preview-return').getBoundingClientRect();
      return [bounds.left + bounds.width / 2, bounds.top + bounds.height / 2];
    })()`);
    await returnToCompact(() => overlay.click('left', 1, ...point), 'clicking the return button to restore the player');
    console.log('Verified the first Dock guide, hover return, shortcuts, zoom, dragging, pause/play, and right-click return.');
  } catch (error) {
    console.error(output.slice(-12000));
    throw error;
  } finally {
    for (const client of clients) client.close();
    app.kill();
    await until(() => exitCode !== undefined, 'app shutdown', 5000).catch(() => app.kill('SIGKILL'));
  }
}

async function run(executable) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'shortdrama-dock-'));
  try {
    await verify(executable, profile, true);
    await writeFile(path.join(profile, 'dock-preview-scale.json'), '0.5');
    await verify(executable, profile, false);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

run(process.argv[2]).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
