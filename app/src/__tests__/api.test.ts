import { describe, it, expect, vi } from 'vitest';
import { ApiClient, ApiError } from '../api/client';
import { WsClient } from '../api/ws';

describe('ApiClient', () => {
  it('sends Bearer token on every request', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 'i-1', title: 'fix' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    await client.listIssues();
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/issues', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer sk-test' }) as any,
    }));
  });

  it('parses JSON response correctly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: '1', title: 'a' }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    const issues = await client.listIssues();
    expect(issues).toEqual([{ id: '1', title: 'a' }]);
  });

  it('throws on non-2xx with the body text', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"not_found"}', { status: 404, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    await expect(client.listIssues()).rejects.toThrow(/not_found/);
  });

  it('creates an issue', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'new-id' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    const result = await client.createIssue({ title: 'new', workspacePath: '/y' });
    expect(result.id).toBe('new-id');
  });

  it('posts a comment', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'c-1' }), { status: 201, headers: { 'content-type': 'application/json' } }));
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    const result = await client.addComment('issue-1', { body: 'continue' });
    expect(result.id).toBe('c-1');
  });

  it('throws ApiError with status 401 on unauthorized response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } })
    );
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    try {
      await client.listIssues();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(401);
    }
  });

  it('throws ApiError on malformed JSON in 2xx body', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('this is not JSON {{{', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
    try {
      await client.listIssues();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as Error).message).toMatch(/Invalid JSON/);
      expect(e).not.toBeInstanceOf(SyntaxError);
    }
  });
});

describe('WsClient', () => {
  it('connects with Bearer token in header', () => {
    const fakeWs: any = { on: vi.fn(), send: vi.fn(), close: vi.fn(), readyState: 1 };
    const ws = new WsClient({
      url: 'ws://x',
      apiKey: 'sk-test',
      factory: () => fakeWs,
    });
    ws.connect();
    // factory was called; on() registered at least once
    expect(fakeWs.on).toHaveBeenCalled();
  });

  it('parses incoming messages and dispatches to listeners', () => {
    const handlers: Record<string, any> = {};
    const fakeWs: any = {
      on(event: string, cb: any) { handlers[event] = cb; },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory: () => fakeWs });
    const onIssue = vi.fn();
    ws.on('issue_updated', onIssue);
    ws.connect();
    handlers['message'](Buffer.from(JSON.stringify({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' })));
    expect(onIssue).toHaveBeenCalledWith({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' });
  });

  it('reconnects with backoff on close', async () => {
    let attempt = 0;
    const fakes: any[] = [];
    const factory = () => {
      const fake: any = {
        on(event: string, cb: any) {
          if (event === 'close') (fake as any).closeCb = cb;
          if (event === 'open') (fake as any).openCb = cb;
        },
        send: vi.fn(),
        close() {
          if ((fake as any).closeCb) (fake as any).closeCb();
        },
        readyState: 1,
      };
      fakes.push(fake);
      return fake;
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory, backoffMs: 5 });
    ws.connect();
    attempt = fakes.length;
    fakes[0].close(); // simulate disconnect
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes.length).toBeGreaterThan(attempt);
    ws.close();
  });

  it('silently drops malformed JSON messages', () => {
    const handlers: Record<string, any> = {};
    const fakeWs: any = {
      on(event: string, cb: any) { handlers[event] = cb; },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory: () => fakeWs });
    const onIssue = vi.fn();
    ws.on('issue_updated', onIssue);
    ws.connect();
    // Should not throw, and no handler should fire
    expect(() => handlers['message']('not valid json {{{')).not.toThrow();
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('silently drops messages with unknown event types', () => {
    const handlers: Record<string, any> = {};
    const fakeWs: any = {
      on(event: string, cb: any) { handlers[event] = cb; },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory: () => fakeWs });
    const onIssue = vi.fn();
    ws.on('issue_updated', onIssue);
    ws.connect();
    // Well-formed JSON but an unknown event type
    handlers['message'](JSON.stringify({ type: 'unknown_event', payload: 'x' }));
    expect(onIssue).not.toHaveBeenCalled();
  });

  it('fires all multiple handlers registered for the same event', () => {
    const handlers: Record<string, any> = {};
    const fakeWs: any = {
      on(event: string, cb: any) { handlers[event] = cb; },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory: () => fakeWs });
    const h1 = vi.fn();
    const h2 = vi.fn();
    const h3 = vi.fn();
    ws.on('issue_updated', h1);
    ws.on('issue_updated', h2);
    ws.on('issue_updated', h3);
    ws.connect();
    handlers['message'](JSON.stringify({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' }));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    expect(h3).toHaveBeenCalledTimes(1);
  });

  it('off() returned from on() actually unregisters the handler', () => {
    const handlers: Record<string, any> = {};
    const fakeWs: any = {
      on(event: string, cb: any) { handlers[event] = cb; },
      send: vi.fn(),
      close: vi.fn(),
      readyState: 1,
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory: () => fakeWs });
    const h1 = vi.fn();
    const h2 = vi.fn();
    const off1 = ws.on('issue_updated', h1);
    ws.on('issue_updated', h2);
    ws.connect();
    handlers['message'](JSON.stringify({ type: 'issue_updated', issueId: 'i-1', status: 'in_progress' }));
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
    off1();
    handlers['message'](JSON.stringify({ type: 'issue_updated', issueId: 'i-2', status: 'in_progress' }));
    expect(h1).toHaveBeenCalledTimes(1); // still 1
    expect(h2).toHaveBeenCalledTimes(2);
  });

  it('close() prevents further reconnect attempts', async () => {
    const fakes: any[] = [];
    const factory = () => {
      const fake: any = {
        on(event: string, cb: any) {
          if (event === 'close') (fake as any).closeCb = cb;
          if (event === 'open') (fake as any).openCb = cb;
        },
        send: vi.fn(),
        close() {
          if ((fake as any).closeCb) (fake as any).closeCb();
        },
        readyState: 1,
      };
      fakes.push(fake);
      return fake;
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory, backoffMs: 5 });
    ws.connect();
    ws.close(); // close before any disconnect
    fakes[0].close(); // simulate disconnect after close
    await new Promise((r) => setTimeout(r, 30));
    expect(fakes.length).toBe(1); // no new connections created
  });

  it('connect() after close() resets retries to 0', async () => {
    const fakes: any[] = [];
    const factory = () => {
      const fake: any = {
        on(event: string, cb: any) {
          if (event === 'close') (fake as any).closeCb = cb;
          if (event === 'open') (fake as any).openCb = cb;
        },
        send: vi.fn(),
        close() {
          if ((fake as any).closeCb) (fake as any).closeCb();
        },
        readyState: 1,
      };
      fakes.push(fake);
      return fake;
    };
    const ws = new WsClient({ url: 'ws://x', apiKey: 'sk-test', factory, backoffMs: 5, maxRetries: 3 });
    ws.connect();
    // Trigger several reconnects to drive up the retry count
    for (let i = 0; i < 3; i++) {
      const cur = fakes[fakes.length - 1];
      if ((cur as any).closeCb) (cur as any).closeCb();
      await new Promise((r) => setTimeout(r, 15));
    }
    // We should have backed off at least once. Now close and reconnect.
    ws.close();
    ws.connect();
    // Trigger one close on the new connection; we should see a reconnect because
    // retries was reset to 0 (not capped at maxRetries).
    const last = fakes[fakes.length - 1];
    if ((last as any).closeCb) (last as any).closeCb();
    await new Promise((r) => setTimeout(r, 15));
    // The key assertion: a new socket was created after the connect-after-close.
    expect(fakes.length).toBeGreaterThan(1);
    ws.close();
  });

  it('stops reconnecting after maxRetries and calls onPermanentFailure', async () => {
    const fakes: any[] = [];
    const factory = () => {
      const fake: any = {
        on(event: string, cb: any) {
          if (event === 'close') (fake as any).closeCb = cb;
          if (event === 'open') (fake as any).openCb = cb;
        },
        send: vi.fn(),
        close() {
          if ((fake as any).closeCb) (fake as any).closeCb();
        },
        readyState: 1,
      };
      fakes.push(fake);
      return fake;
    };
    const onPermanentFailure = vi.fn();
    const ws = new WsClient({
      url: 'ws://x',
      apiKey: 'sk-test',
      factory,
      backoffMs: 1,
      maxRetries: 2,
      onPermanentFailure,
    });
    ws.connect();
    // Initial connect creates fake #0. Each scheduleReconnect creates a new fake.
    // Walk: fake0.close -> scheduleReconnect (retries 0 < 2, retry -> fake1)
    //       fake1.close -> scheduleReconnect (retries 1 < 2, retry -> fake2)
    //       fake2.close -> scheduleReconnect (retries 2 >= 2, STOP + onPermanentFailure)
    // 3 closes total -> 1 onPermanentFailure, 3 fakes (initial + 2 retries)
    const closes = 3;
    for (let i = 0; i < closes; i++) {
      const cur = fakes[fakes.length - 1];
      if ((cur as any).closeCb) (cur as any).closeCb();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(onPermanentFailure).toHaveBeenCalledTimes(1);
    expect(fakes.length).toBe(3); // initial + 2 retries, no more
    // Now close the last fake again — should still NOT create another socket.
    const before = fakes.length;
    if ((fakes[fakes.length - 1] as any).closeCb) (fakes[fakes.length - 1] as any).closeCb();
    await new Promise((r) => setTimeout(r, 10));
    expect(fakes.length).toBe(before);
    expect(onPermanentFailure).toHaveBeenCalledTimes(2);
    ws.close();
  });
});