import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';
import { Settings } from '../pages/Settings';
import { storage } from '../storage';
import type { Issue } from '../api/types';

// We use a real ApiClient so Settings exercises its actual constructor (verifies
// that the saved host + api key get read on next mount). We only stub listIssues
// so we can drive success / failure deterministically.
const listIssuesSpy: (() => Promise<Issue[]>) & ReturnType<typeof vi.fn> = vi.fn();

function buildApi() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/api/issues')) {
      const issues = await listIssuesSpy();
      return new Response(JSON.stringify(issues), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  });
  return new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: fetchMock as any });
}

beforeEach(() => {
  storage.clear();
  listIssuesSpy.mockReset();
  // Default: a successful empty list — keeps "Test connection" paths deterministic.
  listIssuesSpy.mockResolvedValue([]);
});

describe('Settings page', () => {
  it('renders with empty inputs when storage is empty', () => {
    const api = buildApi();
    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /Settings/i })).toBeInTheDocument();
    const host = screen.getByPlaceholderText(/http:\/\/100/i) as HTMLInputElement;
    const key = screen.getByPlaceholderText(/sk-/i) as HTMLInputElement;
    expect(host.value).toBe('');
    expect(key.value).toBe('');
  });

  it('pre-fills inputs from storage on mount', () => {
    storage.setHost('http://example:3100');
    storage.setApiKey('sk-abc');
    const api = buildApi();
    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    const host = screen.getByPlaceholderText(/http:\/\/100/i) as HTMLInputElement;
    const key = screen.getByPlaceholderText(/sk-/i) as HTMLInputElement;
    expect(host.value).toBe('http://example:3100');
    expect(key.value).toBe('sk-abc');
  });

  it('saves host and api key to storage when Save is clicked and shows a confirmation', async () => {
    const api = buildApi();
    const spySetHost = vi.spyOn(storage, 'setHost');
    const spySetApiKey = vi.spyOn(storage, 'setApiKey');

    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    const host = screen.getByPlaceholderText(/http:\/\/100/i) as HTMLInputElement;
    const key = screen.getByPlaceholderText(/sk-/i) as HTMLInputElement;

    fireEvent.change(host, { target: { value: 'http://10.0.0.1:3100' } });
    fireEvent.change(key, { target: { value: 'sk-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    expect(spySetHost).toHaveBeenCalledWith('http://10.0.0.1:3100');
    expect(spySetApiKey).toHaveBeenCalledWith('sk-secret');
    expect(screen.getByText(/Saved/)).toBeInTheDocument();
  });

  it('disables Test connection until both fields have values', () => {
    const api = buildApi();
    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    const testBtn = screen.getByRole('button', { name: /Test connection/i }) as HTMLButtonElement;
    expect(testBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/http:\/\/100/i), { target: { value: 'http://x' } });
    // Only host filled — still disabled
    expect(testBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText(/sk-/i), { target: { value: 'sk' } });
    expect(testBtn).not.toBeDisabled();
  });

  it('runs listIssues when Test connection is clicked and reports the result', async () => {
    const api = buildApi();
    listIssuesSpy.mockResolvedValue([
      { id: 'i-1', title: 'a', status: 'todo', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
      { id: 'i-2', title: 'b', status: 'done', priority: 'low', workspacePath: '/x', createdAt: '', updatedAt: '' },
    ]);

    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/100/i), { target: { value: 'http://x' } });
    fireEvent.change(screen.getByPlaceholderText(/sk-/i), { target: { value: 'sk' } });

    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => expect(screen.getByText(/Connected — 2 issues/)).toBeInTheDocument());
  });

  it('shows an error when Test connection fails', async () => {
    const api = buildApi();
    listIssuesSpy.mockRejectedValueOnce(new Error('network down'));

    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/100/i), { target: { value: 'http://x' } });
    fireEvent.change(screen.getByPlaceholderText(/sk-/i), { target: { value: 'sk' } });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => expect(screen.getByText(/Error/i)).toBeInTheDocument());
  });

  it('persists values to storage immediately (not just on Save) when Test connection is clicked', async () => {
    const api = buildApi();
    const spySetHost = vi.spyOn(storage, 'setHost');
    const spySetApiKey = vi.spyOn(storage, 'setApiKey');

    render(<MemoryRouter><ApiProvider client={api}><Settings /></ApiProvider></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/http:\/\/100/i), { target: { value: 'http://now:1' } });
    fireEvent.change(screen.getByPlaceholderText(/sk-/i), { target: { value: 'sk-now' } });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => {
      expect(spySetHost).toHaveBeenCalledWith('http://now:1');
      expect(spySetApiKey).toHaveBeenCalledWith('sk-now');
    });
  });
});