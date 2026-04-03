import { useRef, useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { resolveUrl } from '@/lib/url-utils';
import { PlayIcon, PauseIcon } from '@/components/icons';

interface AudioPreviewProps {
  bookId: number;
  status: string;
  path: string | null;
}

export function AudioPreview({ bookId, status, path }: AudioPreviewProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const canPreview = status === 'imported' && !!path;

  const handleError = useCallback(() => {
    toast.error('Could not load audio preview');
    setIsPlaying(false);
  }, []);

  const handlePlay = useCallback(() => setIsPlaying(true), []);
  const handlePause = useCallback(() => setIsPlaying(false), []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.addEventListener('error', handleError);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handlePause);
    return () => {
      audio.removeEventListener('error', handleError);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handlePause);
      audio.pause();
      audio.src = '';
    };
  }, [handleError, handlePlay, handlePause]);

  if (!canPreview) return null;

  const previewUrl = resolveUrl(`/api/books/${bookId}/preview`);

  async function handlePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
    } else {
      try {
        await audio.play();
      } catch {
        // Browser may block autoplay; error event handles API failures
      }
    }
  }

  return (
    <div className="flex items-center gap-3 animate-fade-in-up">
      <button
        type="button"
        onClick={handlePlayPause}
        aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
        className="flex items-center justify-center w-10 h-10 rounded-full text-muted-foreground hover:text-primary glass-card hover:border-primary/30 transition-all duration-200 focus-ring"
      >
        {isPlaying
          ? <PauseIcon className="w-4 h-4" />
          : <PlayIcon className="w-4 h-4 ml-0.5" />}
      </button>
      <span className="text-xs text-muted-foreground/50 select-none">
        {isPlaying ? 'Playing...' : 'Preview'}
      </span>
      <audio ref={audioRef} src={previewUrl} preload="none" hidden />
    </div>
  );
}
