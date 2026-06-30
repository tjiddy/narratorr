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

  it('renders the coarse ownership signal with no not-owned state (narrator-blind, no false negative #1712)', () => {
    // The badge only ever asserts ownership ("In Library") — there is no negative
    // branch, so the narrator-blind coarsening can never claim you do NOT own a title.
    renderWithProviders(<InLibraryBadge bookId={999} />);
    expect(screen.getByText('In Library')).toBeInTheDocument();
    expect(screen.queryByText(/not in library|don't own|do not own/i)).not.toBeInTheDocument();
  });
});
