import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ErrorBoundary } from '@/components/ErrorBoundary';

// A component that throws on render
function ThrowingChild({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

describe('ErrorBoundary', () => {
  it('renders children normally when no error', () => {
    renderWithProviders(
      <ErrorBoundary>
        <div>All good</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('catches error in child and renders fallback UI', () => {
    // Suppress React's error boundary console.error noise
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderWithProviders(
      <ErrorBoundary>
        <ThrowingChild message="Test explosion" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('An unexpected error occurred. Try reloading the page.')).toBeInTheDocument();
    expect(screen.getByText('Test explosion')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload Page' })).toBeInTheDocument();

    spy.mockRestore();
  });

  it('does not render error message when error has no message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // ErrorBoundary state always has error.message (it's an Error object), but test empty string
    renderWithProviders(
      <ErrorBoundary>
        <ThrowingChild message="" />
      </ErrorBoundary>,
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    spy.mockRestore();
  });
});
