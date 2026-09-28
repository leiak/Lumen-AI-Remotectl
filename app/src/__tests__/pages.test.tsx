import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { Inbox } from '../pages/Inbox';
import { IssueDetail } from '../pages/IssueDetail';
import type { Issue, Comment } from '../api/types';

function mockApi(opts: {
  issues?: Issue[];
  issue?: Issue;
  comments?: Comment[];
  addComment?: (id: string, body: string) => Promise<Comment>;
  failList?: boolean;
  failIssueStatus?: number;
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/issues') && (!init || init.method === undefined || init.method === 'GET')) {
      if (opts.failList) return new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(opts.issues ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const issueMatch = url.match(/\/api\/issues\/([^/]+)$/);
    if (issueMatch && issueMatch[1] !== undefined) {
      if (opts.failIssueStatus) return new Response('{"error":"server down"}', { status: opts.failIssueStatus, headers: { 'content-type': 'application/json' } });
      const iss = opts.issue;
      if (!iss) return new Response('', { status: 404 });
      return new Response(JSON.stringify(iss), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const cmtsMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
    if (cmtsMatch && cmtsMatch[1] !== undefined) {
      if (init && init.method === 'POST') {
        const body = JSON.parse(init.body as string);
        const c: Comment = { id: 'c-new', issueId: cmtsMatch[1], authorType: 'user', body: body.body, kind: 'message', createdAt: new Date().toISOString() };
        return new Response(JSON.stringify(c), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(opts.comments ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
  return new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
}

describe('Inbox page', () => {
  it('shows loading then issues', async () => {
    const api = mockApi({ issues: [
      { id: 'i-1', title: 'first', status: 'todo', priority: 'high', workspacePath: '/x', createdAt: '', updatedAt: '' },
      { id: 'i-2', title: 'second', status: 'in_progress', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
    ] });
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('shows empty state when no issues', async () => {
    const api = mockApi({ issues: [] });
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No issues yet/i)).toBeInTheDocument());
  });

  it('shows error state on fetch failure', async () => {
    const api = mockApi({ failList: true });
    render(<MemoryRouter><ApiProvider client={api}><Inbox /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Error/i)).toBeInTheDocument());
  });
});

describe('IssueDetail page', () => {
  const sampleIssue: Issue = { id: 'i-1', title: 'do thing', status: 'in_progress', priority: 'medium', workspacePath: '/repo', createdAt: '', updatedAt: '' };
  const sampleComments: Comment[] = [
    { id: 'c-1', issueId: 'i-1', authorType: 'assistant', body: 'hi', kind: 'message', createdAt: '' },
  ];

  it('shows loading then issue + comments', async () => {
    const api = mockApi({ issue: sampleIssue, comments: sampleComments });
    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    expect(screen.getByText('hi')).toBeInTheDocument();
  });

  it('posts a new comment via the form', async () => {
    const api = mockApi({ issue: sampleIssue, comments: sampleComments });
    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    const textarea = screen.getByPlaceholderText(/Write a reply/i);
    fireEvent.change(textarea, { target: { value: 'continue' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(screen.getByText('continue')).toBeInTheDocument());
  });

  it('renders error state with 404 when getIssue 404s', async () => {
    const api = mockApi({ comments: sampleComments });
    render(
      <MemoryRouter initialEntries={['/issues/missing']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Error.*404/i)).toBeInTheDocument());
  });

  it('renders error state with 500 when getIssue 500s', async () => {
    const api = mockApi({ failIssueStatus: 500 });
    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText(/Error.*500/i)).toBeInTheDocument());
  });

  it('renders page with empty comments list and working form', async () => {
    const api = mockApi({ issue: sampleIssue, comments: [] });
    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );
    await waitFor(() => expect(screen.getByText('do thing')).toBeInTheDocument());
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    const textarea = screen.getByPlaceholderText(/Write a reply/i);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: /Send/i }));
    await waitFor(() => expect(screen.getByText('hello')).toBeInTheDocument());
  });

  // Regression: the delete button must keep working across multiple deletes.
  // After the first delete the component reloads comments via the WS handler;
  // if anything in the second render is broken the next delete silently fails.
  it('allows deleting more than one comment in sequence', async () => {
    const userComments: Comment[] = [
      { id: 'c-u1', issueId: 'i-1', authorType: 'user', body: 'first', kind: 'message', createdAt: '' },
      { id: 'c-u2', issueId: 'i-1', authorType: 'user', body: 'second', kind: 'message', createdAt: '' },
      { id: 'c-u3', issueId: 'i-1', authorType: 'user', body: 'third', kind: 'message', createdAt: '' },
    ];

    // Use a mutable in-memory list so subsequent GET /comments reflects any
    // deletions. The mock also tracks DELETE calls so we can assert each one
    // hit the server.
    let live = userComments.slice();
    const deleted: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const issueMatch = url.match(/\/api\/issues\/([^/]+)$/);
      if (issueMatch) {
        return new Response(JSON.stringify(sampleIssue), { status: 200 });
      }
      const deleteMatch = url.match(/\/api\/issues\/([^/]+)\/comments\/([^/]+)$/);
      if (deleteMatch && init?.method === 'DELETE') {
        const cid = deleteMatch[2]!;
        if (!live.some((c) => c.id === cid)) {
          return new Response('{"error":"comment_not_found"}', { status: 404 });
        }
        live = live.filter((c) => c.id !== cid);
        deleted.push(cid);
        return new Response(null, { status: 204 });
      }
      const cmtsMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
      if (cmtsMatch) {
        return new Response(JSON.stringify(live), { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const api = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });

    // No `window.confirm` spy needed — the UI uses an inline two-step
    // confirmation (× → Delete?) instead of a native dialog, both for iOS
    // reliability and so React Testing Library queries can target the
    // Delete? button by role directly.

    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();

    // Two-step delete: each × button is tapped once to arm the row, then
    // the now-visible "Delete?" button is tapped to actually commit.
    const armButtons = () => screen.getAllByRole('button', { name: /Delete comment/i });
    const confirmButtons = () => screen.getAllByRole('button', { name: /^Delete\?$/i });

    expect(armButtons()).toHaveLength(3);

    // First arm — must NOT issue a DELETE yet.
    fireEvent.click(armButtons()[0]!);
    expect(confirmButtons()).toHaveLength(1);
    expect(deleted).toEqual([]);

    // Second tap on "Delete?" commits.
    fireEvent.click(confirmButtons()[0]!);
    await waitFor(() => expect(screen.queryByText('first')).not.toBeInTheDocument());
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('third')).toBeInTheDocument();
    expect(deleted).toEqual(['c-u1']);

    // Delete the second one — this is where the original iOS bug bit.
    expect(armButtons()).toHaveLength(2);
    fireEvent.click(armButtons()[0]!);
    expect(confirmButtons()).toHaveLength(1);
    fireEvent.click(confirmButtons()[0]!);
    await waitFor(() => expect(screen.queryByText('second')).not.toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByText('third')).toBeInTheDocument();
    expect(deleted).toEqual(['c-u1', 'c-u2']);

    // And the third.
    expect(armButtons()).toHaveLength(1);
    fireEvent.click(armButtons()[0]!);
    expect(confirmButtons()).toHaveLength(1);
    fireEvent.click(confirmButtons()[0]!);
    await waitFor(() => expect(screen.queryByText('third')).not.toBeInTheDocument(), { timeout: 2000 });

    // All three DELETEs must have reached the server.
    expect(deleted).toEqual(['c-u1', 'c-u2', 'c-u3']);
  });

  // Cancel button regression: arming must be reversible so a stray tap
  // doesn't lock the row for the rest of the session.
  it('cancels a pending delete via the Cancel button', async () => {
    const userComments: Comment[] = [
      { id: 'c-u1', issueId: 'i-1', authorType: 'user', body: 'first', kind: 'message', createdAt: '' },
    ];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const issueMatch = url.match(/\/api\/issues\/([^/]+)$/);
      if (issueMatch) return new Response(JSON.stringify(sampleIssue), { status: 200 });
      const deleteMatch = url.match(/\/api\/issues\/([^/]+)\/comments\/([^/]+)$/);
      if (deleteMatch && init?.method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      const cmtsMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
      if (cmtsMatch) return new Response(JSON.stringify(userComments), { status: 200 });
      return new Response('', { status: 404 });
    });
    const api = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });

    render(
      <MemoryRouter initialEntries={['/issues/i-1']}>
        <ApiProvider client={api}>
          <Routes>
            <Route path="/issues/:id" element={<IssueDetail />} />
          </Routes>
        </ApiProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByText('first')).toBeInTheDocument());

    // Arm it.
    fireEvent.click(screen.getByRole('button', { name: /Delete comment/i }));
    expect(screen.getByRole('button', { name: /^Delete\?$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Cancel$/i })).toBeInTheDocument();

    // Cancel it.
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/i }));

    await waitFor(() => expect(screen.queryByRole('button', { name: /^Delete\?$/i })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Delete comment/i })).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
  });
});