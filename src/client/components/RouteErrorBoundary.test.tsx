import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { RouteErrorBoundary } from '@/components/RouteErrorBoundary';

function ThrowingChild({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

describe('RouteErrorBoundary', () => {
  it('renders children normally when no error', () => {
    renderWithProviders(
      <RouteErrorBoundary>
        <div>Page content</div>
      </RouteErrorBoundary>,
    );

    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('catches render error and shows route-scoped fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithProviders(
      <RouteErrorBoundary>
        <ThrowingChild message="Chunk load failed" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText('Failed to load this page')).toBeInTheDocument();
    expect(screen.getByText(/try again or navigate to another page/i)).toBeInTheDocument();
    spy.mockRestore();
  });

  it('displays error message in the fallback', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithProviders(
      <RouteErrorBoundary>
        <ThrowingChild message="Loading chunk xyz failed" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText('Loading chunk xyz failed')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('resets error state when user clicks Try Again', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();

    let shouldThrow = true;
    function ConditionalThrower() {
      if (shouldThrow) throw new Error('fail');
      return <div>Recovered content</div>;
    }

    renderWithProviders(
      <RouteErrorBoundary>
        <ConditionalThrower />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText('Failed to load this page')).toBeInTheDocument();

    shouldThrow = false;
    await user.click(screen.getByRole('button', { name: 'Try Again' }));

    expect(screen.getByText('Recovered content')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('does not use min-h-screen — stays within content area', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container } = renderWithProviders(
      <RouteErrorBoundary>
        <ThrowingChild message="fail" />
      </RouteErrorBoundary>,
    );

    const fallback = container.querySelector('[data-testid="route-error-fallback"]');
    expect(fallback).toBeInTheDocument();
    expect(fallback?.className).not.toContain('min-h-screen');
    spy.mockRestore();
  });
});
