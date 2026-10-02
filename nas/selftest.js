#!/usr/bin/env node
/**
 * 本地自测：验证后端接口与页面调用方式完全兼容
 *
 * 运行： node selftest.js
 * 它会：① 用临时数据目录拉起服务；② 直接建一个测试用户并自制会话 Cookie；
 *      ③ 按每个页面真实的请求序列逐条打接口；④ 校验隔离与越权防护；⑤ 打印结果
 */

'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'selftest-secret-0123456789abcdef';
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grjl-test-'));

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
}

// 自制会话 Cookie（与服务端算法一致）
function sessionCookie(userId) {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const payload = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return `grjl_session=${encodeURIComponent(`${payload}.${sig}`)}`;
}

const cookie = sessionCookie(1);
const cookie2 = sessionCookie(2);

async function api(method, p, body, opts = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.cookie === null ? {} : { Cookie: opts.cookie || cookie }),
      ...(opts.prefer ? { Prefer: opts.prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

async function waitHealthy(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    SESSION_SECRET: SECRET,
    SITE_DIR: path.resolve(__dirname, '..'),
    GITHUB_CLIENT_ID: 'test',
    GITHUB_CLIENT_SECRET: 'test',
    PUBLIC_URL: BASE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', d => process.env.VERBOSE && process.stdout.write('[server] ' + d));
server.stderr.on('data', d => process.stderr.write('[server:err] ' + d));

function stopServer() {
  try { server.kill(); } catch { /* ignore */ }
}

(async () => {
  const healthy = await waitHealthy();
  if (!healthy) { console.error('❌ 服务未能启动'); stopServer(); process.exit(1); }
  console.log('服务已启动，开始自测\n');

  // 建两个用户，用来验证数据隔离
  const dbPath = path.join(DATA_DIR, 'grjl.db');
  const db = new DatabaseSync(dbPath);
  db.prepare('INSERT OR IGNORE INTO users (id, github_id, login, name, created_at) VALUES (1, ?, ?, ?, ?)')
    .run('1001', 'tester1', '测试用户1', new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO users (id, github_id, login, name, created_at) VALUES (2, ?, ?, ?, ?)')
    .run('1002', 'tester2', '测试用户2', new Date().toISOString());
  db.close();

  // ── 1. 静态托管 ──
  console.log('【静态托管】');
  {
    const r = await fetch(BASE + '/');
    const html = await r.text();
    ok('首页 200', r.status === 200);
    ok('返回 HTML', (r.headers.get('content-type') || '').includes('text/html'));
    ok('内容是站点首页', html.includes('<title>') || html.includes('GRJL'));
    const shim = await fetch(BASE + '/sb-shim.js');
    ok('shim 可访问', shim.status === 200 && (shim.headers.get('content-type') || '').includes('javascript'));
    const trav = await fetch(BASE + '/%2e%2e/nas/server.js');
    ok('阻断编码路径穿越', trav.status === 403, 'status=' + trav.status);
    const backend = await fetch(BASE + '/nas/server.js');
    ok('不暴露后端源码', backend.status === 403, 'status=' + backend.status);
    const dotenv = await fetch(BASE + '/nas/.env');
    ok('不暴露 .env 密钥文件', dotenv.status === 403, 'status=' + dotenv.status);
    const dbFile = await fetch(BASE + '/nas-data/grjl.db');
    ok('不暴露数据库文件', dbFile.status === 403, 'status=' + dbFile.status);
  }

  // ── 2. 鉴权 ──
  console.log('\n【鉴权】');
  {
    const noAuth = await api('GET', '/rest/v1/assets?select=*', null, { cookie: null });
    ok('未登录读写被拒 401', noAuth.status === 401, 'status=' + noAuth.status);
    const me = await api('GET', '/api/me');
    ok('/api/me 返回用户', me.status === 200 && me.json.user.user_metadata.user_name === 'tester1');
    ok('/api/me 带 token', typeof me.json.token === 'string' && me.json.token.split('.').length === 3);
    const payload = JSON.parse(Buffer.from(me.json.token.split('.')[1], 'base64').toString('utf8'));
    eq('token 的 sub 是 user_id', payload.sub, '1');
    const bad = await api('GET', '/api/me', null, { cookie: 'grjl_session=1.9999999999.deadbeef' });
    ok('伪造签名会话被拒', bad.status === 401);
    const route = await fetch(BASE + '/api/auth/login?next=/assets.html', { redirect: 'manual' });
    ok('登录跳转 302', route.status === 302);
    ok('跳到 GitHub 授权页', (route.headers.get('location') || '').startsWith('https://github.com/login/oauth/authorize'));
    ok('带 state 与回调地址', (route.headers.get('location') || '').includes('state=') && (route.headers.get('location') || '').includes('redirect_uri='));
  }

  // ── 3. 资产页（assets.html 走 supabase-js shim 的那套请求）──
  console.log('\n【资产页】');
  let assetId;
  {
    const ins = await api('POST', '/rest/v1/assets', {
      user_id: '1', emoji: '💵', name: '招行活期', category: '现金存款', amount: 12345.67,
      note: '日常', recorded_at: '2026-10-01T00:00:00.000Z',
    }, { prefer: 'return=representation' });
    ok('新增资产 201', ins.status === 201, 'status=' + ins.status);
    assetId = ins.json[0].id;
    ok('返回了 id', !!assetId);
    eq('金额保持数值', ins.json[0].amount, 12345.67);
    ok('自动补 created_at', !!ins.json[0].created_at);

    await api('POST', '/rest/v1/assets', { user_id: '1', name: '沪深300', category: '基金', amount: 50000, emoji: '📈' });
    await api('POST', '/rest/v1/assets', { user_id: '1', name: '贵州茅台', category: '股票', amount: 20000, emoji: '🚀' });

    const list = await api('GET', '/rest/v1/assets?select=*&user_id=eq.1&order=category.asc,amount.desc');
    eq('列表条数 3', list.json.length, 3);
    const cats = list.json.map(r => r.category);
    eq('按类别升序', cats, [...cats].sort());
    const funds = list.json.filter(r => r.category === '基金');
    ok('同类别内按金额降序', funds.length === 1);

    const upd = await api('PATCH', `/rest/v1/assets?id=eq.${assetId}&user_id=eq.1`, { amount: 99999, note: '改了' });
    ok('更新 200', upd.status === 200);
    const after = await api('GET', `/rest/v1/assets?select=*&id=eq.${assetId}`);
    eq('金额已更新', after.json[0].amount, 99999);
    ok('自动补 updated_at', !!after.json[0].updated_at);

    const noFilter = await api('PATCH', '/rest/v1/assets', { amount: 1 });
    ok('拒绝无条件全表更新', noFilter.status === 400, 'status=' + noFilter.status);
    const noFilterDel = await api('DELETE', '/rest/v1/assets');
    ok('拒绝无条件全表删除', noFilterDel.status === 400);
  }

  // ── 4. 快照（breakdown 是 JSON 对象）──
  console.log('\n【资产快照】');
  let snapId;
  {
    const ins = await api('POST', '/rest/v1/asset_snapshots', {
      user_id: '1', total: 182345.67, breakdown: { 现金存款: 12345.67, 基金: 50000, 股票: 120000 },
    }, { prefer: 'return=representation' });
    ok('新增快照 201', ins.status === 201, 'status=' + ins.status);
    snapId = ins.json[0].id;
    const list = await api('GET', '/rest/v1/asset_snapshots?select=*&user_id=eq.1&order=created_at.desc&limit=50');
    const bd = list.json[0].breakdown;
    ok('breakdown 还原成对象', bd && typeof bd === 'object' && bd['基金'] === 50000, JSON.stringify(bd));
    const del = await api('DELETE', `/rest/v1/asset_snapshots?id=eq.${snapId}&user_id=eq.1`, null, { prefer: 'return=representation' });
    ok('删除快照 200', del.status === 200 && del.json.length === 1);
  }

  // ── 5. 日记（upsert on_conflict=user_id,date）──
  console.log('\n【日记】');
  {
    const body = { user_id: '1', date: '2026-10-01', title: '十月一日', body: '第一天', saved_at: '2026-10-01T21:00:00.000Z' };
    const r1 = await api('POST', '/rest/v1/diary_entries?on_conflict=user_id,date', body, { prefer: 'resolution=merge-duplicates,return=minimal' });
    ok('首次写入 201', r1.status === 201, 'status=' + r1.status);
    const r2 = await api('POST', '/rest/v1/diary_entries?on_conflict=user_id,date',
      { ...body, title: '十月一日（改）', body: '改过了' }, { prefer: 'resolution=merge-duplicates,return=minimal' });
    ok('同日重复写入 201', r2.status === 201);
    const same = await api('GET', '/rest/v1/diary_entries?date=eq.2026-10-01&select=title,body,saved_at');
    eq('同一天只有一条', same.json.length, 1);
    eq('内容被覆盖', same.json[0].title, '十月一日（改）');
    eq('select 只返回指定字段', Object.keys(same.json[0]).sort(), ['body', 'saved_at', 'title']);

    await api('POST', '/rest/v1/diary_entries?on_conflict=user_id,date',
      { user_id: '1', date: '2026-10-15', title: '中旬', body: 'x', saved_at: '2026-10-15T21:00:00.000Z' });
    const range = await api('GET', '/rest/v1/diary_entries?date=gte.2026-10-01&date=lte.2026-10-31&select=date,title,body,saved_at&order=date.desc');
    eq('区间查询 2 条', range.json.length, 2);
    eq('按日期倒序', range.json[0].date, '2026-10-15');
  }

  // ── 6. 订阅 ──
  console.log('\n【订阅】');
  let subId;
  {
    const ins = await api('POST', '/rest/v1/subscriptions', {
      user_id: '1', name: 'iCloud+', platform: 'Apple', icon: '☁️', color: '#5c6bc0',
      price: 68, billing_cycle: 'monthly', start_date: '2026-01-01', expire_date: '2027-01-01',
      status: 'active', notes: '',
    }, { prefer: 'return=representation' });
    ok('新增订阅 201', ins.status === 201, 'status=' + ins.status);
    subId = ins.json[0].id;
    const list = await api('GET', '/rest/v1/subscriptions?user_id=eq.1&order=created_at.desc');
    eq('列表 1 条', list.json.length, 1);
    eq('price 是数值', list.json[0].price, 68);
    const upd = await api('PATCH', `/rest/v1/subscriptions?id=eq.${subId}&user_id=eq.1`, { status: 'cancelled' });
    ok('更新 200', upd.status === 200);
    const del = await api('DELETE', `/rest/v1/subscriptions?id=eq.${subId}&user_id=eq.1`);
    ok('删除 200', del.status === 200);
  }

  // ── 7. 微信读书文章（upsert + 布尔字段）──
  console.log('\n【文章】');
  {
    const r1 = await api('POST', '/rest/v1/articles?on_conflict=user_id,url', {
      user_id: '1', url: 'https://mp.weixin.qq.com/s/abc', title: '一篇好文', account: '某公众号',
      summary: '摘要', tags: 'AI', is_read: false, is_starred: false,
    }, { prefer: 'resolution=merge-duplicates,return=representation' });
    ok('新增文章 201', r1.status === 201, 'status=' + r1.status);
    const artId = r1.json[0].id;
    eq('is_read 返回布尔 false', r1.json[0].is_read, false);
    ok('自动补 saved_at', !!r1.json[0].saved_at);

    const r2 = await api('POST', '/rest/v1/articles?on_conflict=user_id,url',
      { user_id: '1', url: 'https://mp.weixin.qq.com/s/abc', title: '一篇好文', account: '某公众号', summary: '摘要', tags: 'AI' },
      { prefer: 'resolution=merge-duplicates,return=minimal' });
    ok('同 url 重复写入 201', r2.status === 201);
    const list = await api('GET', '/rest/v1/articles?select=*&order=saved_at.desc');
    eq('不产生重复', list.json.length, 1);

    const patch = await api('PATCH', `/rest/v1/articles?id=eq.${artId}`, { is_read: true });
    ok('标记已读 200', patch.status === 200);
    const after = await api('GET', '/rest/v1/articles?select=*');
    eq('is_read 变为 true', after.json[0].is_read, true);
  }

  // ── 8. 数据隔离 ──
  console.log('\n【数据隔离】');
  {
    await api('POST', '/rest/v1/assets', { user_id: '1', name: '别人看不到我', category: '其他', amount: 1 });
    const asOther = await api('GET', '/rest/v1/assets?select=*', null, { cookie: cookie2 });
    eq('另一用户读不到数据', asOther.json.length, 0);
    const spoof = await api('POST', '/rest/v1/assets', { user_id: '2', name: '越权伪造', category: '其他', amount: 1 },
      { prefer: 'return=representation' });
    eq('伪造的 user_id 被强制改写', spoof.json[0].user_id, '1');
    const steal = await api('GET', '/rest/v1/assets?select=*&user_id=eq.2');
    ok('按他人 user_id 查询取不到东西', !steal.json.some(r => r.name === '越权伪造' && r.user_id === '2'));
  }

  // ── 9. 导出与健康检查 ──
  console.log('\n【导出 / 健康检查】');
  {
    const dump = await api('GET', '/api/export');
    ok('导出包含全部表', ['assets', 'asset_snapshots', 'diary_entries', 'subscriptions', 'articles'].every(t => t in dump.json.tables));
    eq('导出的资产条数正确', dump.json.tables.assets.length, 5);
    const health = await api('GET', '/api/health');
    ok('健康检查 ok', health.status === 200 && health.json.ok === true);
    ok('健康检查含表条数', typeof health.json.tables.assets === 'number');
  }

  // ── 10. 前端 shim（模拟页面调用方式）──
  console.log('\n【前端 shim】');
  {
    const vm = await import('node:vm');
    const shimSrc = fs.readFileSync(path.resolve(__dirname, '..', 'sb-shim.js'), 'utf8');

    const store = new Map();
    const localStorage = {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    };
    const locationStub = { hash: '', pathname: '/assets.html', search: '', origin: BASE, href: '' };
    let replaced = null;
    const history = { replaceState: (a, b, url) => { replaced = url; locationStub.hash = ''; } };
    const calls = [];

    // 模拟浏览器：相对路径请求自动带上会话 Cookie
    const shimFetch = (input, init) => {
      const url = String(input).startsWith('http') ? String(input) : BASE + String(input);
      calls.push((init && init.method) || 'GET');
      return fetch(url, { ...(init || {}), headers: { ...((init && init.headers) || {}), Cookie: cookie } });
    };

    // 模拟 OAuth 回调后带 token 的 hash（与服务端拼接方式保持一致）
    const fakeUser = JSON.stringify({ id: '1', email: null, user_metadata: { user_name: 'tester1', name: '测试用户1', avatar_url: '' } });
    locationStub.hash = '#' + new URLSearchParams({
      access_token: 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify({ sub: '1' })).toString('base64') + '.sig',
      token_type: 'bearer',
      expires_at: String(Math.floor(Date.now() / 1000) + 86400),
      grjl_user: Buffer.from(fakeUser).toString('base64'),
    }).toString();

    const ctx = { console, setTimeout, URLSearchParams, atob, btoa, fetch: shimFetch, localStorage, location: locationStub, history, Buffer };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(shimSrc, ctx);

    const KEY = 'sb-qknojxdhdjqjdoqjdnyu-auth-token';
    ok('回调 hash 被同步写入 localStorage', store.has(KEY), 'key=' + KEY);
    const seeded = JSON.parse(store.get(KEY) || '{}');
    eq('会话里带上了用户信息', seeded.user?.user_metadata?.user_name, 'tester1');
    ok('会话里带上了 access_token', typeof seeded.access_token === 'string' && seeded.access_token.length > 20);
    ok('写入后清掉了地址栏 hash', replaced === '/assets.html', 'replaceState=' + replaced);
    const decoded = JSON.parse(Buffer.from(seeded.access_token.split('.')[1], 'base64').toString('utf8'));
    eq('token 可被页面解出 user_id', decoded.sub, '1');

    const sb = ctx.window.supabase.createClient('https://qknojxdhdjqjdoqjdnyu.supabase.co', 'anon-key');
    ok('shim 标记正确', ctx.window.supabase.__isLocalShim === true);

    // assets.html 的读取方式
    const q = await sb.from('assets').select('*').eq('user_id', '1').order('category').order('amount', { ascending: false });
    ok('链式查询返回 {data,error}', Array.isArray(q.data) && 'error' in q, JSON.stringify(q.error));
    eq('查到的资产条数', q.data.length, 5);
    const cats = q.data.map(r => r.category);
    eq('排序生效', cats, [...cats].sort());

    // 新增 + 更新 + 删除（完全照抄页面的调用写法）
    const insQ = await sb.from('assets').insert({ user_id: '1', emoji: '🏦', name: 'shim 测试', category: '现金存款', amount: 66.6 });
    ok('insert 返回 {error:null}', insQ.error === null, JSON.stringify(insQ.error));
    const newId = insQ.data[0].id;
    const updQ = await sb.from('assets').update({ amount: 88.8 }).eq('id', newId).eq('user_id', '1');
    ok('update 无错误', updQ.error === null, JSON.stringify(updQ.error));
    const check = await sb.from('assets').select('*').eq('id', newId);
    eq('更新后的金额', check.data[0].amount, 88.8);
    const delQ = await sb.from('assets').delete().eq('id', newId).eq('user_id', '1');
    ok('delete 无错误', delQ.error === null, JSON.stringify(delQ.error));

    // 无筛选条件的全表操作应当被后端拒绝
    const bad = await sb.from('assets').delete();
    ok('无筛选删除返回 error', !!bad.error, 'status=' + bad.status);

    // auth 接口
    const stateChanges = [];
    sb.auth.onAuthStateChange((event, session) => stateChanges.push(event));
    const sess = await sb.auth.getSession();
    ok('getSession 拿到会话', !!sess.data.session?.user);
    await new Promise(r => setTimeout(r, 20));
    ok('已登录时触发 SIGNED_IN', stateChanges.includes('SIGNED_IN'), stateChanges.join(','));

    sb.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: BASE + '/index.html' } });
    ok('点登录会跳到 /api/auth/login', locationStub.href.startsWith('/api/auth/login?next='), locationStub.href);
    ok('回调地址已正确编码', locationStub.href.includes(encodeURIComponent('/index.html')));

    await sb.auth.signOut();
    ok('退出后清空本地会话', !store.has(KEY));
    ok('退出后触发 SIGNED_OUT', stateChanges.includes('SIGNED_OUT'), stateChanges.join(','));
  }

  // ── 结果 ──
  console.log('\n' + '─'.repeat(48));
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('失败项：');
    failures.forEach(f => console.log('  · ' + f));
  }
  stopServer();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结果 */ }
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('自测异常：', err);
  stopServer();
  process.exit(1);
});
