/**
 * 数据库结构定义（被 server.js 与 import-backup.js 共用，避免两处漂移）
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id   TEXT UNIQUE,
  login       TEXT,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  emoji       TEXT DEFAULT '💵',
  name        TEXT,
  category    TEXT,
  amount      REAL DEFAULT 0,
  note        TEXT,
  recorded_at TEXT,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id, category);

CREATE TABLE IF NOT EXISTS asset_snapshots (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  total       REAL DEFAULT 0,
  breakdown   TEXT,
  created_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON asset_snapshots(user_id, created_at);

CREATE TABLE IF NOT EXISTS diary_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  date        TEXT NOT NULL,
  title       TEXT,
  body        TEXT,
  saved_at    TEXT,
  created_at  TEXT,
  UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_diary_user ON diary_entries(user_id, date);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  name          TEXT,
  platform      TEXT,
  icon          TEXT,
  color         TEXT,
  price         REAL DEFAULT 0,
  billing_cycle TEXT,
  start_date    TEXT,
  expire_date   TEXT,
  status        TEXT DEFAULT 'active',
  notes         TEXT,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, created_at);

CREATE TABLE IF NOT EXISTS articles (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  url         TEXT NOT NULL,
  title       TEXT,
  account     TEXT,
  summary     TEXT,
  tags        TEXT,
  is_read     INTEGER DEFAULT 0,
  is_starred  INTEGER DEFAULT 0,
  saved_at    TEXT,
  created_at  TEXT,
  UNIQUE(user_id, url)
);
CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id, saved_at);
`;

// 表结构白名单：列名、布尔列、JSON 列、是否按用户隔离
export const TABLES = {
  users: {
    cols: ['id', 'github_id', 'login', 'name', 'avatar_url', 'created_at'],
    bools: [], jsons: [], scoped: false, pk: 'id',
  },
  assets: {
    cols: ['id', 'user_id', 'emoji', 'name', 'category', 'amount', 'note', 'recorded_at', 'created_at', 'updated_at'],
    bools: [], jsons: [], scoped: true, pk: 'id',
  },
  asset_snapshots: {
    cols: ['id', 'user_id', 'total', 'breakdown', 'created_at'],
    bools: [], jsons: ['breakdown'], scoped: true, pk: 'id',
  },
  diary_entries: {
    cols: ['id', 'user_id', 'date', 'title', 'body', 'saved_at', 'created_at'],
    bools: [], jsons: [], scoped: true, pk: 'id', unique: [['user_id', 'date']],
  },
  subscriptions: {
    cols: ['id', 'user_id', 'name', 'platform', 'icon', 'color', 'price', 'billing_cycle',
           'start_date', 'expire_date', 'status', 'notes', 'created_at', 'updated_at'],
    bools: [], jsons: [], scoped: true, pk: 'id',
  },
  articles: {
    cols: ['id', 'user_id', 'url', 'title', 'account', 'summary', 'tags',
           'is_read', 'is_starred', 'saved_at', 'created_at'],
    bools: ['is_read', 'is_starred'], jsons: [], scoped: true, pk: 'id',
    unique: [['user_id', 'url']],
  },
};
