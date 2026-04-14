import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FilterPill } from '@/components/FilterPill';

describe('FilterPill', () => {
  it('renders label text', () => {
    render(<FilterPill label="All" active={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('applies active styling when active prop is true', () => {
    render(<FilterPill label="All" active onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveClass('bg-primary', 'text-primary-foreground', 'shadow-glow');
  });

  it('applies inactive styling when active prop is false', () => {
    render(<FilterPill label="All" active={false} onClick={() => {}} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveClass('text-muted-foreground');
    expect(btn).not.toHaveClass('bg-primary');
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<FilterPill label="Error" active={false} onClick={onClick} />);
    await user.click(screen.getByRole('button', { name: 'Error' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders with type="button"', () => {
    render(<FilterPill label="All" active={false} onClick={() => {}} />);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('supports additional className', () => {
    render(<FilterPill label="All" active={false} onClick={() => {}} className="extra" />);
    expect(screen.getByRole('button')).toHaveClass('extra');
  });

  it('renders children instead of label when both provided', () => {
    render(
      <FilterPill active={false} onClick={() => {}}>
        <span>Custom</span>
      </FilterPill>
    );
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  describe('toolbar variant', () => {
    it('applies toolbar active styling', () => {
      render(<FilterPill label="Filters" active variant="toolbar" onClick={() => {}} />);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('bg-muted/80', 'text-foreground');
      expect(btn).not.toHaveClass('bg-primary');
    });

    it('applies toolbar inactive styling', () => {
      render(<FilterPill label="Sort" active={false} variant="toolbar" onClick={() => {}} />);
      const btn = screen.getByRole('button');
      expect(btn).toHaveClass('text-muted-foreground');
      expect(btn).not.toHaveClass('bg-muted/80');
    });

    it('supports aria-label', () => {
      render(<FilterPill label="Sort" active={false} variant="toolbar" onClick={() => {}} aria-label="Sort by title" />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Sort by title');
    });

    it('supports aria-pressed', () => {
      render(<FilterPill label="Series" active variant="toolbar" onClick={() => {}} aria-pressed={true} />);
      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });
  });
});
