import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { TestButton } from '@/components/TestButton';

describe('TestButton', () => {
  it('renders with "Test" label in form variant', () => {
    renderWithProviders(
      <TestButton testing={false} onClick={vi.fn()} variant="form" />,
    );

    expect(screen.getByRole('button', { name: /Test/i })).toBeInTheDocument();
  });

  it('renders with "Test" label in inline variant', () => {
    renderWithProviders(
      <TestButton testing={false} onClick={vi.fn()} variant="inline" />,
    );

    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <TestButton testing={false} onClick={onClick} variant="form" />,
    );

    await user.click(screen.getByRole('button', { name: /Test/i }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows loading state and "Testing..." text in form variant', () => {
    renderWithProviders(
      <TestButton testing={true} onClick={vi.fn()} variant="form" />,
    );

    expect(screen.getByText('Testing...')).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when testing is true', () => {
    renderWithProviders(
      <TestButton testing={true} onClick={vi.fn()} variant="inline" />,
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when disabled prop is true', () => {
    renderWithProviders(
      <TestButton testing={false} onClick={vi.fn()} variant="form" disabled={true} />,
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(
      <TestButton testing={false} onClick={onClick} variant="form" disabled={true} />,
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('inline variant maps to sm size (px-3 py-2 text-sm)', () => {
    renderWithProviders(
      <TestButton testing={false} onClick={vi.fn()} variant="inline" />,
    );
    expect(screen.getByRole('button')).toHaveClass('px-3', 'py-2', 'text-sm');
  });

  it('form variant maps to md size (px-4 py-3)', () => {
    renderWithProviders(
      <TestButton testing={false} onClick={vi.fn()} variant="form" />,
    );
    expect(screen.getByRole('button')).toHaveClass('px-4', 'py-3');
  });
});
