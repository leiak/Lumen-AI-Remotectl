import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WsClient } from '../ws';
import { storage } from '../storage';

describe('App WsClient', () => {
  beforeEach(() => {
    storage.clear();
  });

  afterEach(() => {
    storage.clear();
  });

  it('does not connect when host is unset', () => {
    const c = new WsClient();
    expect(c.isConnected()).toBe(false);
  });

  it('connects when host + apiKey are set', async () => {
    storage.setHost('http://127.0.0.1:1'); // unreachable but the URL is constructed
    storage.setApiKey('sk-test');

    // Stub global WebSocket to verify connection attempt.
    const wsInstances: any[] = [];
    const fakeWs: any = {
      onopen: null as any,
      onclose: null as any,
      onerror: null as any,
      onmessage: null as any,
      send: vi.fn(),
      close: vi.fn(),
    };
    const fakeFactory = vi.fn((url: string) => {
      fakeWs.url = url;
      wsInstances.push(fakeWs);
      return fakeWs;
    });
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = function (url: string) { return fakeFactory(url); } as any;

    const c = new WsClient();
    c.connect();
    expect(fakeFactory).toHaveBeenCalled();
    expect(fakeFactory.mock.calls[0][0]).toMatch(/^ws:\/\/127\.0\.0\.1:1\/ws\?token=/);

    (globalThis as any).WebSocket = origWS;
  });

  it('schedules reconnect with exponential backoff', async () => {
    storage.setHost('http://127.0.0.1:1');
    storage.setApiKey('sk-x');

    const fakeWs: any = { onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = function () { return fakeWs; } as any;

    const c = new WsClient({ baseBackoffMs: 50, maxBackoffMs: 1000 });
    c.connect();
    fakeWs.onclose?.();

    // backoff after 1 disconnect should be >= 50ms (and <= maxBackoffMs)
    expect(c.getBackoffMs()).toBeGreaterThanOrEqual(50);
    expect(c.getBackoffMs()).toBeLessThanOrEqual(1000);

    (globalThis as any).WebSocket = origWS;
  });

  it('parses incoming messages and updates lastEventId', () => {
    storage.setHost('http://127.0.0.1:1');
    storage.setApiKey('sk-x');

    let captured: any = null;
    const fakeWs: any = {
      onopen: null, onclose: null, onerror: null, onmessage: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = function () { return fakeWs; } as any;

    const c = new WsClient();
    c.onMessage((m) => { captured = m; });
    c.connect();
    fakeWs.onmessage?.({ data: JSON.stringify({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress', event_id: 42 }) });

    expect(captured).toEqual({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress', event_id: 42 });
    expect(c.getLastEventId()).toBe(42);

    (globalThis as any).WebSocket = origWS;
  });

  it('unwraps the server-side {event_id, event} envelope and advances the cursor', () => {
    storage.setHost('http://127.0.0.1:1');
    storage.setApiKey('sk-x');

    let captured: any = null;
    const fakeWs: any = {
      onopen: null, onclose: null, onerror: null, onmessage: null,
      send: vi.fn(),
      close: vi.fn(),
    };
    const origWS = (globalThis as any).WebSocket;
    (globalThis as any).WebSocket = function () { return fakeWs; } as any;

    const c = new WsClient();
    c.onMessage((m) => { captured = m; });
    c.connect();
    // Match the wire shape broadcast.ts sends: { event_id, event: {...} }.
    fakeWs.onmessage?.({
      data: JSON.stringify({
        event_id: 541,
        event: { type: 'run_event', runId: 'r-1', issueId: 'i-1', content: 'hi' },
      }),
    });

    // The handler must receive the inner BroadcastEvent — not the envelope.
    // `event_id` is consumed for the replay cursor but must NOT leak into
    // the handler payload.
    expect(captured).toEqual({ type: 'run_event', runId: 'r-1', issueId: 'i-1', content: 'hi' });
    expect(c.getLastEventId()).toBe(541);

    (globalThis as any).WebSocket = origWS;
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reconnect actually fires: a new WebSocket is constructed after onclose + backoff', async () => {
      storage.setHost('http://127.0.0.1:1');
      storage.setApiKey('sk-x');

      const wsInstances: any[] = [];
      const fakeFactory = vi.fn((url: string) => {
        const ws: any = {
          onopen: null, onclose: null, onerror: null, onmessage: null,
          send: vi.fn(), close: vi.fn(),
          url,
        };
        wsInstances.push(ws);
        return ws;
      });
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function (url: string) { return fakeFactory(url); } as any;

      const c = new WsClient({ baseBackoffMs: 1000, maxBackoffMs: 30_000 });
      c.connect();
      expect(wsInstances).toHaveLength(1);

      // Trigger onclose on the first socket -> should schedule reconnect.
      wsInstances[0].onclose?.();

      // Advance past baseBackoffMs (1000ms) so the timer fires.
      await vi.advanceTimersByTimeAsync(1500);

      // A second WebSocket should have been constructed.
      expect(wsInstances.length).toBeGreaterThanOrEqual(2);

      (globalThis as any).WebSocket = origWS;
    });

    it('multiple handlers all fire on a single message', () => {
      storage.setHost('http://127.0.0.1:1');
      storage.setApiKey('sk-x');

      const fakeWs: any = { onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function () { return fakeWs; } as any;

      const c = new WsClient();
      const h1 = vi.fn();
      const h2 = vi.fn();
      c.onMessage(h1);
      c.onMessage(h2);
      c.connect();
      fakeWs.onmessage?.({ data: JSON.stringify({ type: 'ping', event_id: 1 }) });

      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);

      (globalThis as any).WebSocket = origWS;
    });

    it('lastEventId is monotonic (max) and persists across connection cycles', () => {
      storage.setHost('http://127.0.0.1:1');
      storage.setApiKey('sk-x');

      const fakeWs: any = { onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function () { return fakeWs; } as any;

      const c = new WsClient();
      c.connect();

      // First event id 10, then a stale id 5 — monotonic max should keep 10.
      fakeWs.onmessage?.({ data: JSON.stringify({ type: 'a', event_id: 10 }) });
      expect(c.getLastEventId()).toBe(10);
      fakeWs.onmessage?.({ data: JSON.stringify({ type: 'b', event_id: 5 }) });
      expect(c.getLastEventId()).toBe(10);

      // Disconnect + reconnect + a new event id 20 should still build on prior 10.
      c.disconnect();
      c.connect();
      fakeWs.onmessage?.({ data: JSON.stringify({ type: 'c', event_id: 20 }) });
      expect(c.getLastEventId()).toBe(20);
      // Confirm it is actually persisted in storage, not just in-memory.
      expect(storage.getLastEventId()).toBe(20);

      (globalThis as any).WebSocket = origWS;
    });

    it('handler unsubscribe removes the handler so it no longer fires', () => {
      storage.setHost('http://127.0.0.1:1');
      storage.setApiKey('sk-x');

      const fakeWs: any = { onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function () { return fakeWs; } as any;

      const c = new WsClient();
      const h = vi.fn();
      const unsub = c.onMessage(h);
      unsub();
      c.connect();
      fakeWs.onmessage?.({ data: JSON.stringify({ type: 'x', event_id: 1 }) });

      expect(h).not.toHaveBeenCalled();

      (globalThis as any).WebSocket = origWS;
    });

    it('disconnect() suppresses reconnect: no new WebSocket constructed on phantom onclose', async () => {
      storage.setHost('http://127.0.0.1:1');
      storage.setApiKey('sk-x');

      const wsInstances: any[] = [];
      const fakeFactory = vi.fn((url: string) => {
        const ws: any = {
          onopen: null, onclose: null, onerror: null, onmessage: null,
          send: vi.fn(), close: vi.fn(),
          url,
        };
        wsInstances.push(ws);
        return ws;
      });
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function (url: string) { return fakeFactory(url); } as any;

      const c = new WsClient({ baseBackoffMs: 1000, maxBackoffMs: 30_000 });
      c.connect();
      expect(wsInstances).toHaveLength(1);

      // User-initiated disconnect: stopped = true, timer cleared.
      c.disconnect();

      // Phantom onclose fires (e.g. from the network layer) after disconnect.
      wsInstances[0].onclose?.();

      // Advance well past any backoff window.
      await vi.advanceTimersByTimeAsync(10_000);

      // No second WebSocket should have been constructed.
      expect(wsInstances).toHaveLength(1);

      (globalThis as any).WebSocket = origWS;
    });

    it('host change takes effect on next connect (after onclose reconnect)', async () => {
      storage.setHost('http://host-a:1');
      storage.setApiKey('sk-x');

      const wsInstances: any[] = [];
      const fakeFactory = vi.fn((url: string) => {
        const ws: any = {
          onopen: null, onclose: null, onerror: null, onmessage: null,
          send: vi.fn(), close: vi.fn(),
          url,
        };
        wsInstances.push(ws);
        return ws;
      });
      const origWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = function (url: string) { return fakeFactory(url); } as any;

      const c = new WsClient({ baseBackoffMs: 1000, maxBackoffMs: 30_000 });
      c.connect();
      expect(wsInstances[0].url).toMatch(/^ws:\/\/host-a:1\//);

      // User switches host and triggers a reconnect.
      storage.setHost('http://host-b:2');
      wsInstances[0].onclose?.();
      await vi.advanceTimersByTimeAsync(1500);

      // The new WebSocket must use host-b.
      expect(wsInstances.length).toBeGreaterThanOrEqual(2);
      expect(wsInstances[wsInstances.length - 1].url).toMatch(/^ws:\/\/host-b:2\//);

      (globalThis as any).WebSocket = origWS;
    });
  });
});
