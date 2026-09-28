import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { createWsServer } from '../ws/server.js';
import { BroadcastHub } from '../ws/broadcast.js';

const TOKEN = 'sk-test';

describe('WS server', () => {
  let cleanup: (() => void) | null = null;
  let dbPath: string;
  let db: ReturnType<typeof createDb>;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `ws-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = createDb(dbPath);
    await migrate(db);
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('rejects connection without bearer token', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('error', () => resolve()); // close due to auth fail
      ws.on('open', () => reject(new Error('should not open without auth')));
    });
  });

  it('rejects connection with invalid token', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: 'Bearer wrong-token' },
      });
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('should not open with wrong token')));
    });
  });

  it('rejects malformed Authorization header (wrong scheme)', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: `Token ${TOKEN}` },
      });
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('should not open with wrong scheme')));
    });
  });

  it('rejects empty token after Bearer', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: 'Bearer ' },
      });
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('should not open with empty token')));
    });
  });

  it('treats lowercase "bearer" as malformed (case-sensitive Bearer required)', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: `bearer ${TOKEN}` },
      });
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('lowercase bearer must be rejected (case-sensitive)')));
    });
  });

  it('accepts token via query string and receives broadcasts (browser fallback)', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;

    // Browser clients cannot set custom HTTP headers, so the apiKey is passed
    // via the query string. No Authorization header is sent.
    const ws = await openAuthorizedQuery(port, TOKEN);

    const received: string[] = [];
    ws.on('message', (data) => received.push(data.toString()));

    hub.broadcast({ type: 'issue_updated', issueId: 'i-q1', status: 'in_progress' });
    hub.broadcast({ type: 'run_event', runId: 'r-q1', issueId: 'i-q1', stream: 'stdout', content: 'hi' });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.length >= 2) resolve();
        else setImmediate(check);
      };
      check();
    });

    expect(received.some((m) => m.includes('issue_updated'))).toBe(true);
    expect(received.some((m) => m.includes('run_event'))).toBe(true);
    ws.close();
  });

  it('rejects connection with invalid token via query string', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=wrong-key`);
      ws.on('error', () => resolve()); // 401 close fires the client error event
      ws.on('open', () => reject(new Error('should not open with wrong query token')));
    });
  });

  it('accepts token via query string when URL has a non-root path', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;

    // Real browser clients request a path (e.g. /ws) plus a query string.
    // Verify the URL parser handles that shape correctly.
    const ws = await openAuthorizedQueryPath(port, '/ws', TOKEN);

    const received: string[] = [];
    ws.on('message', (data) => received.push(data.toString()));

    hub.broadcast({ type: 'run_started', runId: 'r-q2', issueId: 'i-q2' });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.length >= 1) resolve();
        else setImmediate(check);
      };
      check();
    });

    expect(received[0]).toContain('run_started');
    ws.close();
  });

  it('accepts connection with valid token and receives broadcasts (deterministic)', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;

    const ws = await openAuthorized(port, TOKEN);

    const received: string[] = [];
    ws.on('message', (data) => received.push(data.toString()));

    hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' });
    hub.broadcast({ type: 'run_event', runId: 'r-1', issueId: 'i-1', stream: 'stdout', content: 'hello' });

    // Deterministic wait: wait for two messages, no setTimeout needed
    await new Promise<void>((resolve) => {
      const check = () => {
        if (received.length >= 2) resolve();
        else setImmediate(check);
      };
      check();
    });

    expect(received.some((m) => m.includes('issue_updated'))).toBe(true);
    expect(received.some((m) => m.includes('run_event'))).toBe(true);
    ws.close();
  });

  it('delivers same broadcast to multiple subscribers', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;

    const wsA = await openAuthorized(port, TOKEN);
    const wsB = await openAuthorized(port, TOKEN);

    const a: string[] = [];
    const b: string[] = [];
    wsA.on('message', (d) => a.push(d.toString()));
    wsB.on('message', (d) => b.push(d.toString()));

    hub.broadcast({ type: 'run_started', runId: 'r-9', issueId: 'i-9' });

    await new Promise<void>((resolve) => {
      const check = () => {
        if (a.length >= 1 && b.length >= 1) resolve();
        else setImmediate(check);
      };
      check();
    });

    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]).toBe(b[0]);

    wsA.close();
    wsB.close();
  });

  it('close() drains outstanding sockets before resolving', async () => {
    const hub = new BroadcastHub(db);
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = () => {}; // close already invoked explicitly

    const ws = await openAuthorized(port, TOKEN);
    expect(hub.size()).toBe(1);

    // Initiate client close; otherwise wss.close() blocks waiting for the client
    const wsClosed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.close();

    await close();
    await wsClosed;

    // After close() resolves, the server-side socket should be detached and
    // the underlying http listener should be released (http.address() === null
    // is implicit in close() awaiting http.close's callback).
    expect(hub.size()).toBe(0);
  });
});

describe('WS server bind error handling', () => {
  let cleanup: (() => void) | null = null;
  let dbPath: string;
  let db: ReturnType<typeof createDb>;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `ws-bind-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = createDb(dbPath);
    await migrate(db);
  });

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('rejects with EADDRINUSE when port is already bound', async () => {
    // First server binds to a real (non-zero) port
    const hubA = new BroadcastHub(db);
    const a = await createWsServer({ port: 0, apiKey: TOKEN, hub: hubA });
    cleanup = a.close;

    const hubB = new BroadcastHub(db);
    // Second server attempts to bind to the same port
    await expect(
      createWsServer({ port: a.port, apiKey: TOKEN, hub: hubB }),
    ).rejects.toThrow();
  });
});

describe('BroadcastHub replay', () => {
  let dbPath: string;
  let db: ReturnType<typeof createDb>;

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `ws-replay-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    db = createDb(dbPath);
    await migrate(db);
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}
  });

  it('replaySince() returns events with id > since in order', async () => {
    const hub = new BroadcastHub(db);

    await hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'todo' });
    await hub.broadcast({ type: 'issue_updated', issueId: 'i-2', status: 'in_progress' });
    await hub.broadcast({ type: 'run_started', runId: 'r-1', issueId: 'i-1' });

    const after = await hub.replaySince(0);
    expect(after).toHaveLength(3);
    expect(after[0]!.event_id).toBeLessThan(after[1]!.event_id);
    expect(after[1]!.event_id).toBeLessThan(after[2]!.event_id);
    expect(after[0]!.event.type).toBe('issue_updated');
    expect(after[1]!.event).toMatchObject({ type: 'issue_updated', issueId: 'i-2' });
    expect(after[2]!.event.type).toBe('run_started');
  });

  it('replaySince(N) excludes events with id <= N', async () => {
    const hub = new BroadcastHub(db);

    await hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'todo' });
    await hub.broadcast({ type: 'issue_updated', issueId: 'i-2', status: 'in_progress' });
    await hub.broadcast({ type: 'run_started', runId: 'r-1', issueId: 'i-1' });

    const all = await hub.replaySince(0);
    const after2 = await hub.replaySince(all[1]!.event_id);

    expect(after2).toHaveLength(1);
    expect(after2[0]!.event).toMatchObject({ type: 'run_started', runId: 'r-1' });
  });

  it('replaySince(N) with N at the high-water mark returns []', async () => {
    const hub = new BroadcastHub(db);
    await hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'todo' });

    const all = await hub.replaySince(0);
    const after = await hub.replaySince(all[0]!.event_id);
    expect(after).toEqual([]);
  });

  it('live WS upgrade replays missed events via ?since=<id>', async () => {
    const hub = new BroadcastHub(db);
    await hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'todo' });
    await hub.broadcast({ type: 'issue_updated', issueId: 'i-2', status: 'in_progress' });

    const snapshot = await hub.replaySince(0);
    const since = snapshot[0]!.event_id; // we already saw the first event

    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    try {
      // Attach the 'message' listener BEFORE waiting for 'open' — replay
      // messages arrive on the same tick the server processes the upgrade,
      // which can race with the client emitting 'open'. A late listener
      // would drop the first frame.
      const received: string[] = [];
      const ws = await openAuthorizedSince(port, TOKEN, since, (sock) => {
        sock.on('message', (data) => received.push(data.toString()));
      });

      // Only the second event (id > since) should be replayed.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (received.length >= 1) resolve();
          else setImmediate(check);
        };
        check();
      });

      expect(received).toHaveLength(1);
      const parsed = JSON.parse(received[0]!);
      expect(parsed.event_id).toBe(snapshot[1]!.event_id);
      expect(parsed.event).toMatchObject({ type: 'issue_updated', issueId: 'i-2' });
      ws.close();
    } finally {
      await close();
    }
  });
});

/**
 * Helper: opens an authorized WS connection and waits for 'open' or 'error'.
 * Resolves the open socket or throws on auth failure.
 */
function openAuthorized(port: number, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.once('error', (err) => reject(err));
    ws.once('open', () => resolve(ws));
  });
}

/**
 * Helper: opens a WS connection authorized solely via the ?token=<apiKey>
 * query string. Used to validate the browser fallback auth path.
 */
function openAuthorizedQuery(port: number, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    ws.once('error', (err) => reject(err));
    ws.once('open', () => resolve(ws));
  });
}

/**
 * Helper: opens a WS connection authorized via query string with a non-root
 * path. Mimics the URL shape a browser would actually send.
 */
function openAuthorizedQueryPath(port: number, path: string, token: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`,
    );
    ws.once('error', (err) => reject(err));
    ws.once('open', () => resolve(ws));
  });
}

/**
 * Helper: opens a WS connection authorized via query string and passes
 * `?since=<id>` so the server replays missed events after the upgrade.
 *
 * Accepts an `onAttach` callback that runs BEFORE the 'open' wait resolves,
 * so callers can register message listeners in time to catch replay frames
 * that fire on the same tick as the upgrade.
 */
function openAuthorizedSince(
  port: number,
  token: string,
  since: number,
  onAttach: (ws: WebSocket) => void,
): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}&since=${since}`,
    );
    onAttach(ws);
    ws.once('error', (err) => reject(err));
    ws.once('open', () => resolve(ws));
  });
}