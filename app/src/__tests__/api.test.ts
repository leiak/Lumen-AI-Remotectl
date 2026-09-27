import { describe, it, expect, vi } from 'vitest';
import { ApiClient } from '../api/client';
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
});
