import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';

describe('App', () => {
  it('renders the header and inbox by default', () => {
    render(<MemoryRouter><App /></MemoryRouter>);
    expect(screen.getByRole('heading', { name: /RemoteCTL/i })).toBeInTheDocument();
    expect(screen.getByText(/No issues yet/i)).toBeInTheDocument();
  });

  it('navigates to settings when /settings route is matched', () => {
    render(<MemoryRouter initialEntries={['/settings']}><App /></MemoryRouter>);
    expect(screen.getByText(/Not connected/i)).toBeInTheDocument();
  });
});
