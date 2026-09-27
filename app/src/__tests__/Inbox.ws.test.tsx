import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { Inbox } from '../pages/Inbox';
import { storage } from '../storage';

// --- Fake WsClient ------------------------------------------------------
// Same pattern as LiveStream.test.tsx: capture every onMessage handler so
// tests can drive the pipeline via `fakeWs.__emit(msg)`. We replace the
// real ws module via `vi.mock` at the top of this file (hoisted).
const handlers: Array<(msg: any) => void> = [];
const fakeWs = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  onMessage: (h: (msg: any) => void) => {
    handlers.push(h);
    return () => {
      const idx = handlers.indexOf(h);
      if (idx >= 0) handlers.splice(idx, 1);
    };
  },
  __emit: (m: any) => handlers.slice().forEach((h) => h(m)),
  __reset: () => { handlers.length = 0; },
};

vi.mock('../ws', () => ({
  WsClient: vi.fn().mockImplementation(() => fakeWs),
}));

// Helper: build an ApiClient whose fetch mock only handles /api/issues.
function issuesApi(fetchMock: ReturnType<typeof vi.fn>) {
  return new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
}

function issuesFetchMock(issues: any[] = []) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/issues')) {
      return new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
}

describe('Inbox WS subscription', () => {
  beforeEach(() => {
    fakeWs.__reset();
    fakeWs.connect.mockClear();
    fakeWs.disconnect.mockClear();
    storage.clear();
    // Default: configured. Individual tests can override.
    storage.setHost('http://127.0.0.1:1');
    storage.setApiKey('sk-test');
  });

  afterEach(() => {
    storage.clear();
  });

  it('connects WS on mount when host + apiKey are set', () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    expect(fakeWs.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects WS on unmount', () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    const { unmount } = render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    unmount();
    expect(fakeWs.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not connect WS when host is missing', () => {
    storage.clear();
    storage.setApiKey('sk-test');
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    expect(fakeWs.connect).not.toHaveBeenCalled();
  });

  it('does not connect WS when apiKey is missing', () => {
    storage.clear();
    storage.setHost('http://127.0.0.1:1');
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    expect(fakeWs.connect).not.toHaveBeenCalled();
  });

  it('reloads the issues list when an issue_updated event arrives', async () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    // Wait for the initial fetch.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      fakeWs.__emit({ type: 'issue_updated', issueId: 'i-1', status: 'done', event_id: 1 });
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('reloads on run_started / run_finished / approval_requested', async () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    for (const t of ['run_started', 'run_finished', 'approval_requested']) {
      const before = fetchMock.mock.calls.length;
      act(() => {
        fakeWs.__emit({ type: t, issueId: 'i-1', event_id: 1 });
      });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before), { timeout: 1000 });
    }
  });

  it('does not reload on unrelated event types (run_event, approval_responded)', async () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      fakeWs.__emit({ type: 'run_event', runId: 'r-1', issueId: 'i-1', stream: 'stdout', content: 'hi', event_id: 1 });
    });
    act(() => {
      fakeWs.__emit({ type: 'approval_responded', issueId: 'i-1', value: 'ok', event_id: 2 });
    });

    // Give any spurious reload a chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('ignores malformed messages without crashing', async () => {
    const fetchMock = issuesFetchMock();
    const api = issuesApi(fetchMock);
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // None of these should throw or cause a reload.
    expect(() => {
      act(() => { fakeWs.__emit(null); });
      act(() => { fakeWs.__emit('not-an-object'); });
      act(() => { fakeWs.__emit({}); }); // no `type`
      act(() => { fakeWs.__emit({ type: 'unknown_type' }); });
    }).not.toThrow();

    await new Promise((r) => setTimeout(r, 20));
  });
});