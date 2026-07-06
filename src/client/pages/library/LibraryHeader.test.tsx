import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { LibraryHeader } from './LibraryHeader';

describe('LibraryHeader', () => {
  it('renders the Library heading', () => {
    renderWithProviders(<LibraryHeader />);
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('renders default subtitle when none provided', () => {
    renderWithProviders(<LibraryHeader />);
    expect(screen.getByText('Your audiobook collection')).toBeInTheDocument();
  });

  it('renders custom subtitle when provided', () => {
    renderWithProviders(<LibraryHeader subtitle="41 books in your collection" />);
    expect(screen.getByText('41 books in your collection')).toBeInTheDocument();
  });

  it('renders the actions slot when provided', () => {
    renderWithProviders(<LibraryHeader actions={<button type="button">Library Actions</button>} />);
    expect(screen.getByRole('button', { name: 'Library Actions' })).toBeInTheDocument();
  });

  it('does not render a standalone Import Files link (folded into the actions menu)', () => {
    renderWithProviders(<LibraryHeader />);
    expect(screen.queryByRole('link', { name: /import files/i })).not.toBeInTheDocument();
  });

  describe('animation dedup', () => {
    it('wrapper div does not include animate-fade-in-up class', () => {
      const { container } = renderWithProviders(<LibraryHeader />);
      const wrapperDiv = container.firstElementChild as HTMLElement;
      expect(wrapperDiv.className).not.toContain('animate-fade-in-up');
    });
  });
});
