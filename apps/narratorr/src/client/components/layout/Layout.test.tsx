import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { Layout } from '@/components/layout/Layout';

describe('Layout', () => {
  it('renders without crashing', () => {
    renderWithProviders(<Layout />);

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    renderWithProviders(<Layout />);

    expect(screen.getByText('Library')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders footer', () => {
    renderWithProviders(<Layout />);

    expect(screen.getByText(/your personal audiobook library/i)).toBeInTheDocument();
  });

  it('renders theme toggle button', () => {
    renderWithProviders(<Layout />);

    expect(screen.getByTitle(/switch to dark mode/i)).toBeInTheDocument();
  });
});
