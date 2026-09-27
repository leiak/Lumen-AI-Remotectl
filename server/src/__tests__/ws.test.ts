import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { createWsServer } from '../ws/server.js';
import { BroadcastHub } from '../ws/broadcast.js';

const TOKEN = 'sk-test';

describe('WS server', () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    if (cleanup) {
      cleanup();
      cleanup = null;
    }
  });

  it('rejects connection without bearer token', async () => {
    const hub = new BroadcastHub();
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on('error', () => resolve()); // close due to auth fail
      ws.on('open', () => reject(new Error('should not open without auth')));
    });
  });

  it('accepts connection with valid token and receives broadcasts', async () => {
    const hub = new BroadcastHub();
    const { port, close } = await createWsServer({ port: 0, apiKey: TOKEN, hub });
    cleanup = close;

    const received: string[] = [];
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      sock.on('error', (e) => reject(e));
      sock.on('open', () => resolve(sock));
      sock.on('message', (data) => received.push(data.toString()));
    });

    hub.broadcast({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' });
    hub.broadcast({ type: 'run_event', runId: 'r-1', stream: 'stdout', content: 'hello' });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.some((m) => m.includes('issue_updated'))).toBe(true);
    expect(received.some((m) => m.includes('run_event'))).toBe(true);
    ws.close();
  });
});