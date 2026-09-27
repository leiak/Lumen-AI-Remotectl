import { describe, it, expect, afterEach } from 'vitest';
import { createApp } from '../index.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { BroadcastHub } from '../ws/broadcast.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('bootstrap', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('createApp returns express + ws handles bound to 127.0.0.1', async () => {
    const dbPath = path.join(os.tmpdir(), `boot-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const hub = new BroadcastHub();

    const app = await createApp({
      db,
      apiKey: 'sk-test-abc',
      hub,
      httpPort: 0,
      wsPort: 0,
    });

    cleanup = app.shutdown;

    expect(app.httpPort).toBeGreaterThan(0);
    expect(app.wsPort).toBeGreaterThan(0);
    expect(app.httpPort).not.toBe(app.wsPort);

    // cleanup temp db files
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('returns 401 on unauthenticated REST call', async () => {
    const dbPath = path.join(os.tmpdir(), `boot2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const db = createDb(dbPath);
    await migrate(db);
    const hub = new BroadcastHub();

    const app = await createApp({
      db,
      apiKey: 'sk-test-abc',
      hub,
      httpPort: 0,
      wsPort: 0,
    });

    cleanup = app.shutdown;

    const res = await fetch(`http://127.0.0.1:${app.httpPort}/api/issues`);
    expect(res.status).toBe(401);

    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });
});