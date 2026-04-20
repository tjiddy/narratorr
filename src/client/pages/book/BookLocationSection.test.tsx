import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { BookLocationSection } from './BookLocationSection';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { toast } from 'sonner';

describe('BookLocationSection', () => {
  let mockExecCommand: ReturnType<typeof vi.fn> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockExecCommand = null;
    Object.defineProperty(document, 'execCommand', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      get: () => undefined,
      configurable: true,
    });
  });

  function mockExecCommandWith(returnValue: boolean | (() => never)) {
    mockExecCommand = typeof returnValue === 'function'
      ? vi.fn().mockImplementation(returnValue)
      : vi.fn().mockReturnValue(returnValue);
    Object.defineProperty(document, 'execCommand', {
      value: mockExecCommand,
      configurable: true,
      writable: true,
    });
    return mockExecCommand;
  }

  it('renders the Location heading and the monospace path string', () => {
    const path = '/library/audiobooks/Sanderson/The Way of Kings';
    renderWithProviders(<BookLocationSection path={path} />);

    expect(screen.getByRole('heading', { name: /^location$/i })).toBeInTheDocument();
    const code = screen.getByText(path);
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('font-mono');
  });

  it('copies via navigator.clipboard.writeText when available → success toast', async () => {
    const path = '/library/book/story.m4b';
    const writeText = vi.fn().mockResolvedValue(undefined);
    // Must set clipboard AFTER userEvent.setup() — userEvent attaches its own clipboard stub on setup()
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => ({ writeText }),
      configurable: true,
    });

    renderWithProviders(<BookLocationSection path={path} />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(path);
      expect(toast.success).toHaveBeenCalledWith('Copied to clipboard');
    });
  });

  it('shows error toast when navigator.clipboard rejects — does NOT fall back to execCommand', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => ({ writeText }),
      configurable: true,
    });
    const execCommand = mockExecCommandWith(true);

    renderWithProviders(<BookLocationSection path="/library/book/story.m4b" />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
    });
    expect(execCommand).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('falls back to execCommand when navigator.clipboard is undefined → success toast', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => undefined,
      configurable: true,
    });
    const execCommand = mockExecCommandWith(true);

    renderWithProviders(<BookLocationSection path="/library/book/story.m4b" />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(toast.success).toHaveBeenCalledWith('Copied to clipboard');
    });
  });

  it('shows error toast when execCommand returns false (clipboard undefined)', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => undefined,
      configurable: true,
    });
    mockExecCommandWith(false);

    renderWithProviders(<BookLocationSection path="/library/book/story.m4b" />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
    });
  });

  it('shows error toast when execCommand throws (clipboard undefined)', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => undefined,
      configurable: true,
    });
    mockExecCommandWith(() => { throw new Error('execCommand not supported'); });

    renderWithProviders(<BookLocationSection path="/library/book/story.m4b" />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
    });
  });

  it('renders long paths with break-all and select-all utility classes on the code element', () => {
    const longPath = '/very/deeply/nested/library/tree/Brandon Sanderson/The Stormlight Archive/Book 01 - The Way of Kings/The Way of Kings.m4b';
    renderWithProviders(<BookLocationSection path={longPath} />);

    const code = screen.getByText(longPath);
    expect(code.tagName).toBe('CODE');
    expect(code.className).toContain('break-all');
    expect(code.className).toContain('select-all');
  });

  it('sets the code element title attribute to the exact path for the hover fallback', () => {
    const path = '/library/audiobooks/Sanderson/The Way of Kings';
    renderWithProviders(<BookLocationSection path={path} />);

    const code = screen.getByText(path);
    expect(code.tagName).toBe('CODE');
    expect(code.getAttribute('title')).toBe(path);
  });

  it('announces "Copied!" to screen readers after a successful copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      get: () => ({ writeText }),
      configurable: true,
    });

    renderWithProviders(<BookLocationSection path="/library/book/story.m4b" />);
    await user.click(screen.getByTitle('Copy to clipboard'));

    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
    expect(screen.getByText('Copied!').className).toContain('sr-only');
  });
});
