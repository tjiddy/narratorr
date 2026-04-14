import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from '@/components/EmptyState';

const MockIcon = ({ className }: { className?: string }) => <svg data-testid="mock-icon" className={className} />;

describe('EmptyState', () => {
  it('renders title text', () => {
    render(<EmptyState icon={MockIcon} title="Your library is empty" subtitle="Start building" />);
    expect(screen.getByRole('heading', { level: 3, name: 'Your library is empty' })).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    render(<EmptyState icon={MockIcon} title="Empty" subtitle="Add some books" />);
    expect(screen.getByText('Add some books')).toBeInTheDocument();
  });

  it('renders icon', () => {
    render(<EmptyState icon={MockIcon} title="Empty" subtitle="Sub" />);
    expect(screen.getByTestId('mock-icon')).toBeInTheDocument();
  });

  it('renders children when provided', () => {
    render(
      <EmptyState icon={MockIcon} title="Empty" subtitle="Sub">
        <button type="button">Action</button>
      </EmptyState>
    );
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });

  it('does not render children container when no children', () => {
    const { container } = render(<EmptyState icon={MockIcon} title="Empty" subtitle="Sub" />);
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders data-testid when provided', () => {
    render(<EmptyState icon={MockIcon} title="Empty" subtitle="Sub" data-testid="my-empty" />);
    expect(screen.getByTestId('my-empty')).toBeInTheDocument();
  });
});
