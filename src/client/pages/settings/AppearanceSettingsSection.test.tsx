import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { AppearanceSettingsSection } from './AppearanceSettingsSection';

const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));

describe('AppearanceSettingsSection', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    mockMatchMedia.mockReset();
    mockMatchMedia.mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    window.matchMedia = mockMatchMedia;
  });

  it('renders a theme toggle control in an Appearance section', () => {
    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /dark mode/i })).toBeInTheDocument();
  });

  it('clicking toggle immediately applies dark class to document.documentElement', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppearanceSettingsSection />);

    const toggle = screen.getByRole('checkbox', { name: /dark mode/i });
    await user.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('clicking toggle again removes dark class from document.documentElement', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    renderWithProviders(<AppearanceSettingsSection />);

    const toggle = screen.getByRole('checkbox', { name: /dark mode/i });
    await user.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('updates localStorage theme key to dark when toggled to dark', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AppearanceSettingsSection />);

    const toggle = screen.getByRole('checkbox', { name: /dark mode/i });
    await user.click(toggle);

    expect(localStorage.getItem('theme')).toBe('dark');
  });

  it('updates localStorage theme key to light when toggled to light', async () => {
    localStorage.setItem('theme', 'dark');
    const user = userEvent.setup();
    renderWithProviders(<AppearanceSettingsSection />);

    const toggle = screen.getByRole('checkbox', { name: /dark mode/i });
    await user.click(toggle);

    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('reflects stored dark theme on mount when localStorage has theme=dark', () => {
    localStorage.setItem('theme', 'dark');
    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.getByRole('checkbox', { name: /dark mode/i })).toBeChecked();
  });

  it('reflects light theme on mount when localStorage has theme=light', () => {
    localStorage.setItem('theme', 'light');
    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.getByRole('checkbox', { name: /dark mode/i })).not.toBeChecked();
  });

  it('reflects matchMedia dark preference as initial state when no localStorage key', () => {
    mockMatchMedia.mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.getByRole('checkbox', { name: /dark mode/i })).toBeChecked();
  });

  it('reflects matchMedia light preference as initial state when no localStorage key', () => {
    // default mock returns matches: false → light
    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.getByRole('checkbox', { name: /dark mode/i })).not.toBeChecked();
  });

  it('does not render a Save button', () => {
    renderWithProviders(<AppearanceSettingsSection />);

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });
});
