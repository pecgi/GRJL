#!/usr/bin/env node
/**
 * GRJL 自托管后端（零依赖）
 *
 * 只使用 Node 内置模块：
 *   - node:sqlite  → 单文件数据库，数据就在 NAS 自己的硬盘上
 *   - node:http    → 静态托管 + API
 *   - node:crypto  → 会话签名、JWT 签发
 *
 * 提供的接口：
 *   静态     GET  /*                      直接托管 GRJL 目录下的页面
 *   认证     GET  /api/auth/login         跳转 GitHub 授权
 *            GET  /api/auth/callback      回调换会话
 *            POST /api/auth/logout        退出
 *            GET  /api/me                 当前登录用户
 *   数据     ALL  /rest/v1/:table         迷你 PostgREST 子集（与原 Supabase 调用完全兼容）
 *   运维     GET  /api/health             健康检查
 *            GET  /api/export             导出当前用户全部数据（备份用）
 *
 * 环境变量见 .env.example
 */

'use strict';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, TABLES } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────
//  配置
// ────────────────────────────────────────────────
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
loadEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 8080);
const SITE_DIR = process.env.SITE_DIR || path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.resolve(__dirname, '..', 'nas-data');
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ALLOWED_LOGIN = (process.env.ALLOWED_LOGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
  console.error('❌ 请在 .env 里设置 SESSION_SECRET（至少 16 个字符）');
  process.exit(1);
}
if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET) {
  console.warn('⚠️  未配置 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET，登录会失败');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

// ────────────────────────────────────────────────
//  数据库
// ────────────────────────────────────────────────
const db = new DatabaseSync(path.join(DATA_DIR, 'grjl.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(SCHEMA_SQL);


// ────────────────────────────────────────────────
//  小工具
// ────────────────────────────────────────────────
const nowIso = () => new Date().toISOString();
const rid = () => crypto.randomUUID();

function sendJson(res, status, obj, extra = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  res.end(body);
}

function sendErr(res, status, message, code = '', details = null) {
  sendJson(res, status, { message, code, details, hint: null }, {});
}

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const b64url = buf => Buffer.from(buf).toString('base64url');

function hmac(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

function makeSessionCookie(userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = `${userId}.${exp}`;
  return `${payload}.${hmac(payload)}`;
}

function readSession(userIdToken) {
  if (!userIdToken) return null;
  const parts = userIdToken.split('.');
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (hmac(`${uid}.${exp}`) !== sig) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  return { uid };
}

function sessionOf(req) {
  return readSession(parseCookies(req)['grjl_session']);
}

function cookieHeader(name, value, req, maxAgeSec) {
  const secure = isHttps(req);
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax` +
    (maxAgeSec ? `; Max-Age=${maxAgeSec}` : '') + (secure ? '; Secure' : '');
}

function isHttps(req) {
  if (PUBLIC_URL.startsWith('https://')) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (proto && String(proto).split(',')[0].trim() === 'https') return true;
  return false;
}

function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host || `localhost:${PORT}`}`;
}

// 与 supabase-js 一致的自签 JWT（页面会 decode sub 拿 user_id）
function makeJwt(user) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const payload = b64url(JSON.stringify({
    sub: String(user.id),
    login: user.login || '',
    name: user.name || '',
    avatar_url: user.avatar_url || '',
    iat: Math.floor(Date.now() / 1000),
    exp,
  }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`${header}.${payload}`).digest('base64');
  return `${header}.${payload}.${sig}`;
}

function publicUser(row) {
  return {
    id: String(row.id),
    email: null,
    user_metadata: {
      user_name: row.login || '',
      name: row.name || row.login || '',
      avatar_url: row.avatar_url || '',
    },
  };
}

// ────────────────────────────────────────────────
//  迷你 PostgREST
// ────────────────────────────────────────────────
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'apikey', 'and', 'or']);

const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'LIKE',
};

function parseFilters(params, table, meta) {
  const where = [];
  const values = [];
  for (const [key, raw] of params.entries()) {
    if (RESERVED.has(key)) continue;
    if (!meta.cols.includes(key)) continue;
    const dot = raw.indexOf('.');
    const op = dot < 0 ? 'eq' : raw.slice(0, dot);
    const val = dot < 0 ? raw : raw.slice(dot + 1);
    if (op === 'is') {
      if (val === 'null') where.push(`${key} IS NULL`);
      else where.push(`${key} IS NOT NULL`);
      continue;
    }
    if (op === 'in') {
      const list = val.replace(/^\(|\)$/g, '').split(',').map(s => s.replace(/^"|"$/g, ''));
      if (!list.length) continue;
      where.push(`${key} IN (${list.map(() => '?').join(',')})`);
      values.push(...list);
      continue;
    }
    if (!OPS[op]) continue;
    where.push(`${key} ${OPS[op]} ?`);
    values.push(val);
  }
  return { where, values };
}

function parseSelect(params, meta) {
  const sel = params.get('select');
  if (!sel || sel.trim() === '*') return null;
  const cols = sel.split(',').map(s => s.trim().split(':').pop().trim())
    .filter(c => c && c !== '*' && meta.cols.includes(c));
  return cols.length ? cols : null;
}

function parseOrder(params, meta) {
  const raw = params.get('order');
  if (!raw) return '';
  const parts = [];
  for (const token of raw.split(',')) {
    const seg = token.trim().split('.');
    const col = seg[0];
    if (!meta.cols.includes(col)) continue;
    const dir = (seg[1] || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    parts.push(`${col} ${dir}`);
  }
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

function serializeRow(row, meta) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (meta.jsons.includes(k)) {
      try { out[k] = v == null ? null : JSON.parse(v); } catch { out[k] = v; }
    } else if (meta.bools.includes(k)) {
      out[k] = !!v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function shape(row, meta, cols) {
  const s = serializeRow(row, meta);
  if (!cols) return s;
  const out = {};
  for (const c of cols) out[c] = s[c];
  return out;
}

function wantsRepresentation(req) {
  return String(req.headers.prefer || '').includes('return=representation');
}

function sanitizeBody(body, meta, userId) {
  const rows = Array.isArray(body) ? body : [body];
  return rows.filter(r => r && typeof r === 'object').map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) {
      if (!meta.cols.includes(k)) continue;
      if (k === 'user_id' && meta.scoped) continue;   // 强制注入，杜绝越权
      out[k] = v;
    }
    return out;
  });
}

async function handleRest(req, res, table, params, session) {
  const meta = TABLES[table];
  if (!meta) return sendErr(res, 404, `表 ${table} 不存在`, '42P01');
  if (meta.scoped && !session) return sendErr(res, 401, '未登录', '401');

  const userId = session ? session.uid : null;
  const cols = parseSelect(params, meta);
  const order = parseOrder(params, meta);
  const limit = params.get('limit');
  const offset = params.get('offset');
  const { where, values } = parseFilters(params, table, meta);

  const scopedWhere = meta.scoped ? [`user_id = ?`, ...where] : where;
  const scopedValues = meta.scoped ? [userId, ...values] : values;

  const method = req.method.toUpperCase();

  // ── 读 ──
  if (method === 'GET' || method === 'HEAD') {
    let sql = `SELECT * FROM ${table}`;
    if (scopedWhere.length) sql += ` WHERE ${scopedWhere.join(' AND ')}`;
    sql += order;
    if (limit) sql += ` LIMIT ${Math.max(0, parseInt(limit, 10) || 0)}`;
    if (offset) sql += ` OFFSET ${Math.max(0, parseInt(offset, 10) || 0)}`;
    const rows = db.prepare(sql).all(...scopedValues);
    const data = rows.map(r => shape(r, meta, cols));
    return sendJson(res, 200, data);
  }

  // ── 写入 ──
  if (method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendErr(res, 400, e.message, '400'); }
    if (!body) return sendErr(res, 400, '缺少请求体', '400');
    const rowsIn = sanitizeBody(body, meta, userId);
    if (!rowsIn.length) return sendErr(res, 400, '没有可写入的字段', '400');

    const onConflictRaw = params.get('on_conflict');
    const merge = String(req.headers.prefer || '').includes('merge-duplicates') && onConflictRaw;

    const inserted = [];
    for (const raw of rowsIn) {
      const row = { ...raw };
      if (meta.scoped) row.user_id = userId;
      if (!row[meta.pk]) row[meta.pk] = rid();
      const t = nowIso();
      if (meta.cols.includes('created_at') && !row.created_at) row.created_at = t;
      if (meta.cols.includes('updated_at')) row.updated_at = t;
      if (meta.cols.includes('saved_at') && !row.saved_at) row.saved_at = t;
      if (meta.cols.includes('recorded_at') && !row.recorded_at) row.recorded_at = t;
      for (const j of meta.jsons) {
        if (row[j] != null && typeof row[j] !== 'string') row[j] = JSON.stringify(row[j]);
      }
      for (const b of meta.bools) {
        if (row[b] != null) row[b] = row[b] ? 1 : 0;
      }
      const keys = Object.keys(row);
      const placeholders = keys.map(() => '?').join(', ');
      let sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`;
      if (merge) {
        const conflictCols = onConflictRaw.split(',').map(s => s.trim()).filter(c => meta.cols.includes(c));
        const updates = keys.filter(k => !conflictCols.includes(k) && k !== meta.pk);
        sql += ` ON CONFLICT(${conflictCols.join(', ')}) DO UPDATE SET ` +
          (updates.length ? updates.map(k => `${k} = excluded.${k}`).join(', ') : `${meta.pk} = ${meta.pk}`);
      }
      try {
        db.prepare(sql).run(...keys.map(k => row[k]));
      } catch (e) {
        const dup = String(e.message).includes('UNIQUE');
        return sendErr(res, dup ? 409 : 400, e.message, dup ? '23505' : '400');
      }
      const back = db.prepare(`SELECT * FROM ${table} WHERE ${meta.pk} = ?`).get(row[meta.pk]);
      inserted.push(shape(back || row, meta, cols));
    }
    if (wantsRepresentation(req) || Array.isArray(body)) return sendJson(res, 201, inserted);
    return sendJson(res, 201, inserted[0]);
  }

  // ── 更新 ──
  if (method === 'PATCH' || method === 'PUT') {
    // 必须带调用方自己的筛选条件，避免误伤整张表（只靠强制注入的 user_id 不够）
    if (!where.length) return sendErr(res, 400, '拒绝全表更新：请带上筛选条件（如 id=eq.xxx）', '400');
    let body;
    try { body = await readBody(req); } catch (e) { return sendErr(res, 400, e.message, '400'); }
    const clean = sanitizeBody(body, meta, userId)[0];
    if (!clean || !Object.keys(clean).length) return sendErr(res, 400, '没有可更新的字段', '400');
    delete clean[meta.pk];
    const sets = [];
    const vals = [];
    for (const [k, v] of Object.entries(clean)) {
      sets.push(`${k} = ?`);
      if (meta.jsons.includes(k)) vals.push(v != null && typeof v !== 'string' ? JSON.stringify(v) : v);
      else if (meta.bools.includes(k)) vals.push(v ? 1 : 0);
      else vals.push(v);
    }
    if (meta.cols.includes('updated_at')) sets.push('updated_at = ?'), vals.push(nowIso());
    const sql = `UPDATE ${table} SET ${sets.join(', ')} WHERE ${scopedWhere.join(' AND ')}`;
    const info = db.prepare(sql).run(...vals, ...scopedValues);
    if (wantsRepresentation(req)) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE ${scopedWhere.join(' AND ')}`).all(...scopedValues);
      return sendJson(res, 200, rows.map(r => shape(r, meta, cols)));
    }
    return sendJson(res, 200, { changes: info.changes });
  }

  // ── 删除 ──
  if (method === 'DELETE') {
    if (!where.length) return sendErr(res, 400, '拒绝全表删除：请带上筛选条件（如 id=eq.xxx）', '400');
    let rows = [];
    if (wantsRepresentation(req)) {
      rows = db.prepare(`SELECT * FROM ${table} WHERE ${scopedWhere.join(' AND ')}`).all(...scopedValues);
    }
    const info = db.prepare(`DELETE FROM ${table} WHERE ${scopedWhere.join(' AND ')}`).run(...scopedValues);
    if (wantsRepresentation(req)) return sendJson(res, 200, rows.map(r => shape(r, meta, cols)));
    return sendJson(res, 200, { changes: info.changes });
  }

  return sendErr(res, 405, `不支持的方法 ${method}`, '405');
}

// ────────────────────────────────────────────────
//  GitHub OAuth
// ────────────────────────────────────────────────
async function handleLogin(req, res, url) {
  const next = url.searchParams.get('next') || '/';
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${baseUrl(req)}/api/auth/callback`;
  const authorize = 'https://github.com/login/oauth/authorize?' + new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'read:user',
    state,
    allow_signup: 'false',
  }).toString();
  res.writeHead(302, {
    Location: authorize,
    'Set-Cookie': [
      cookieHeader('grjl_oauth_state', state, req, 600),
      cookieHeader('grjl_oauth_next', next, req, 600),
    ],
  });
  res.end();
}

async function handleCallback(req, res, url) {
  const cookies = parseCookies(req);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const next = cookies['grjl_oauth_next'] || '/';
  if (!code) return sendErr(res, 400, '缺少 code 参数', '400');
  if (!state || state !== cookies['grjl_oauth_state']) {
    return sendErr(res, 400, 'state 校验失败，请重新登录', '400');
  }

  const redirectUri = `${baseUrl(req)}/api/auth/callback`;
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenJson.access_token) {
    return sendErr(res, 400, 'GitHub 授权失败：' + (tokenJson.error_description || tokenJson.error || '未知错误'), '400');
  }

  const ghRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenJson.access_token}`, 'User-Agent': 'grjl-nas' },
  });
  if (!ghRes.ok) return sendErr(res, 400, `读取 GitHub 用户失败 (${ghRes.status})`, '400');
  const gh = await ghRes.json();

  if (ALLOWED_LOGIN.length && !ALLOWED_LOGIN.includes(gh.login)) {
    return sendErr(res, 403, `账号 ${gh.login} 不在允许名单内`, '403');
  }

  let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(gh.id));
  if (!user) {
    db.prepare('INSERT INTO users (github_id, login, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(gh.id), gh.login, gh.name || gh.login, gh.avatar_url || '', nowIso());
    user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(String(gh.id));
  } else {
    db.prepare('UPDATE users SET login = ?, name = ?, avatar_url = ? WHERE id = ?')
      .run(gh.login, gh.name || gh.login, gh.avatar_url || '', user.id);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  }

  const jwt = makeJwt(user);
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const hash = new URLSearchParams({
    access_token: jwt,
    token_type: 'bearer',
    expires_at: String(exp),
    grjl_user: Buffer.from(JSON.stringify(publicUser(user))).toString('base64'),
  }).toString();

  // 剥掉可能已存在的 fragment，再拼上新的
  const target = (next.startsWith('/') ? next : '/').split('#')[0];
  res.writeHead(302, {
    Location: `${target}#${hash}`,
    'Set-Cookie': [
      cookieHeader('grjl_session', makeSessionCookie(user.id), req, SESSION_DAYS * 86400),
      'grjl_oauth_state=; Path=/; HttpOnly; Max-Age=0',
      'grjl_oauth_next=; Path=/; HttpOnly; Max-Age=0',
    ],
  });
  res.end();
}

// ────────────────────────────────────────────────
//  静态文件
// ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// 不允许通过静态托管拿到的路径：后端源码目录、隐藏文件、数据库文件
const BLOCKED_SEGMENTS = new Set(['nas', 'node_modules']);
const BLOCKED_EXT = new Set(['.db', '.db-wal', '.db-shm', '.env', '.pyc', '.spec']);

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    return sendErr(res, 400, '路径编码非法', '400');
  }
  if (rel === '/' || rel === '') rel = '/index.html';

  const segments = rel.split('/').filter(Boolean);
  if (segments.some(s => s.startsWith('.'))) return sendErr(res, 403, '拒绝访问隐藏文件', '403');
  if (BLOCKED_SEGMENTS.has(segments[0])) return sendErr(res, 403, '拒绝访问该目录', '403');
  if (BLOCKED_EXT.has(path.extname(rel).toLowerCase())) return sendErr(res, 403, '拒绝访问该类型文件', '403');

  const file = path.resolve(SITE_DIR, '.' + rel);
  if (file !== SITE_DIR && !file.startsWith(SITE_DIR + path.sep)) {
    return sendErr(res, 403, '非法路径', '403');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<meta charset="utf-8"><h1>404</h1><p>找不到这个页面。</p>');
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); return res.end(); }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

// ────────────────────────────────────────────────
//  路由
// ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/health') {
      const counts = {};
      for (const [t, meta] of Object.entries(TABLES)) {
        if (!meta.scoped) continue;
        counts[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
      }
      return sendJson(res, 200, { ok: true, time: nowIso(), tables: counts });
    }

    if (p === '/api/me') {
      const s = sessionOf(req);
      if (!s) return sendErr(res, 401, '未登录', '401');
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(s.uid));
      if (!row) return sendErr(res, 401, '用户不存在', '401');
      return sendJson(res, 200, { user: publicUser(row), token: makeJwt(row) });
    }

    if (p === '/api/export') {
      const s = sessionOf(req);
      if (!s) return sendErr(res, 401, '未登录', '401');
      const dump = { exported_at: nowIso(), user_id: String(s.uid), tables: {} };
      for (const [t, meta] of Object.entries(TABLES)) {
        if (!meta.scoped) continue;
        const rows = db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(String(s.uid));
        dump.tables[t] = rows.map(r => serializeRow(r, meta));
      }
      return sendJson(res, 200, dump);
    }

    if (p === '/api/auth/login') return handleLogin(req, res, url);
    if (p === '/api/auth/callback') return handleCallback(req, res, url);
    if (p === '/api/auth/logout') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'grjl_session=; Path=/; HttpOnly; Max-Age=0',
      });
      return res.end('{"ok":true}');
    }

    if (p.startsWith('/rest/v1/')) {
      const table = p.slice('/rest/v1/'.length).replace(/\/$/, '');
      return handleRest(req, res, table, url.searchParams, sessionOf(req));
    }

    if (p.startsWith('/api/')) return sendErr(res, 404, '接口不存在', '404');
    return serveStatic(req, res, url);
  } catch (err) {
    console.error('[error]', req.method, p, err);
    return sendErr(res, 500, err.message || '服务器内部错误', '500');
  }
});

server.listen(PORT, () => {
  console.log(`✅ GRJL 后端已启动  http://0.0.0.0:${PORT}`);
  console.log(`   站点目录: ${SITE_DIR}`);
  console.log(`   数据目录: ${DATA_DIR}`);
  console.log(`   对外地址: ${PUBLIC_URL || '(未设置 PUBLIC_URL，将按请求 Host 推断)'}`);
  if (!GITHUB_CLIENT_ID) console.log('   ⚠️  未配置 GitHub OAuth，登录不可用');
});
