import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { IssueDetail } from '../pages/IssueDetail';
import { storage } from '../storage';
import type { Issue, Comment } from '../api/types';

// --- Fake WsClient ------------------------------------------------------
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
  __handlers: () => handlers,
};

vi.mock('../ws', () => ({
  WsClient: vi.fn().mockImplementation(() => fakeWs),
}));

const sampleIssue: Issue = { id: 'i-1', title: 'do thing', status: 'in_progress', priority: 'medium', workspacePath: '/repo', createdAt: '', updatedAt: '' };
const sampleComments: Comment[] = [
  { id: 'c-1', issueId: 'i-1', authorType: 'assistant', body: 'hi', kind: 'message', createdAt: '' },
];

interface FetchOpts {
  issue?: Issue;
  comments?: Comment[];
  failIssue?: boolean;
}

function detailFetchMock(opts: FetchOpts = {}) {
  return vi.fn(async (url: string) => {
    const issueMatch = url.match(/\/api\/issues\/([^/]+)$/);
    if (issueMatch) {
      if (opts.failIssue) return new Response('{"error":"boom"}', { status: 500 });
      const iss = opts.issue;
      if (!iss) return new Response('', { status: 404 });
      return new Response(JSON.stringify(iss), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const cmtsMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
    if (cmtsMatch) {
      return new Response(JSON.stringify(opts.comments ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
}

function renderDetail(initialPath = '/issues/i-1') {
  const fetchMock = detailFetchMock({ issue: sampleIssue, comments: sampleComments });
  const api = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
  const result = render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ApiProvider client={api}>
        <Routes>
          <Route path="/issues/:id" element={<IssueDetail />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>
  );
  return { ...result, fetchMock };
}

describe('IssueDetail WS subscription', () => {
  beforeEach(() => {
    fakeWs.__reset();
    fakeWs.connect.mockClear();
    fakeWs.disconnect.mockClear();
    storage.clear();
    storage.setHost('http://127.0.0.1:1');
    storage.setApiKey('sk-test');
  });

  afterEach(() => {
    storage.clear();
  });

  it('connects WS on mount when host + apiKey are set', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    expect(fakeWs.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnects WS on unmount', async () => {
    const { unmount } = renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    unmount();
    expect(fakeWs.disconnect).toHaveBeenCalledTimes(1);
    // Handler should be unsubscribed: the effect's cancelled flag flips and
    // `unsub()` removes the handler from the (module-level) registration list.
    expect(fakeWs.__handlers()).toEqual([]);
  });

  it('does not connect WS when host is missing', () => {
    storage.clear();
    storage.setApiKey('sk-test');
    renderDetail();
    expect(fakeWs.connect).not.toHaveBeenCalled();
  });

  it('does not connect WS when apiKey is missing', () => {
    storage.clear();
    storage.setHost('http://127.0.0.1:1');
    renderDetail();
    expect(fakeWs.connect).not.toHaveBeenCalled();
  });

  it('reloads when an approval_requested event arrives for this issue', async () => {
    const { fetchMock } = renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      fakeWs.__emit({ type: 'approval_requested', issueId: 'i-1', commentId: 'c-2', event_id: 1 });
    });

    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('reloads on run_started / run_finished / issue_updated / approval_responded for this issue', async () => {
    const { fetchMock } = renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());

    const events = [
      { type: 'run_started', runId: 'r-1', issueId: 'i-1', event_id: 1 },
      { type: 'run_finished', runId: 'r-1', issueId: 'i-1', status: 'done' as const, event_id: 3 },
      { type: 'issue_updated', issueId: 'i-1', status: 'done' as const, event_id: 4 },
      { type: 'approval_responded', issueId: 'i-1', value: 'ok', event_id: 5 },
    ];
    for (const ev of events) {
      const before = fetchMock.mock.calls.length;
      act(() => { fakeWs.__emit(ev); });
      await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(before), { timeout: 1000 });
    }
  });

  it('does not reload on run_event even for the same issue (stream-level noise)', async () => {
    const { fetchMock } = renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      fakeWs.__emit({ type: 'run_event', runId: 'r-1', issueId: 'i-1', stream: 'stdout', content: 'x', event_id: 1 });
    });

    // Give any spurious reload a chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('ignores events addressed to a different issueId', async () => {
    const { fetchMock } = renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      fakeWs.__emit({ type: 'run_started', runId: 'r-2', issueId: 'i-other', event_id: 1 });
    });
    act(() => {
      fakeWs.__emit({ type: 'approval_requested', issueId: 'i-other', commentId: 'c-9', event_id: 2 });
    });
    act(() => {
      fakeWs.__emit({ type: 'approval_responded', issueId: 'i-other', value: 'no', event_id: 3 });
    });
    act(() => {
      fakeWs.__emit({ type: 'run_event', runId: 'r-2', issueId: 'i-other', stream: 'stdout', content: 'noise', event_id: 4 });
    });

    // Give any spurious reload a chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('ignores malformed messages without crashing', async () => {
    renderDetail();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());

    expect(() => {
      act(() => { fakeWs.__emit(null); });
      act(() => { fakeWs.__emit('not-an-object'); });
      act(() => { fakeWs.__emit({}); });
      act(() => { fakeWs.__emit({ type: 'unknown_type' }); });
    }).not.toThrow();
  });
});