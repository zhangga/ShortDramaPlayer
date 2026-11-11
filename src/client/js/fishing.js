// SPDX-License-Identifier: GPL-3.0-only
function setupFishing(notify) {
  const { ref, onUnmounted } = Vue;
  const dialog = ref(null);
  const status = ref(null);
  const period = ref('today');
  const page = ref(1);
  const rows = ref([]);
  const more = ref(false);
  const nickname = ref('');
  const loading = ref(false);
  const saving = ref(false);
  const boardError = ref('');
  const settingsError = ref('');
  let boardRequest = 0;
  let refreshTimer;
  let recapDay;

  async function request(path = '', body) {
    const options = body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    };
    const response = await fetch('/api/fishing' + path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '请求失败，请重试');
    return data;
  }

  async function loadBoard(nextPeriod = period.value, nextPage = page.value) {
    period.value = nextPeriod;
    page.value = nextPage;
    const current = ++boardRequest;
    loading.value = true;
    boardError.value = '';
    rows.value = [];
    more.value = false;
    try {
      const result = await request('/leaderboard?period=' + nextPeriod + '&page=' + nextPage);
      if (current !== boardRequest) return;
      rows.value = result.rows;
      more.value = result.more;
    } catch (error) {
      if (current === boardRequest) boardError.value = error.message;
    } finally {
      if (current === boardRequest) loading.value = false;
    }
  }

  async function refreshStatus() {
    try {
      const latest = await request();
      if (saving.value || !dialog.value?.open) return;
      const previous = status.value;
      status.value = latest;
      if ((previous?.pending || previous?.withdrawing) && !latest.pending && !latest.withdrawing) {
        void loadBoard();
      }
    } catch {}
  }

  async function open() {
    if (dialog.value.open) return;
    nickname.value = '';
    settingsError.value = '';
    dialog.value.showModal();
    try {
      status.value = await request();
      if (!dialog.value?.open) return;
      if (status.value.configured) void loadBoard('today', 1);
      clearInterval(refreshTimer);
      refreshTimer = setInterval(refreshStatus, 5000);
    } catch {
      settingsError.value = '暂时无法读取本机摸鱼记录，请重试';
    }
  }

  function closed() {
    clearInterval(refreshTimer);
    boardRequest++;
    document.querySelector('.header-menu-btn')?.focus({ preventScroll: true });
  }

  async function change(path, body = {}) {
    if (saving.value) return;
    saving.value = true;
    settingsError.value = '';
    try {
      status.value = await request(path, body);
      if (path === '/join') nickname.value = '';
    } catch (error) {
      settingsError.value = error.message;
    } finally {
      saving.value = false;
    }
  }

  function checkRecap() {
    if (document.hidden || document.documentElement?.classList.contains?.('taskbar-preview')) return;
    const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
    if (recapDay === day) return;
    recapDay = day;
    request('/recap', {}).then(({ message }) => {
      if (message) notify(message);
    }).catch(() => { recapDay = null; });
  }

  onUnmounted(() => clearInterval(refreshTimer));
  return {
    dialog, status, period, page, rows, more, nickname, loading, saving, boardError, settingsError,
    open, closed, loadBoard, change, checkRecap
  };
}
