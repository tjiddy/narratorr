import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyTheme } from './theme-bootstrap.js';

describe('applyTheme', () => {
  let matchMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    localStorage.clear();
    matchMediaMock = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: matchMediaMock,
    });
  });

  afterEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.style.background = '';
    localStorage.clear();
  });

  it('adds dark class when localStorage theme=dark', () => {
    localStorage.setItem('theme', 'dark');
    applyTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.background).toBe('hsl(30 8% 7%)');
  });

  it('removes dark class when localStorage theme=light', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'light');
    applyTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.background).toBe('hsl(30 10% 98%)');
  });

  it('adds dark class when no localStorage theme and system prefers dark', () => {
    matchMediaMock.mockReturnValue({ matches: true });
    applyTheme();
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.background).toBe('hsl(30 8% 7%)');
  });

  it('removes dark class when no localStorage theme and system prefers light', () => {
    document.documentElement.classList.add('dark');
    matchMediaMock.mockReturnValue({ matches: false });
    applyTheme();
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.background).toBe('hsl(30 10% 98%)');
  });

  it('localStorage theme takes precedence over system preference', () => {
    localStorage.setItem('theme', 'light');
    matchMediaMock.mockReturnValue({ matches: true }); // system says dark
    applyTheme();
    // localStorage wins: light
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    // matchMedia should not have been consulted when localStorage has a value
    expect(matchMediaMock).not.toHaveBeenCalled();
  });
});
