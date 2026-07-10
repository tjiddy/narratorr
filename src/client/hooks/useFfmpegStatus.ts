import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/**
 * Auto-detected ffmpeg status (replaces the old editable path field). Drives the
 * Audio Tools status row, the ffmpeg-gated Post Processing toggles, and the
 * BookDetails merge/retag buttons — all sharing ONE cache entry via
 * `queryKeys.ffmpegStatus()` so they never disagree about ffmpeg availability.
 * ffmpeg doesn't come and go at runtime, so this is cached generously.
 */
export function useFfmpegStatus() {
  return useQuery({
    queryKey: queryKeys.ffmpegStatus(),
    queryFn: () => api.getFfmpegStatus(),
    staleTime: 5 * 60_000,
  });
}
