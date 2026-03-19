import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyTheme } from './theme-bootstrap.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../index.html'), 'utf-8');
// Extract the inline IIFE from the first <script> tag in index.html
const scriptMatch = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
const inlineBootstrapScript = scriptMatch?.[1] ?? null;

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
    expect(document.documentElement.style.background).toBeTruthy(); // dark bg applied
  });

  it('removes dark class when localStorage theme=light', () => {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'light');
    applyTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.background).toBeTruthy(); // light bg applied
  });

  it('adds dark class when no localStorage theme and system prefers dark', () => {
    matchMediaMock.mockReturnValue({ matches: true });
    applyTheme();
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class when no localStorage theme and system prefers light', () => {
    document.documentElement.classList.add('dark');
    matchMediaMock.mockReturnValue({ matches: false });
    applyTheme();
    expect(matchMediaMock).toHaveBeenCalledWith('(prefers-color-scheme: dark)');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
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

// Exercise the ACTUAL production inline script from index.html (not the extracted helper)
// so that drift or deletion of the real before-first-paint path is caught immediately.
describe('index.html inline bootstrap script (production path)', () => {
  let matchMediaMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    document.documentElement.style.background = '';
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

  it('inline bootstrap script is present in index.html', () => {
    expect(inlineBootstrapScript).not.toBeNull();
  });

  it('adds dark class when localStorage theme=dark', () => {
    localStorage.setItem('theme', 'dark');
    eval(inlineBootstrapScript!); // executes the actual production inline IIFE
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not add dark class when localStorage theme=light', () => {
    // The inline script runs on a fresh <html> with no pre-existing classes.
    // Light mode means dark is never added — not that it is removed.
    localStorage.setItem('theme', 'light');
    eval(inlineBootstrapScript!); // executes the actual production inline IIFE
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('adds dark class when no localStorage theme and system prefers dark', () => {
    matchMediaMock.mockReturnValue({ matches: true });
    eval(inlineBootstrapScript!); // executes the actual production inline IIFE
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not add dark class when no localStorage theme and system prefers light', () => {
    matchMediaMock.mockReturnValue({ matches: false });
    eval(inlineBootstrapScript!); // executes the actual production inline IIFE
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
