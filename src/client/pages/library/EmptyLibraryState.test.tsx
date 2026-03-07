import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { EmptyLibraryState } from './EmptyLibraryState';

describe('EmptyLibraryState', () => {
  it('renders heading', () => {
    renderWithProviders(<EmptyLibraryState />);
    expect(screen.getByText('Your library is empty')).toBeInTheDocument();
  });

  it('renders description text', () => {
    renderWithProviders(<EmptyLibraryState />);
    expect(
      screen.getByText('Start building your audiobook collection by discovering and adding books'),
    ).toBeInTheDocument();
  });

  it('renders Manual Import link pointing to /import', () => {
    renderWithProviders(<EmptyLibraryState />);
    const link = screen.getByText('Manual Import').closest('a');
    expect(link).toHaveAttribute('href', '/import');
  });

  it('renders Discover Books link pointing to /search', () => {
    renderWithProviders(<EmptyLibraryState />);
    const link = screen.getByText('Discover Books').closest('a');
    expect(link).toHaveAttribute('href', '/search');
  });
});
