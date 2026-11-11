// SPDX-License-Identifier: GPL-3.0-only
const config = require('../fishing-config.json');

class FishingSupabase {
  constructor(url, publishableKey, request = fetch) {
    this.url = url;
    this.publishableKey = publishableKey;
    this.request = request;
  }

  async post(path, body, accessToken) {
    const headers = { apikey: this.publishableKey, 'Content-Type': 'application/json' };
    if (accessToken) headers.Authorization = 'Bearer ' + accessToken;
    const response = await this.request(this.url + path, {
      method: 'POST', headers, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('Supabase 请求失败（HTTP ' + response.status + '）');
    return response.status === 204 ? null : response.json();
  }

  async session(previous) {
    if (previous?.expiresAt > Date.now() + 60_000) return previous;
    const result = previous
      ? await this.post('/auth/v1/token?grant_type=refresh_token', { refresh_token: previous.refreshToken })
      : await this.post('/auth/v1/signup', { data: {} });
    if (typeof result.access_token !== 'string' || typeof result.refresh_token !== 'string' ||
        !Number.isFinite(result.expires_in)) throw new Error('Supabase 未返回匿名会话');
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + result.expires_in * 1000
    };
  }

  rpc(name, body, session) {
    return this.post('/rest/v1/rpc/' + name, body, session?.accessToken);
  }
}

function configuredSupabase() {
  const url = process.env.FISHING_SUPABASE_URL || config.url;
  const key = process.env.FISHING_SUPABASE_PUBLISHABLE_KEY || config.publishableKey;
  try {
    const endpoint = new URL(url);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
    if ((endpoint.protocol === 'https:' || (loopback && endpoint.protocol === 'http:')) &&
        endpoint.href === endpoint.origin + '/' && /^sb_publishable_[\w-]+$/.test(key)) {
      return new FishingSupabase(endpoint.origin, key);
    }
  } catch {}
  return null;
}

module.exports = { FishingSupabase, configuredSupabase };
