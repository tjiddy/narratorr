import { useRef, useState, useEffect, useCallback, useId } from 'react';
import { toast } from 'sonner';
import { resolveUrl } from '@/lib/url-utils';
import { PlayIcon, PauseIcon } from '@/components/icons';

export type AudioPreviewSource =
  | { kind: 'book'; bookId: number; enabled: boolean }
  | { kind: 'url'; previewUrl: string | undefined; enabled: boolean };

interface AudioPreviewProps {
  source: AudioPreviewSource;
  size?: 'default' | 'compact';
}

type PreviewState = 'idle' | 'buffering' | 'playing';

const activePreviews = new Map<string, () => void>();

function pauseOtherPreviews(activeId: string) {
  for (const [id, pause] of activePreviews) {
    if (id !== activeId) pause();
  }
}

function resolveSourceUrl(source: AudioPreviewSource): { canPreview: boolean; url: string | undefined } {
  if (source.kind === 'book') {
    if (!source.enabled) return { canPreview: false, url: undefined };
    return { canPreview: true, url: resolveUrl(`/api/books/${source.bookId}/preview`) };
  }
  if (!source.enabled || !source.previewUrl) return { canPreview: false, url: undefined };
  return { canPreview: true, url: resolveUrl(source.previewUrl) };
}

function labelFor(state: PreviewState): string {
  if (state === 'playing') return 'Playing...';
  if (state === 'buffering') return 'Buffering...';
  return 'Preview';
}

export function AudioPreview({ source, size = 'default' }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [previewState, setPreviewState] = useState<PreviewState>('idle');
  const previewId = useId();

  const { canPreview, url } = resolveSourceUrl(source);

  const errorMessage = source.kind === 'url'
    ? 'Preview expired — rescan to refresh.'
    : 'Could not load audio preview';

  const handleError = useCallback(() => {
    toast.error(errorMessage);
    setPreviewState('idle');
  }, [errorMessage]);

  const handlePlaying = useCallback(() => {
    pauseOtherPreviews(previewId);
    setPreviewState('playing');
  }, [previewId]);
  const handleWaiting = useCallback(() => setPreviewState('buffering'), []);
  const handleIdle = useCallback(() => setPreviewState('idle'), []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.addEventListener('error', handleError);
    audio.addEventListener('playing', handlePlaying);
    audio.addEventListener('waiting', handleWaiting);
    audio.addEventListener('pause', handleIdle);
    audio.addEventListener('ended', handleIdle);
    activePreviews.set(previewId, () => audio.pause());
    return () => {
      activePreviews.delete(previewId);
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('playing', handlePlaying);
      audio.removeEventListener('waiting', handleWaiting);
      audio.removeEventListener('pause', handleIdle);
      audio.removeEventListener('ended', handleIdle);
      audio.pause();
      audio.src = '';
    };
  }, [previewId, handleError, handlePlaying, handleWaiting, handleIdle]);

  if (!canPreview) return null;

  async function handlePlayPause(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    const audio = audioRef.current;
    if (!audio) return;

    if (!audio.paused) {
      audio.pause();
    } else {
      pauseOtherPreviews(previewId);
      setPreviewState('buffering');
      try {
        await audio.play();
      } catch {
        setPreviewState('idle');
      }
    }
  }

  const isActive = previewState !== 'idle';
  const ariaLabel = isActive ? 'Pause preview' : 'Play preview';

  if (size === 'compact') {
    return (
      <>
        <button
          type="button"
          onClick={handlePlayPause}
          aria-label={ariaLabel}
          className="p-1.5 rounded-lg text-muted-foreground hover:text-primary transition-colors focus-ring"
        >
          {isActive
            ? <PauseIcon className="w-3.5 h-3.5" />
            : <PlayIcon className="w-3.5 h-3.5" />}
        </button>
        <audio ref={audioRef} src={url} preload="none" hidden />
      </>
    );
  }

  return (
    <div className="flex items-center gap-3 animate-fade-in-up">
      <button
        type="button"
        onClick={handlePlayPause}
        aria-label={ariaLabel}
        className="flex items-center justify-center w-10 h-10 rounded-full text-muted-foreground hover:text-primary glass-card hover:border-primary/30 transition-all duration-200 focus-ring"
      >
        {isActive
          ? <PauseIcon className="w-4 h-4" />
          : <PlayIcon className="w-4 h-4 ml-0.5" />}
      </button>
      <span className="text-xs text-muted-foreground/50 select-none">
        {labelFor(previewState)}
      </span>
      <audio ref={audioRef} src={url} preload="none" hidden />
    </div>
  );
}
