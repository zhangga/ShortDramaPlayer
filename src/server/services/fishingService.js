// SPDX-License-Identifier: GPL-3.0-only
const { configuredSupabase } = require('./fishingSupabase');

const DAY = 86_400_000;
const BEIJING = 8 * 3_600_000;
const FISH_INTERVALS = { taskbar: 600_000, compact: 300_000, large: 180_000 };
const MODES = Object.keys(FISH_INTERVALS);
const PAGE_SIZE = 25;

function dayAt(time) {
  return new Date(time + BEIJING).toISOString().slice(0, 10);
}

function nextMidnight(time) {
  return (Math.floor((time + BEIJING) / DAY) + 1) * DAY - BEIJING;
}

function summarize(day = {}) {
  const milliseconds = mode => Number.isFinite(day[mode]) && day[mode] > 0 ? day[mode] : 0;
  const fish = MODES.map(mode => Math.floor(milliseconds(mode) / FISH_INTERVALS[mode]));
  return {
    seconds: Math.floor(MODES.reduce((sum, mode) => sum + milliseconds(mode), 0) / 1000),
    fish,
    total: fish.reduce((sum, count) => sum + count, 0)
  };
}

function recapText(summary, yesterday = false) {
  const minutes = Math.floor(summary.seconds / 60);
  return (yesterday ? '昨天' : '今天') + '摸鱼' + (minutes ? ' ' + minutes + ' 分钟' : '不到 1 分钟') +
    '，捞了 ' + summary.total + ' 条鱼。' + (yesterday ? '今天开新塘！' : '收竿，愉快下班！');
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

class FishingService {
  constructor({ store, cloud, now = Date.now, monotonic = () => performance.now() }) {
    this.store = store;
    this.cloud = cloud;
    this.now = now;
    this.monotonic = monotonic;
    this.data = { days: {}, sent: {}, nickname: null, joinedDay: null, recaps: true, ...store.getFishing() };
    this.observedDay = dayAt(this.now());
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.persist().catch(() => {});
      if (!this.nextSync || this.now() >= this.nextSync) {
        this.nextSync = this.now() + 30_000;
        void this.sync();
      }
    }, 10_000).unref();
    void this.sync();
  }

  updatePlayback(mode = null) {
    const wall = this.now();
    const tick = this.monotonic();
    const previous = this.sample;
    this.sample = { mode, tick, wall };
    const elapsed = previous ? Math.round(tick - previous.tick) : 0;
    // A missed sample or a clock change must not turn sleep into playback time.
    if (Object.hasOwn(FISH_INTERVALS, previous?.mode) && elapsed > 0 && elapsed <= 4000 &&
        Math.abs(wall - previous.wall - elapsed) <= 1000) {
      for (let start = wall - elapsed; start < wall;) {
        const end = Math.min(wall, nextMidnight(start));
        const date = dayAt(start);
        const day = this.data.days[date] ||= {};
        day[previous.mode] = Math.min(DAY, (day[previous.mode] || 0) + end - start);
        this.dirty = true;
        start = end;
      }
    }
    this.observeDay(wall);
  }

  observeDay(wall = this.now()) {
    const today = dayAt(wall);
    if (today <= this.observedDay) return;
    const yesterday = summarize(this.data.days[dayAt(wall - DAY)]);
    this.recap = this.data.recaps && yesterday.seconds ? recapText(yesterday, true) : null;
    this.observedDay = today;
  }

  takeRecap() {
    const wall = this.now();
    if (this.sample && wall - this.sample.wall <= 4000 && dayAt(wall) > this.observedDay) {
      this.updatePlayback(this.sample.mode);
    } else {
      this.observeDay(wall);
    }
    const message = this.recap ?? null;
    this.recap = null;
    return message;
  }

  status() {
    const today = dayAt(this.now());
    return {
      today: summarize(this.data.days[today]), configured: Boolean(this.cloud),
      nickname: this.data.nickname, recaps: this.data.recaps,
      withdrawing: Boolean(this.data.withdraw),
      pending: Boolean(this.data.nickname && (!this.data.session || this.pendingDays().length))
    };
  }

  persist() {
    if (!this.dirty) return this.saving || Promise.resolve();
    this.dirty = false;
    const fishing = structuredClone(this.data);
    this.saving = this.store.mutate(state => ({ state: { ...state, fishing } })).catch(error => {
      this.dirty = true;
      throw error;
    });
    return this.saving;
  }

  async join(nickname) {
    if (!this.cloud) throw badRequest('在线榜单尚未配置');
    if (this.data.nickname || this.data.withdraw) throw badRequest('已加入排行榜，或正在同步退出');
    nickname = typeof nickname === 'string' ? nickname.trim() : '';
    if (!nickname || [...nickname].length > 20 || /[\p{Cc}\p{Cf}]/u.test(nickname)) {
      throw badRequest('请输入 1 至 20 个字的昵称');
    }
    this.data.nickname = nickname;
    this.data.joinedDay = dayAt(this.now());
    this.dirty = true;
    await this.persist();
    void this.sync();
    return this.status();
  }

  async leave() {
    this.data.nickname = null;
    this.data.joinedDay = null;
    this.data.sent = {};
    this.data.withdraw = Boolean(this.data.session);
    this.dirty = true;
    await this.persist();
    void this.sync().then(() => {
      if (this.data.withdraw && !this.syncFailed) void this.sync();
    });
    return this.status();
  }

  async setRecaps(enabled) {
    if (typeof enabled !== 'boolean') throw badRequest('无效的结算提示设置');
    this.data.recaps = enabled;
    if (!enabled) this.recap = null;
    this.dirty = true;
    await this.persist();
    return this.status();
  }

  pendingDays() {
    const today = dayAt(this.now());
    return Object.entries(this.data.days)
      .filter(([day]) => day >= this.data.joinedDay && day <= today)
      .map(([day, time]) => ({ day, ...summarize(time) }))
      .filter(({ day, total }) => total > (this.data.sent[day] || 0));
  }

  sync() {
    if (!this.cloud || (!this.data.nickname && !this.data.withdraw)) return Promise.resolve();
    this.syncing ||= this.push().then(() => { this.syncFailed = false; }, () => {
      this.syncFailed = true;
    }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async push() {
    const pending = this.data.nickname ? this.pendingDays() : [];
    if (this.data.session && !this.data.withdraw && !pending.length) return;
    await this.persist();
    if (!this.data.nickname && !this.data.withdraw) return;
    const session = await this.cloud.session(this.data.session);
    if (!this.data.nickname && !this.data.withdraw) return;
    if (session !== this.data.session) {
      this.data.session = session;
      this.dirty = true;
      await this.persist();
    }
    if (this.data.withdraw) {
      await this.cloud.rpc('fishing_leave', {}, session);
      this.data.withdraw = false;
      this.dirty = true;
      await this.persist();
      return;
    }
    for (const { day, fish, total } of pending) {
      if (!this.data.nickname) return;
      await this.cloud.rpc('fishing_submit', {
        p_day: day, p_nickname: this.data.nickname,
        p_taskbar: fish[0], p_compact: fish[1], p_large: fish[2]
      }, session);
      if (!this.data.nickname) return;
      this.data.sent[day] = total;
      this.dirty = true;
    }
    await this.persist();
  }

  async leaderboard(period, page) {
    if (!['today', 'week'].includes(period) || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
      throw badRequest('无效的排行榜范围');
    }
    if (!this.cloud) return { rows: [], more: false };
    void this.sync();
    const rows = await this.cloud.rpc('fishing_leaderboard', {
      p_period: period, p_offset: (page - 1) * PAGE_SIZE
    });
    return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  async finish() {
    this.updatePlayback();
    clearInterval(this.timer);
    this.timer = null;
    await this.persist();
    void this.sync();
    const today = this.status().today;
    return this.data.recaps && today.seconds ? recapText(today) : null;
  }
}

let service;
function getFishing() {
  return service ||= new FishingService({ store: require('./storeService'), cloud: configuredSupabase() });
}

module.exports = { FishingService, getFishing };
