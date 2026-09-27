import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { NewIssue } from '../pages/NewIssue';
import { IssueDetail } from '../pages/IssueDetail';
import { storage } from '../storage';
import type { Issue, Comment } from '../api/types';

interface MockOpts {
  createdIssue?: Issue;
  createdComment?: Comment;
  fetchedIssue?: Issue;
  failCreate?: { status: number; message: string };
}

function mockApi(opts: MockOpts = {}) {
  const defaultIssue: Issue = opts.createdIssue ?? {
    id: 'i-new',
    title: 'do thing',
    status: 'todo',
    priority: 'medium',
    workspacePath: '/repo',
    createdAt: '',
    updatedAt: '',
  };
  const storedIssue: Issue = { ...defaultIssue };
  const storedComment: Comment = opts.createdComment ?? {
    id: 'c-new',
    issueId: defaultIssue.id,
    authorType: 'user',
    body: 'do thing',
    kind: 'message',
    createdAt: '',
  };
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    let body: unknown;
    if (init?.body) {
      body = JSON.parse(init.body as string);
      calls.push({ url, method, body });
    } else {
      calls.push({ url, method, body: undefined });
    }
    if (url.endsWith('/api/issues') && method === 'POST') {
      if (opts.failCreate) {
        return new Response(JSON.stringify({ error: opts.failCreate.message }), {
          status: opts.failCreate.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Reflect the posted input into the stored issue so subsequent GETs return what was created.
      if (body && typeof body === 'object') {
        const b = body as { title?: string; workspacePath?: string; priority?: Issue['priority'] };
        if (b.title) storedIssue.title = b.title;
        if (b.workspacePath) storedIssue.workspacePath = b.workspacePath;
        if (b.priority) storedIssue.priority = b.priority;
      }
      return new Response(JSON.stringify(storedIssue), { status: 201, headers: { 'content-type': 'application/json' } });
    }
    const fetchMatch = url.match(/\/api\/issues\/([^/?]+)$/);
    if (fetchMatch && method === 'GET') {
      const iss = opts.fetchedIssue ?? storedIssue;
      return new Response(JSON.stringify(iss), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const commentMatch = url.match(/\/api\/issues\/([^/]+)\/comments$/);
    if (commentMatch) {
      if (method === 'POST') {
        if (body && typeof body === 'object') {
          const b = body as { body?: string };
          if (b.body) storedComment.body = b.body;
        }
        return new Response(JSON.stringify(storedComment), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
  const client = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
  return { client, calls, fetchMock };
}

function renderNewIssue(client: ApiClient) {
  return render(
    <MemoryRouter initialEntries={['/new']}>
      <ApiProvider client={client}>
        <Routes>
          <Route path="/new" element={<NewIssue />} />
          <Route path="/issues/:id?" element={<IssueDetail />} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>
  );
}

const titleInput = () => screen.getByPlaceholderText(/What needs doing/i);
const workspaceInput = () => screen.getByPlaceholderText(/workspace/i);
const createButton = () => screen.getByRole('button', { name: /Create/i });
const startCheckbox = () => screen.getByRole('checkbox', { name: /Start immediately/i });

beforeEach(() => {
  storage.clear();
});

describe('NewIssue page', () => {
  it('renders the form: title input, workspace input, priority buttons, start-immediately checkbox, and a Create button', () => {
    const { client } = mockApi();
    renderNewIssue(client);
    expect(screen.getByRole('heading', { name: /new issue/i })).toBeInTheDocument();
    expect(titleInput()).toBeInTheDocument();
    expect(workspaceInput()).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'low' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'medium' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'high' })).toBeInTheDocument();
    expect(startCheckbox()).toBeInTheDocument();
    expect(createButton()).toBeInTheDocument();
  });

  it('pre-fills the workspace from storage.getWorkspaceDefault', () => {
    storage.setWorkspaceDefault('/persisted/repo');
    const { client } = mockApi();
    renderNewIssue(client);
    const workspace = workspaceInput() as HTMLInputElement;
    expect(workspace.value).toBe('/persisted/repo');
  });

  it('disables the Create button when title or workspace is empty', () => {
    const { client } = mockApi();
    renderNewIssue(client);
    const title = titleInput();
    const workspace = workspaceInput();
    const create = createButton();
    // both empty
    expect(create).toBeDisabled();
    // title only
    fireEvent.change(title, { target: { value: 'a task' } });
    expect(create).toBeDisabled();
    // both filled
    fireEvent.change(workspace, { target: { value: '/x' } });
    expect(create).not.toBeDisabled();
    // workspace blank again
    fireEvent.change(workspace, { target: { value: '' } });
    expect(create).toBeDisabled();
  });

  it('toggles active priority button', () => {
    const { client } = mockApi();
    renderNewIssue(client);
    const low = screen.getByRole('radio', { name: 'low' });
    const medium = screen.getByRole('radio', { name: 'medium' });
    const high = screen.getByRole('radio', { name: 'high' });
    // default is medium
    expect(medium).toHaveAttribute('aria-checked', 'true');
    expect(low).toHaveAttribute('aria-checked', 'false');
    expect(high).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(low);
    expect(low).toHaveAttribute('aria-checked', 'true');
    expect(medium).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(high);
    expect(high).toHaveAttribute('aria-checked', 'true');
    expect(low).toHaveAttribute('aria-checked', 'false');
  });

  it('creates an issue and navigates to the issue detail page (default startImmediately = true)', async () => {
    const { client, calls } = mockApi();
    renderNewIssue(client);

    fireEvent.change(titleInput(), { target: { value: 'do thing' } });
    fireEvent.change(workspaceInput(), { target: { value: '/repo' } });
    fireEvent.click(createButton());

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'do thing' })).toBeInTheDocument();
    });
    // POST /api/issues
    const createCall = calls.find((c) => c.url === 'http://x/api/issues' && c.method === 'POST');
    expect(createCall).toBeDefined();
    expect(createCall!.body).toEqual({ title: 'do thing', workspacePath: '/repo', priority: 'medium' });
    // startImmediately defaulted to true => addComment was called too
    const commentCall = calls.find((c) => c.url === 'http://x/api/issues/i-new/comments' && c.method === 'POST');
    expect(commentCall).toBeDefined();
    expect(commentCall!.body).toEqual({ body: 'do thing' });
  });

  it('skips addComment when startImmediately is unchecked', async () => {
    const { client, calls } = mockApi();
    renderNewIssue(client);

    fireEvent.change(titleInput(), { target: { value: 'do later' } });
    fireEvent.change(workspaceInput(), { target: { value: '/repo' } });
    fireEvent.click(startCheckbox()); // uncheck
    expect(startCheckbox()).not.toBeChecked();
    fireEvent.click(createButton());

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'do later' })).toBeInTheDocument();
    });
    const commentCalls = calls.filter((c) => c.url === 'http://x/api/issues/i-new/comments' && c.method === 'POST');
    expect(commentCalls).toHaveLength(0);
  });

  it('saves the chosen workspace to storage after a successful create', async () => {
    const { client } = mockApi();
    renderNewIssue(client);
    fireEvent.change(titleInput(), { target: { value: 'task' } });
    fireEvent.change(workspaceInput(), { target: { value: '/next/workspace' } });
    fireEvent.click(createButton());
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'task' })).toBeInTheDocument();
    });
    expect(storage.getWorkspaceDefault()).toBe('/next/workspace');
  });

  it('shows an inline error and keeps the form when createIssue fails', async () => {
    const { client } = mockApi({ failCreate: { status: 500, message: 'server down' } });
    renderNewIssue(client);
    fireEvent.change(titleInput(), { target: { value: 'task' } });
    fireEvent.change(workspaceInput(), { target: { value: '/repo' } });
    fireEvent.click(createButton());
    await waitFor(() => {
      expect(screen.getByText(/Error.*500/i)).toBeInTheDocument();
    });
    // Still on /new (not navigated)
    expect(screen.getByRole('heading', { name: /new issue/i })).toBeInTheDocument();
  });
});
