import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorState } from '@/components/ErrorState';

describe('ErrorState', () => {
  it('renders title text', () => {
    render(<ErrorState title="Something went wrong" description="Failed to load" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Something went wrong' })).toBeInTheDocument();
  });

  it('renders description text', () => {
    render(<ErrorState title="Error" description="Failed to load your library" />);
    expect(screen.getByText('Failed to load your library')).toBeInTheDocument();
  });

  it('renders AlertCircle icon by default', () => {
    const { container } = render(<ErrorState title="Error" description="Oops" />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders custom icon when provided', () => {
    const CustomIcon = ({ className }: { className?: string }) => <span data-testid="custom-icon" className={className}>!</span>;
    render(<ErrorState title="Error" description="Oops" icon={CustomIcon} />);
    expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
  });

  it('renders retry button when onRetry is provided', () => {
    render(<ErrorState title="Error" description="Oops" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does not render retry button when onRetry is omitted', () => {
    render(<ErrorState title="Error" description="Oops" />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<ErrorState title="Error" description="Oops" onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders destructive gradient backdrop', () => {
    const { container } = render(<ErrorState title="Error" description="Oops" />);
    expect(container.querySelector('.bg-destructive\\/20')).toBeInTheDocument();
  });

  it('does not crash with only required props', () => {
    render(<ErrorState title="Error" description="Something happened" />);
    expect(screen.getByText('Error')).toBeInTheDocument();
    expect(screen.getByText('Something happened')).toBeInTheDocument();
  });
});
