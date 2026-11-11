// SPDX-License-Identifier: GPL-3.0-only
'use strict';

const { startServer } = require('../../src/server');
const store = require('../../src/server/services/storeService');
const stream = require('../../src/server/services/streamService');

async function main() {
  const { server, port } = await startServer(0);
  process.stdout.write('PLAYER_PORT=' + port + '\n');

  async function shutdown() {
    stream.shutdown();
    server.close();
    server.closeAllConnections();
    await store.pending.catch(console.error);
    process.exit(0);
  }

  // The desktop window owns the pipe. Windows closes it even if the host crashes.
  process.stdin.once('end', shutdown);
  process.stdin.resume();
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
