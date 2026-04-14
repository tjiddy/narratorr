import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

  it('does not replace the layout shell when one route fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const FailingLazy = React.lazy(
      () => Promise.reject(new Error('chunk load error')),
    );

    const GoodComponent = () => <div data-testid="shell">Shell Content</div>;

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <GoodComponent />
          <LazyRoute><FailingLazy /></LazyRoute>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('Failed to load this page');
    expect(screen.getByTestId('shell')).toBeInTheDocument();

    spy.mockRestore();
  });
});
