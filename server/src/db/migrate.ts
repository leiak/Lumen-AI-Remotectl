import type { Db } from './client.js';

export async function migrate(db: Db) {
  await db.run(`CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    priority TEXT NOT NULL DEFAULT 'medium',
    workspace_path TEXT NOT NULL,
    current_session_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'message',
    parent_id TEXT,
    created_at INTEGER NOT NULL
  )`);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id)`);

  await db.run(`CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    cost_cents INTEGER DEFAULT 0,
    tokens_in INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    error TEXT
  )`);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_id)`);

  await db.run(`CREATE TABLE IF NOT EXISTS run_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    stream TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id)`);

  await db.run(`CREATE TABLE IF NOT EXISTS push_devices (
    id TEXT PRIMARY KEY,
    device_token TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    p256dh TEXT,
    auth TEXT,
    last_seen_at INTEGER NOT NULL
  )`);

  // Migration for pre-Web-Push DBs that created push_devices without the
  // web subscription columns. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
  // we detect via pragma and ALTER only when needed.
  const cols = await db.all<{ name: string }>(`PRAGMA table_info(push_devices)`);
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has('p256dh')) {
    await db.run(`ALTER TABLE push_devices ADD COLUMN p256dh TEXT`);
  }
  if (!colNames.has('auth')) {
    await db.run(`ALTER TABLE push_devices ADD COLUMN auth TEXT`);
  }

  await db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER
  )`);

  await db.run(`CREATE TABLE IF NOT EXISTS broadcast_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);

  await db.run(`CREATE INDEX IF NOT EXISTS idx_broadcast_log_id ON broadcast_log(id)`);
}
