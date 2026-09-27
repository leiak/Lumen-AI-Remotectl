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
}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/issues') && (!init || init.method === undefined || init.method === 'GET')) {
      if (opts.failList) return new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(opts.issues ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const issueMatch = url.match(/\/api\/issues\/([^/]+)$/);
    if (issueMatch && issueMatch[1] !== undefined) {
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
});