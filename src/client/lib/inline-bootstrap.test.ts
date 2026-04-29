import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(join(__dirname, '../index.html'), 'utf-8');
const scriptMatch = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
const inlineBootstrapScript = scriptMatch?.[1] ?? null;

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
    eval(inlineBootstrapScript!);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not add dark class when localStorage theme=light', () => {
    localStorage.setItem('theme', 'light');
    eval(inlineBootstrapScript!);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('adds dark class when no localStorage theme and system prefers dark', () => {
    matchMediaMock.mockReturnValue({ matches: true });
    eval(inlineBootstrapScript!);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('does not add dark class when no localStorage theme and system prefers light', () => {
    matchMediaMock.mockReturnValue({ matches: false });
    eval(inlineBootstrapScript!);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
