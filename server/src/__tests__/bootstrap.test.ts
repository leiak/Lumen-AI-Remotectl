import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../index.js';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { BroadcastHub } from '../ws/broadcast.js';
import WebSocket from 'ws';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

function freshDbPath(label: string): string {
  return path.join(
    os.tmpdir(),
    `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function cleanupDbFiles(dbPath: string) {
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) {
    try {
      fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
}

async function bootApp(apiKey = 'sk-test-abc') {
  const dbPath = freshDbPath('boot');
  const db = createDb(dbPath);
  await migrate(db);
  const hub = new BroadcastHub();
  const app = await createApp({
    db,
    apiKey,
    hub,
    httpPort: 0,
    wsPort: 0,
  });
  return { app, dbPath, db, hub };
}

describe('bootstrap', () => {
  let cleanup: (() => Promise<void>) | null = null;
  let dbPathHolder: string | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
    if (dbPathHolder) {
      cleanupDbFiles(dbPathHolder);
      dbPathHolder = null;
    }
  });

  it('createApp returns express + ws handles bound to 127.0.0.1', async () => {
    const dbPath = freshDbPath('boot');
    dbPathHolder = dbPath;
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
  });

  it('returns 401 on unauthenticated REST call', async () => {
    const dbPath = freshDbPath('boot2');
    dbPathHolder = dbPath;
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
  });

  it('shutdown() resolves cleanly after the app is up', async () => {
    const { app, dbPath } = await bootApp();
    dbPathHolder = dbPath;
    cleanup = null; // we shutdown ourselves and want afterEach to skip

    await expect(app.shutdown()).resolves.toBeUndefined();
  });

  it('createApp shuts down an in-flight WS connection', async () => {
    const { app, dbPath } = await bootApp('sk-ws-drain');
    dbPathHolder = dbPath;
    cleanup = null;

    const ws = new WebSocket(`ws://127.0.0.1:${app.wsPort}`, {
      headers: { Authorization: 'Bearer sk-ws-drain' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);

    const closed = new Promise<void>((resolve) => {
      ws.once('close', () => resolve());
    });

    await app.shutdown();
    // Give the close frame a brief moment to flush.
    await Promise.race([
      closed,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('WS did not close within 1s')), 1000),
      ),
    ]);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('DB file mode after createDb is 0o600 on POSIX', async () => {
    if (process.platform === 'win32') {
      // Skip: Windows uses ACLs, not POSIX mode bits. chmodSync is a no-op.
      return;
    }
    const dbPath = freshDbPath('boot-perms');
    dbPathHolder = dbPath;
    createDb(dbPath);
    const stat = fs.statSync(dbPath);
    // Mask with 0o777 to ignore setuid/setgid/sticky bits we don't care about.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('createApp wires broadcast through hub', async () => {
    const dbPath = freshDbPath('bcast');
    dbPathHolder = dbPath;
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

    // Pretend a WS client attached
    const fakeWs: any = { readyState: 1, send: vi.fn(), on: vi.fn() };
    hub.attach(fakeWs);

    // Create issue + post comment via the HTTP server
    const createRes = await fetch(`http://127.0.0.1:${app.httpPort}/api/issues`, {
      method: 'POST',
      headers: { authorization: `Bearer sk-test-abc`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'i', workspacePath: '/x' }),
    });
    const { id } = await createRes.json();
    const commentRes = await fetch(`http://127.0.0.1:${app.httpPort}/api/issues/${id}/comments`, {
      method: 'POST',
      headers: { authorization: `Bearer sk-test-abc`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'go' }),
    });
    expect(commentRes.status).toBe(201);

    // At least one ws.send was called
    expect(fakeWs.send).toHaveBeenCalled();
    const sent = fakeWs.send.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(sent).toMatch(/issue_updated|run_started/);
  });
});