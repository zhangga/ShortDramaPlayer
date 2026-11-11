// SPDX-License-Identifier: GPL-3.0-only
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Arch } = require('electron-builder');

module.exports = ({ arch, electronPlatformName, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  const target = { arm64: 'arm64', x64: 'x86_64' }[Arch[arch]];
  const root = packager.projectDir;
  const output = path.join(root, 'build', 'dock-helper', Arch[arch], 'dock-geometry');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  execFileSync('xcrun', ['swiftc', '-O', '-target', `${target}-apple-macos12.0`,
    path.join(root, 'desktop/macos/dock-geometry.swift'), '-o', output], { stdio: 'inherit' });
};
