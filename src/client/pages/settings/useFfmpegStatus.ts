import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Auto-detected ffmpeg status (replaces the old editable path field). Drives the
 * Audio Tools status row and gates the ffmpeg-dependent Post Processing toggles.
 * ffmpeg doesn't come and go at runtime, so this is cached generously.
 */
export function useFfmpegStatus() {
  return useQuery({
    queryKey: ['ffmpeg-status'],
    queryFn: () => api.getFfmpegStatus(),
    staleTime: 5 * 60_000,
  });
}
