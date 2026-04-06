import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { TestResultMessage } from '@/components/TestResultMessage';

describe('TestResultMessage', () => {
  it('shows default success message when success is true', () => {
    renderWithProviders(<TestResultMessage success={true} />);

    expect(screen.getByText('Connection successful!')).toBeInTheDocument();
  });

  it('shows default failure message when success is false', () => {
    renderWithProviders(<TestResultMessage success={false} />);

    expect(screen.getByText('Connection failed')).toBeInTheDocument();
  });

  it('shows custom message when provided', () => {
    renderWithProviders(<TestResultMessage success={true} message="All systems go" />);

    expect(screen.getByText('All systems go')).toBeInTheDocument();
    expect(screen.queryByText('Connection successful!')).not.toBeInTheDocument();
  });

  it('shows custom successText when provided and success is true', () => {
    renderWithProviders(<TestResultMessage success={true} successText="Looks good!" />);

    expect(screen.getByText('Looks good!')).toBeInTheDocument();
  });

  it('shows custom failureText when provided and success is false', () => {
    renderWithProviders(<TestResultMessage success={false} failureText="Nope, broken" />);

    expect(screen.getByText('Nope, broken')).toBeInTheDocument();
  });

  it('message overrides successText', () => {
    renderWithProviders(
      <TestResultMessage success={true} message="Override" successText="Custom success" />,
    );

    expect(screen.getByText('Override')).toBeInTheDocument();
    expect(screen.queryByText('Custom success')).not.toBeInTheDocument();
  });

  it('message overrides failureText', () => {
    renderWithProviders(
      <TestResultMessage success={false} message="Override" failureText="Custom fail" />,
    );

    expect(screen.getByText('Override')).toBeInTheDocument();
    expect(screen.queryByText('Custom fail')).not.toBeInTheDocument();
  });

  it('#372 — shows warning text with amber styling when success + warning', () => {
    const { container } = renderWithProviders(
      <TestResultMessage success={true} warning="Account is ratio-locked" />,
    );
    expect(screen.getByText('Account is ratio-locked')).toBeInTheDocument();
    expect(screen.queryByText('Connection successful!')).not.toBeInTheDocument();
    const p = container.querySelector('p');
    expect(p?.className).toContain('text-amber-500');
  });

  it('#372 — shows green success when success without warning', () => {
    const { container } = renderWithProviders(
      <TestResultMessage success={true} />,
    );
    expect(screen.getByText('Connection successful!')).toBeInTheDocument();
    const p = container.querySelector('p');
    expect(p?.className).toContain('text-success');
  });

  it('#372 — shows red error when failure (unchanged)', () => {
    const { container } = renderWithProviders(
      <TestResultMessage success={false} />,
    );
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    const p = container.querySelector('p');
    expect(p?.className).toContain('text-destructive');
  });
});
