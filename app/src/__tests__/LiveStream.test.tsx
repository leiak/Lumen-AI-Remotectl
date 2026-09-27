import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { storage } from '../storage';

// --- Fake WsClient ------------------------------------------------------
// Capture every onMessage handler so tests can drive the pipeline by
// calling `fakeWs.__emit(msg)` directly. We replace the real ws module via
// `vi.mock` at the top of this file (hoisted) so LiveStream imports the fake.
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

// Late import so vi.mock('../ws') is hoisted before LiveStream loads it.
import { LiveStream } from '../pages/LiveStream';

function renderLive(initialPath = '/issues/abc/stream') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/issues/:id/stream" element={<LiveStream />} />
        <Route path="/issues/:id?/stream" element={<LiveStream />} />
        <Route path="/settings" element={<div>Settings Page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LiveStream', () => {
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

  it('shows connecting status initially', () => {
    renderLive();
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('renders the issue id in the heading', () => {
    renderLive('/issues/abc-123/stream');
    expect(screen.getByText(/abc-123/i)).toBeInTheDocument();
  });

  it('shows missing id when no :id param', () => {
    renderLive('/issues/stream');
    expect(screen.getByText(/missing id/i)).toBeInTheDocument();
  });

  it('renders a run_event as a stream event when issueId matches', async () => {
    renderLive('/issues/abc/stream');
    act(() => {
      fakeWs.__emit({
        type: 'run_event',
        runId: 'r-1',
        issueId: 'abc',
        stream: 'stdout',
        content: JSON.stringify({ type: 'assistant_text', content: 'hello' }),
      });
    });
    await waitFor(() => expect(screen.getByText(/hello/)).toBeInTheDocument());
  });

  it('ignores run_event from a different issue', () => {
    renderLive('/issues/abc/stream');
    act(() => {
      fakeWs.__emit({
        type: 'run_event',
        runId: 'r-1',
        issueId: 'different',
        stream: 'stdout',
        content: 'hi-from-other-issue',
      });
    });
    expect(screen.queryByText(/hi-from-other-issue/)).not.toBeInTheDocument();
  });

  it('disconnects WS on unmount', () => {
    const { unmount } = renderLive();
    unmount();
    expect(fakeWs.disconnect).toHaveBeenCalled();
  });

  it('shows not-configured message when storage has no host', () => {
    storage.clear();
    // Re-set only apiKey so getHost() returns null but getApiKey() returns a value.
    storage.setApiKey('sk-test');
    renderLive('/issues/abc/stream');
    expect(screen.getByText(/Settings/i)).toBeInTheDocument();
    expect(fakeWs.connect).not.toHaveBeenCalled();
  });
});