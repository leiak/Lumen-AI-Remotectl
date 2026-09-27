import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LiveStream } from '../pages/LiveStream';

describe('LiveStream', () => {
  it('shows connecting status initially', () => {
    render(
      <MemoryRouter initialEntries={['/issues/abc/stream']}>
        <Routes>
          <Route path="/issues/:id/stream" element={<LiveStream />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it('renders the issue id in the heading', () => {
    render(
      <MemoryRouter initialEntries={['/issues/abc-123/stream']}>
        <Routes>
          <Route path="/issues/:id/stream" element={<LiveStream />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/abc-123/i)).toBeInTheDocument();
  });

  it('shows missing id when no :id param', () => {
    render(
      <MemoryRouter initialEntries={['/issues/stream']}>
        <Routes>
          <Route path="/issues/:id?/stream" element={<LiveStream />} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText(/missing id/i)).toBeInTheDocument();
  });
});
