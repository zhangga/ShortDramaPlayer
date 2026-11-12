// SPDX-License-Identifier: GPL-3.0-only
const dismiss = () => window.shortDramaDesktop.send('dock-guide:dismiss');
document.querySelector('button').addEventListener('click', dismiss);
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') dismiss();
});
