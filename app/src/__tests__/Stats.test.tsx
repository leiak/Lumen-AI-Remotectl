import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { Stats } from '../pages/Stats';
import type { Issue } from '../api/types';

interface Opts {
  issues?: Issue[];
  failList?: boolean;
}

function mockApi(opts: Opts = {}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/issues')) {
      if (opts.failList) {
        return new Response('{"error":"boom"}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify(opts.issues ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
  return new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
}

beforeEach(() => {
  // Clear any saved stats-related state. Stats doesn't persist anything, but this
  // keeps tests independent of any leftover localStorage entries.
  localStorage.clear();
});

describe('Stats page', () => {
  it('shows loading state before issues arrive', () => {
    const api = mockApi();
    render(<MemoryRouter><ApiProvider client={api}><Stats /></ApiProvider></MemoryRouter>);
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
  });

  it('shows counts grouped by status once issues load', async () => {
    const api = mockApi({
      issues: [
        { id: 'i-1', title: 'a', status: 'todo', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
        { id: 'i-2', title: 'b', status: 'todo', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
        { id: 'i-3', title: 'c', status: 'in_progress', priority: 'medium', workspacePath: '/x', createdAt: '', updatedAt: '' },
        { id: 'i-4', title: 'd', status: 'in_review', priority: 'high', workspacePath: '/x', createdAt: '', updatedAt: '' },
        { id: 'i-5', title: 'e', status: 'done', priority: 'medium', workspacePath: '/x', createdAt: '', updatedAt: '' },
        { id: 'i-6', title: 'f', status: 'cancelled', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
      ],
    });
    render(<MemoryRouter><ApiProvider client={api}><Stats /></ApiProvider></MemoryRouter>);

    // Status labels are present
    await waitFor(() => expect(screen.getByText('Todo')).toBeInTheDocument());
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('In review')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();

    // Scope each count to its tile so the "1"s don't collide.
    const todoTile = document.querySelector('.stats-tile.status-todo') as HTMLElement;
    expect(todoTile.querySelector('.stats-tile-value')?.textContent).toBe('2');
    const inProgressTile = document.querySelector('.stats-tile.status-in_progress') as HTMLElement;
    expect(inProgressTile.querySelector('.stats-tile-value')?.textContent).toBe('1');
    const inReviewTile = document.querySelector('.stats-tile.status-in_review') as HTMLElement;
    expect(inReviewTile.querySelector('.stats-tile-value')?.textContent).toBe('1');
    const doneTile = document.querySelector('.stats-tile.status-done') as HTMLElement;
    expect(doneTile.querySelector('.stats-tile-value')?.textContent).toBe('1');
    const cancelledTile = document.querySelector('.stats-tile.status-cancelled') as HTMLElement;
    expect(cancelledTile.querySelector('.stats-tile-value')?.textContent).toBe('1');

    // Total = 6
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('shows empty state when there are no issues', async () => {
    const api = mockApi({ issues: [] });
    render(<MemoryRouter><ApiProvider client={api}><Stats /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/No issues yet/i)).toBeInTheDocument());
  });

  it('shows error state when listIssues fails', async () => {
    const api = mockApi({ failList: true });
    render(<MemoryRouter><ApiProvider client={api}><Stats /></ApiProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/Error/i)).toBeInTheDocument());
  });

  it('refreshes when the Refresh button is clicked and the new data renders', async () => {
    // First load returns 1 issue; Refresh returns 2. Verifies that the new
    // total actually renders (not just that fetch was called again).
    let calls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/issues')) {
        calls += 1;
        if (calls === 1) {
          return new Response(JSON.stringify([
            { id: 'i-1', title: 't1', status: 'todo', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
          ]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          { id: 'i-a', title: 'tA', status: 'todo', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
          { id: 'i-b', title: 'tB', status: 'done', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('', { status: 404 });
    });
    const api = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });

    render(<MemoryRouter><ApiProvider client={api}><Stats /></ApiProvider></MemoryRouter>);

    // Wait for the first response to render (total = 1).
    await waitFor(() => {
      const totalEl = document.querySelector('.stats-total-value');
      expect(totalEl?.textContent).toBe('1');
    });

    const initialCalls = calls;
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }));

    // The second fetch was issued.
    await waitFor(() => expect(calls).toBeGreaterThan(initialCalls));
    // And the new total (2) actually rendered — verifying the new data
    // reached the DOM (not just that fetch was called).
    await waitFor(() => {
      const totalEl = document.querySelector('.stats-total-value');
      expect(totalEl?.textContent).toBe('2');
    });
  });
});