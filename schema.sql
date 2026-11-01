CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  name TEXT, username TEXT,
  role TEXT NOT NULL DEFAULT 'admin',      -- owner | admin | video
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | blocked
  created INTEGER, last_seen INTEGER,
  cash_edit INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, data TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, date TEXT, data TEXT, updated INTEGER, deleted INTEGER DEFAULT 0, by_user INTEGER, notified INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS bookings_upd ON bookings(updated);
CREATE TABLE IF NOT EXISTS reports (date TEXT PRIMARY KEY, data TEXT, updated INTEGER, deleted INTEGER DEFAULT 0, by_user INTEGER);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, data TEXT, deadline INTEGER, done INTEGER DEFAULT 0, n24 INTEGER DEFAULT 0, nover INTEGER DEFAULT 0, updated INTEGER, deleted INTEGER DEFAULT 0, by_user INTEGER);
CREATE INDEX IF NOT EXISTS videos_upd ON videos(updated);
