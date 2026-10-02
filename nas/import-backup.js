#!/usr/bin/env node
/**
 * 把从 Supabase 导出的备份灌进本地 SQLite
 *
 * 用法：
 *   node import-backup.js grjl-supabase-backup.json
 *   node import-backup.js backup.json --data-dir ./data --user-id 1
 *   node import-backup.js backup.json --dry-run      # 只看会导入什么，不写库
 *
 * 说明：
 *   - 旧的 Supabase user_id 是 UUID，导入时会统一改写成本地用户 id
 *   - 可重复执行：按主键/唯一约束覆盖，不会产生重复数据
 */

'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, TABLES } from './schema.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const flag = name => {
  const i = args.indexOf('--' + name);
  return i > -1 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null;
};

if (!file) {
  console.error('用法: node import-backup.js <备份文件.json> [--data-dir ./data] [--user-id 1] [--dry-run]');
  process.exit(1);
}

const dataDir = flag('data-dir') || process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const dryRun = !!flag('dry-run');
const dbFile = path.join(dataDir, 'grjl.db');

if (!fs.existsSync(file)) { console.error('❌ 找不到备份文件：' + file); process.exit(1); }
if (!fs.existsSync(dbFile)) {
  console.error('❌ 找不到数据库：' + dbFile);
  console.error('   请先用 docker compose up -d 启动服务（服务会自动建表），或先运行一次 server.js。');
  process.exit(1);
}

const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
const tables = backup.tables || backup;

const db = new DatabaseSync(dbFile);
db.exec(SCHEMA_SQL);

// 确定目标用户
const users = db.prepare('SELECT id, login FROM users ORDER BY id').all();
let targetUser = flag('user-id');
if (targetUser) {
  const found = users.find(u => String(u.id) === String(targetUser));
  if (!found) { console.error(`❌ 本地没有 id=${targetUser} 的用户，现有：` + users.map(u => `${u.id}(${u.login})`).join(', ')); process.exit(1); }
} else {
  if (users.length === 0) {
    console.error('❌ 本地还没有用户。请先在网站上用 GitHub 登录一次，再运行本脚本。');
    process.exit(1);
  }
  if (users.length > 1) {
    console.error('❌ 本地有多个用户，请用 --user-id 指定：' + users.map(u => `${u.id}(${u.login})`).join(', '));
    process.exit(1);
  }
  targetUser = users[0].id;
}
const target = users.find(u => String(u.id) === String(targetUser));
console.log(`📦 备份文件：${file}`);
console.log(`🗄  数据库：  ${dbFile}`);
console.log(`👤 导入到：  用户 id=${target.id} (${target.login})${dryRun ? '   [演练模式，不写库]' : ''}\n`);

const before = {};
for (const t of Object.keys(TABLES)) {
  if (!TABLES[t].scoped) continue;
  before[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
}

let totalIn = 0;
const report = [];

for (const [table, meta] of Object.entries(TABLES)) {
  if (!meta.scoped) continue;
  const rows = Array.isArray(tables[table]) ? tables[table] : [];
  let inserted = 0, skipped = 0;

  for (const raw of rows) {
    const row = {};
    for (const c of meta.cols) {
      if (!(c in raw)) continue;
      let v = raw[c];
      if (c === 'user_id') v = String(target.id);                    // 改写归属
      else if (meta.jsons.includes(c) && v != null && typeof v !== 'string') v = JSON.stringify(v);
      else if (meta.bools.includes(c)) v = v ? 1 : 0;
      row[c] = v;
    }
    if (!row[meta.pk]) { skipped++; continue; }                       // 缺主键的行丢掉
    const keys = Object.keys(row);
    if (!dryRun) {
      const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      try { db.prepare(sql).run(...keys.map(k => row[k])); }
      catch (e) { skipped++; continue; }
    }
    inserted++;
  }
  totalIn += inserted;
  report.push({ table, inFile: rows.length, inserted, skipped });
}

console.log('表名'.padEnd(18) + '备份中'.padEnd(10) + '导入'.padEnd(10) + '跳过');
console.log('─'.repeat(50));
for (const r of report) {
  console.log(r.table.padEnd(16) + String(r.inFile).padEnd(10) + String(r.inserted).padEnd(10) + String(r.skipped));
}

if (!dryRun) {
  console.log('\n导入后本地条数：');
  for (const [t] of Object.entries(TABLES)) {
    if (!TABLES[t].scoped) continue;
    const after = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c;
    const delta = after - before[t];
    console.log(`  ${t.padEnd(18)} ${before[t]} → ${after}  (${delta >= 0 ? '+' : ''}${delta})`);
  }
}
console.log(`\n✅ 共处理 ${totalIn} 行${dryRun ? '（演练，未写入）' : ''}`);
console.log('   提示：浏览器打开网站核对数据；备份可用 GET /api/export 或直接复制 grjl.db');
