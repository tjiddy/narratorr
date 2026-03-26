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

  it('renders Add a Book link pointing to /search', () => {
    renderWithProviders(<EmptyLibraryState />);
    const link = screen.getByText('Add a Book').closest('a');
    expect(link).toHaveAttribute('href', '/search');
  });
});

describe('EmptyLibraryState — library path branching (#133)', () => {
  it('shows Go to Settings CTA when no library path configured', () => {
    renderWithProviders(<EmptyLibraryState hasLibraryPath={false} />);
    expect(screen.getByText('Go to Settings')).toBeInTheDocument();
    expect(screen.queryByText('Scan Library')).not.toBeInTheDocument();
  });

  it('shows Scan Library CTA when library path is configured', () => {
    renderWithProviders(<EmptyLibraryState hasLibraryPath />);
    expect(screen.getByText('Scan Library')).toBeInTheDocument();
    expect(screen.queryByText('Go to Settings')).not.toBeInTheDocument();
  });

  it('shows Add a Book CTA when library path is configured', () => {
    renderWithProviders(<EmptyLibraryState hasLibraryPath />);
    const link = screen.getByText('Add a Book').closest('a');
    expect(link).toHaveAttribute('href', '/search');
  });

  it('Scan Library link points to /library-import', () => {
    renderWithProviders(<EmptyLibraryState hasLibraryPath />);
    const link = screen.getByText('Scan Library').closest('a');
    expect(link).toHaveAttribute('href', '/library-import');
  });
});
