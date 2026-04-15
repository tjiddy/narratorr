import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { LazyRoute } from '@/components/LazyRoute';

function wrap(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LazyRoute', () => {
  it('shows loading-spinner while lazy chunk is pending', async () => {
    let resolveImport!: (mod: { default: React.ComponentType }) => void;
    const LazyComponent = React.lazy(
      () => new Promise<{ default: React.ComponentType }>((r) => { resolveImport = r; }),
    );

    wrap(<LazyRoute><LazyComponent /></LazyRoute>);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAccessibleName('Loading');

    await act(async () => {
      resolveImport({ default: () => <div data-testid="lazy-content">Loaded</div> });
    });

    expect(screen.getByTestId('lazy-content')).toBeInTheDocument();
    expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
  });

  it('catches rejected lazy import and shows route error fallback', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const FailingLazy = React.lazy(
      () => Promise.reject(new Error('Failed to fetch dynamically imported module')),
    );

    wrap(<LazyRoute><FailingLazy /></LazyRoute>);

    await screen.findByText('Failed to load this page');
    expect(screen.getByText('Failed to fetch dynamically imported module')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();

    spy.mockRestore();
  });

  it('user can navigate to another route after one lazy route fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    const FailingLazy = React.lazy(
      () => Promise.reject(new Error('chunk load error')),
    );

    const GoodPage = () => <div data-testid="good-page">Good Page</div>;
    const GoodLazy = React.lazy(
      () => Promise.resolve({ default: GoodPage }),
    );

    function Nav() {
      return <nav><Link to="/good">Go to good page</Link></nav>;
    }

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/bad']}>
          <Nav />
          <Routes>
            <Route path="/bad" element={<LazyRoute><FailingLazy /></LazyRoute>} />
            <Route path="/good" element={<LazyRoute><GoodLazy /></LazyRoute>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Failed to load this page');
    expect(screen.queryByTestId('good-page')).not.toBeInTheDocument();

    await user.click(screen.getByText('Go to good page'));

    await screen.findByTestId('good-page');
    expect(screen.queryByText('Failed to load this page')).not.toBeInTheDocument();

    spy.mockRestore();
  });
});
