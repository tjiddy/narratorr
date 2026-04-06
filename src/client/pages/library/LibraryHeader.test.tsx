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

  it('renders Import Files link pointing to /import', () => {
    renderWithProviders(<LibraryHeader />);
    const link = screen.getByText('Import Files').closest('a');
    expect(link).toHaveAttribute('href', '/import');
  });
});
