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

  describe('optional icon', () => {
    it('renders without icon prop — icon section not rendered', () => {
      render(<EmptyState title="Empty" subtitle="Sub" />);
      expect(screen.queryByTestId('mock-icon')).not.toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3, name: 'Empty' })).toBeInTheDocument();
    });

    it('renders with icon={undefined} — same as omitted', () => {
      render(<EmptyState title="Empty" subtitle="Sub" />);
      expect(screen.queryByTestId('mock-icon')).not.toBeInTheDocument();
      expect(screen.getByText('Sub')).toBeInTheDocument();
    });

    it('title and subtitle still render when icon is omitted', () => {
      render(<EmptyState title="No icon" subtitle="Still works" />);
      expect(screen.getByRole('heading', { level: 3, name: 'No icon' })).toBeInTheDocument();
      expect(screen.getByText('Still works')).toBeInTheDocument();
    });
  });

  describe('action-row layout for children', () => {
    it('children are wrapped in action-row layout div', () => {
      const { container } = render(
        <EmptyState icon={MockIcon} title="Empty" subtitle="Sub">
          <a href="/search">Find Books</a>
          <a href="/import">Import</a>
        </EmptyState>
      );
      const actionRow = container.querySelector('.flex.flex-wrap.items-center.gap-3');
      expect(actionRow).toBeInTheDocument();
      expect(actionRow!.querySelectorAll('a')).toHaveLength(2);
    });

    it('no empty wrapper div when no children provided', () => {
      const { container } = render(<EmptyState icon={MockIcon} title="Empty" subtitle="Sub" />);
      expect(container.querySelector('.flex.flex-wrap.items-center.gap-3')).not.toBeInTheDocument();
    });
  });
});
