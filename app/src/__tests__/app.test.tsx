import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { ApiProvider } from '../api/context';
import { ApiClient } from '../api/client';

const stubApi = new ApiClient({ baseUrl: 'http://x', apiKey: 'sk-test', fetch: vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as any });

describe('App', () => {
  it('renders the header and inbox by default', () => {
    render(<MemoryRouter><ApiProvider client={stubApi}><App /></ApiProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /RemoteCTL/i })).toBeInTheDocument();
  });

  it('navigates to settings when /settings route is matched', () => {
    render(<MemoryRouter initialEntries={['/settings']}><ApiProvider client={stubApi}><App /></ApiProvider></MemoryRouter>);
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
  });

  it('renders Not Found for unknown routes', () => {
    render(<MemoryRouter initialEntries={['/unknown-path']}><ApiProvider client={stubApi}><App /></ApiProvider></MemoryRouter>);
    expect(screen.getByText(/Not Found/i)).toBeInTheDocument();
  });

  it('renders Missing id when /issues/ has no id', () => {
    render(<MemoryRouter initialEntries={['/issues/']}><ApiProvider client={stubApi}><App /></ApiProvider></MemoryRouter>);
    expect(screen.getByText(/Missing id/i)).toBeInTheDocument();
  });

  it('renders the New Issue page at /new', () => {
    render(<MemoryRouter initialEntries={['/new']}><ApiProvider client={stubApi}><App /></ApiProvider></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /new issue/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/What needs doing/i)).toBeInTheDocument();
  });
});