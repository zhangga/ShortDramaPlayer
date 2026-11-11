// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const { startServer } = require('../../src/server');
const { createInterface } = require('node:readline');
const { getFishing } = require('../../src/server/services/fishingService');
const store = require('../../src/server/services/storeService');
const stream = require('../../src/server/services/streamService');

async function main() {
  const { server, port } = await startServer(0);
  const fishing = getFishing();
  fishing.start();
  process.stdout.write('PLAYER_PORT=' + port + '\n');
  let finishing;
  const finish = () => finishing ||= fishing.finish().catch(error => {
    console.error(error);
    return null;
  });
  const sendMessage = (name, message) => {
    process.stdout.write(name + '=' + Buffer.from(message || '', 'utf8').toString('base64') + '\n');
  };

  async function shutdown() {
    await finish();
    stream.shutdown();
    server.close();
    server.closeAllConnections();
    await store.pending.catch(console.error);
    process.exit(0);
  }

  // The desktop window owns the pipe. Windows closes it even if the host crashes.
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on('line', async line => {
    if (line === 'FISHING_EXIT') {
      sendMessage('FISHING_EXIT', await finish());
    } else if (!finishing && line === 'FISHING_RECAP') {
      const message = fishing.takeRecap();
      if (message) sendMessage('FISHING_RECAP', message);
    } else if (!finishing && /^FISHING_MODE=(off|taskbar|compact|large)$/.test(line)) {
      fishing.updatePlayback(line.slice(13));
    }
  });
  input.once('close', shutdown);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
