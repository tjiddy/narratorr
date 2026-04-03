import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { AudioPreview } from './AudioPreview';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';

// Mock HTMLMediaElement.prototype.play/pause (not implemented in jsdom)
let mockPlay: ReturnType<typeof vi.fn>;
let mockPause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPlay = vi.fn().mockImplementation(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  mockPause = vi.fn().mockImplementation(function (this: HTMLAudioElement) {
    this.dispatchEvent(new Event('pause'));
  });
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value: mockPlay,
  });
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: mockPause,
  });
});

describe('AudioPreview (#320)', () => {
  // Render conditions
  it('renders hidden audio element without native controls when book is imported with path', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.hasAttribute('controls')).toBe(false);
    expect(audio!.hidden).toBe(true);
  });

  it('renders only the custom play button — no native player UI', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
    // Native audio controls should not be visible
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.hasAttribute('controls')).toBe(false);
  });

  it('does not render when book status is not imported', () => {
    for (const status of ['wanted', 'downloading', 'searching', 'importing', 'missing', 'failed']) {
      const { unmount } = renderWithProviders(
        <AudioPreview bookId={1} status={status} path="/library/book1" />,
      );
      expect(document.querySelector('audio')).toBeNull();
      unmount();
    }
  });

  it('does not render when book.path is null even if status is imported', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path={null} />);
    expect(document.querySelector('audio')).toBeNull();
  });

  // Interaction
  it('sets audio src to resolveUrl-based preview URL', () => {
    renderWithProviders(<AudioPreview bookId={42} status="imported" path="/library/book" />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.src).toContain('/api/books/42/preview');
  });

  it('pauses audio element when pause button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    // Click play
    const playButton = screen.getByRole('button', { name: /play/i });
    await user.click(playButton);
    expect(mockPlay).toHaveBeenCalled();

    // Click pause
    const pauseButton = screen.getByRole('button', { name: /pause/i });
    await user.click(pauseButton);
    expect(mockPause).toHaveBeenCalled();
  });

  // Native control sync
  it('syncs header button to Pause when native controls trigger play event', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    // Initially shows Play
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('play'));
    });

    // After native play, header button should show Pause
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();
  });

  it('syncs header button to Play when native controls trigger pause event', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    const audio = document.querySelector('audio')!;
    // Simulate play then pause from native controls
    act(() => { audio.dispatchEvent(new Event('play')); });
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();

    act(() => { audio.dispatchEvent(new Event('pause')); });
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
  });

  it('syncs header button to Play when audio ends', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    const audio = document.querySelector('audio')!;
    act(() => { audio.dispatchEvent(new Event('play')); });
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();

    act(() => { audio.dispatchEvent(new Event('ended')); });
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
  });

  // Cleanup / navigation
  it('pauses audio and detaches source on unmount', () => {
    const { unmount } = renderWithProviders(
      <AudioPreview bookId={1} status="imported" path="/library/book1" />,
    );

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();

    unmount();

    expect(mockPause).toHaveBeenCalled();
    // In jsdom, setting src='' resolves to base URL; verify it no longer points to preview
    expect(audio!.src).not.toContain('/api/books/');
  });

  // Error handling
  it('shows error toast when audio element fires error event', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });

    expect(toast.error).toHaveBeenCalledWith('Could not load audio preview');
  });

  it('resets to play state after error', () => {
    renderWithProviders(<AudioPreview bookId={1} status="imported" path="/library/book1" />);

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });

    // After error, play button should be visible (not pause)
    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
  });
});
