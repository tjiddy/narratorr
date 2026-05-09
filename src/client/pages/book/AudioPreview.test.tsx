import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { AudioPreview } from './AudioPreview';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

import { toast } from 'sonner';

let mockPlay: ReturnType<typeof vi.fn>;
let mockPause: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockPlay = vi.fn().mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { value: false, configurable: true });
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  });
  mockPause = vi.fn().mockImplementation(function (this: HTMLAudioElement) {
    Object.defineProperty(this, 'paused', { value: true, configurable: true });
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

describe('AudioPreview — book source (#320)', () => {
  it('renders hidden audio element without native controls when enabled', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.hasAttribute('controls')).toBe(false);
    expect(audio!.hidden).toBe(true);
  });

  it('renders play button with Preview label — no native player UI', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.hasAttribute('controls')).toBe(false);
  });

  it('does not render when book source is disabled', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: false }} />);
    expect(document.querySelector('audio')).toBeNull();
  });

  it('sets audio src to resolveUrl-based preview URL', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 42, enabled: true }} />);

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.src).toContain('/api/books/42/preview');
  });

  it('pauses audio element when pause button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    const playButton = screen.getByRole('button', { name: /play/i });
    await user.click(playButton);
    expect(mockPlay).toHaveBeenCalled();

    const pauseButton = screen.getByRole('button', { name: /pause/i });
    await user.click(pauseButton);
    expect(mockPause).toHaveBeenCalled();
  });

  it('syncs header button to Pause when native controls trigger play event', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('play'));
    });

    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();
  });

  it('syncs header button to Play when audio ends', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    const audio = document.querySelector('audio')!;
    act(() => { audio.dispatchEvent(new Event('play')); });
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();

    act(() => { audio.dispatchEvent(new Event('ended')); });
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
  });

  it('shows "Playing..." label while audio is playing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    expect(screen.getByText('Preview')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /play/i }));
    expect(screen.getByText('Playing...')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /pause/i }));
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('pauses audio and detaches source on unmount', () => {
    const { unmount } = renderWithProviders(
      <AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />,
    );

    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();

    unmount();

    expect(mockPause).toHaveBeenCalled();
    expect(audio!.src).not.toContain('/api/books/');
  });

  it('shows error toast when audio element fires error event', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });

    expect(toast.error).toHaveBeenCalledWith('Could not load audio preview');
  });

  it('resets to play state after error', () => {
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });

    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
  });
});

describe('AudioPreview — single-active coordination (#1059)', () => {
  it('starting a second preview pauses the currently playing preview', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />
        <AudioPreview source={{ kind: 'book', bookId: 2, enabled: true }} />
      </>,
    );

    const [firstPlay, secondPlay] = screen.getAllByRole('button', { name: /play preview/i });
    expect(secondPlay).toBeDefined();

    await user.click(firstPlay!);
    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(1);

    const remainingPlay = screen.getByRole('button', { name: /play preview/i });
    const pauseCallsBefore = mockPause.mock.calls.length;
    await user.click(remainingPlay);

    expect(mockPause.mock.calls.length).toBeGreaterThan(pauseCallsBefore);
    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(1);
  });

  it('clicking the same instance pause→play does not get re-paused by self-broadcast', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />);

    await user.click(screen.getByRole('button', { name: /play preview/i }));
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /pause preview/i }));
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
  });

  it('a disabled (renders null) sibling does not break coordination', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />
        <AudioPreview source={{ kind: 'book', bookId: 2, enabled: true }} />
        <AudioPreview source={{ kind: 'url', previewUrl: undefined, enabled: false }} />
      </>,
    );

    expect(document.querySelectorAll('audio')).toHaveLength(2);

    const [firstPlay] = screen.getAllByRole('button', { name: /play preview/i });
    await user.click(firstPlay!);
    await user.click(screen.getByRole('button', { name: /play preview/i }));

    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(1);
  });

  it('error on the playing instance does not block another instance from playing', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} />
        <AudioPreview source={{ kind: 'book', bookId: 2, enabled: true }} />
      </>,
    );

    const [firstPlay] = screen.getAllByRole('button', { name: /play preview/i });
    await user.click(firstPlay!);

    const audios = document.querySelectorAll('audio');
    const playingAudio = Array.from(audios).find((el) => !el.paused);
    expect(playingAudio).toBeDefined();
    act(() => {
      playingAudio!.dispatchEvent(new Event('error'));
    });

    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(2);

    const [, secondPlay] = screen.getAllByRole('button', { name: /play preview/i });
    await user.click(secondPlay!);
    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(1);
  });

  it('compact-size siblings coordinate the same way as default-size', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/a', enabled: true }} size="compact" />
        <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/b', enabled: true }} size="compact" />
      </>,
    );

    const [firstPlay] = screen.getAllByRole('button', { name: /play preview/i });
    await user.click(firstPlay!);
    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /play preview/i }));
    expect(screen.getAllByRole('button', { name: /pause preview/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /play preview/i })).toHaveLength(1);
  });

  it('unmounting the playing instance clears registry — a later-mounted instance can play normally', async () => {
    const user = userEvent.setup();

    function Fixture({ showFirst, showSecond }: { showFirst: boolean; showSecond: boolean }) {
      return (
        <>
          {showFirst ? <AudioPreview source={{ kind: 'book', bookId: 1, enabled: true }} /> : null}
          {showSecond ? <AudioPreview source={{ kind: 'book', bookId: 2, enabled: true }} /> : null}
        </>
      );
    }

    const { rerender } = renderWithProviders(<Fixture showFirst showSecond={false} />);

    await user.click(screen.getByRole('button', { name: /play preview/i }));
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();

    const firstAudio = document.querySelector('audio');
    rerender(<Fixture showFirst={false} showSecond />);

    expect(firstAudio?.src ?? '').not.toContain('/api/books/1/preview');
    expect(screen.queryByRole('button', { name: /pause preview/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /play preview/i }));
    expect(screen.getByRole('button', { name: /pause preview/i })).toBeInTheDocument();
  });
});

describe('AudioPreview — url source (#1017)', () => {
  it('renders when previewUrl is set and enabled', () => {
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/abc', enabled: true }} />,
    );
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
  });

  it('does not render when previewUrl is undefined', () => {
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: undefined, enabled: true }} />,
    );
    expect(document.querySelector('audio')).toBeNull();
  });

  it('does not render when disabled', () => {
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/abc', enabled: false }} />,
    );
    expect(document.querySelector('audio')).toBeNull();
  });

  it('uses the previewUrl as the audio src (resolveUrl-prefixed)', () => {
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/xyz', enabled: true }} />,
    );
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect(audio!.src).toContain('/api/import/preview/xyz');
  });

  it('fires rescan-guidance toast on <audio> error event in url mode (#1017)', () => {
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/abc', enabled: true }} />,
    );
    const audio = document.querySelector('audio')!;
    act(() => {
      audio.dispatchEvent(new Event('error'));
    });
    expect(toast.error).toHaveBeenCalledWith('Preview expired — rescan to refresh.');
  });

  it('compact size renders icon-only without "Preview" label', () => {
    renderWithProviders(
      <AudioPreview
        source={{ kind: 'url', previewUrl: '/api/import/preview/abc', enabled: true }}
        size="compact"
      />,
    );
    expect(screen.getByRole('button', { name: /play preview/i })).toBeInTheDocument();
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('clicking play triggers <audio>.play()', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <AudioPreview source={{ kind: 'url', previewUrl: '/api/import/preview/abc', enabled: true }} />,
    );
    await user.click(screen.getByRole('button', { name: /play/i }));
    expect(mockPlay).toHaveBeenCalled();
  });
});
