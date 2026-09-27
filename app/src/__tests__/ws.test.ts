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
    const cb = vi.fn();
    c.onMessage((m) => { captured = m; });
    c.connect();
    fakeWs.onmessage?.({ data: JSON.stringify({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress', event_id: 42 }) });

    expect(captured).toEqual({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress', event_id: 42 });
    expect(c.getLastEventId()).toBe(42);

    (globalThis as any).WebSocket = origWS;
  });
});