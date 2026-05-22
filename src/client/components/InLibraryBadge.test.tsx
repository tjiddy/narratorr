import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { InLibraryBadge } from './InLibraryBadge';

describe('InLibraryBadge', () => {
  it('renders a link to /books/<id> with the In Library label', () => {
    renderWithProviders(<InLibraryBadge bookId={123} />);
    const link = screen.getByRole('link', { name: /view this book in your library/i });
    expect(link).toHaveAttribute('href', '/books/123');
    expect(screen.getByText('In Library')).toBeInTheDocument();
  });

  it('hides the text below sm breakpoint by default', () => {
    renderWithProviders(<InLibraryBadge bookId={1} />);
    expect(screen.getByText('In Library')).toHaveClass('hidden', 'sm:inline');
  });

  it('always shows the text when textBreakpoint is omitted via prop default', () => {
    renderWithProviders(<InLibraryBadge bookId={1} textBreakpoint="sm" />);
    expect(screen.getByText('In Library')).toHaveClass('hidden', 'sm:inline');
  });
});
