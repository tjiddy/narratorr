import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/Badge';
import { CheckCircleIcon } from '@/components/icons';

describe('Badge', () => {
  it('renders success variant with bg-emerald-500/15, text-emerald-400, ring-1, ring-emerald-500/20 classes', () => {
    render(<Badge variant="success">Matched</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('bg-emerald-500/15', 'text-emerald-400', 'ring-1', 'ring-emerald-500/20');
  });

  it('renders warning variant with bg-amber-500/15, text-amber-400, ring-1, ring-amber-500/20 classes', () => {
    render(<Badge variant="warning">Review</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('bg-amber-500/15', 'text-amber-400', 'ring-1', 'ring-amber-500/20');
  });

  it('renders danger variant with bg-red-500/15, text-red-400, ring-1, ring-red-500/20 classes', () => {
    render(<Badge variant="danger">No Match</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('bg-red-500/15', 'text-red-400', 'ring-1', 'ring-red-500/20');
  });

  it('renders info variant with bg-blue-500/15, text-blue-400, ring-1, ring-blue-500/20 classes', () => {
    render(<Badge variant="info">Info</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('bg-blue-500/15', 'text-blue-400', 'ring-1', 'ring-blue-500/20');
  });

  it('renders muted variant with bg-muted/50, text-muted-foreground, ring-1, ring-border/20 classes', () => {
    render(<Badge variant="muted">Matching</Badge>);
    const badge = screen.getByTestId('badge');
    expect(badge).toHaveClass('bg-muted/50', 'text-muted-foreground', 'ring-1', 'ring-border/20');
  });

  it('renders text-only with no icon element in the DOM when icon prop is omitted', () => {
    const { container } = render(<Badge variant="muted">Already in library</Badge>);
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(screen.getByTestId('badge')).toHaveTextContent('Already in library');
  });

  it('renders icon before text when icon prop is provided', () => {
    const { container } = render(
      <Badge variant="success" icon={CheckCircleIcon}>
        In library
      </Badge>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    const badge = screen.getByTestId('badge');
    expect(badge.firstChild?.nodeName.toLowerCase()).toBe('svg');
    expect(badge).toHaveTextContent('In library');
  });
});
