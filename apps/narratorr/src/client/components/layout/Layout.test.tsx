import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { Layout } from '@/components/layout/Layout';

// jsdom doesn't implement matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

afterEach(cleanup);

describe('Layout', () => {
  it('renders without crashing', () => {
    renderWithProviders(<Layout />);

    expect(screen.getByText('narratorr')).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    renderWithProviders(<Layout />);

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
