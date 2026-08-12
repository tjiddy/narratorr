import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

// All ffmpeg-gated surfaces share one generously cached auto-detected status so
// they cannot disagree about availability.
export function useFfmpegStatus() {
  return useQuery({
    queryKey: queryKeys.ffmpegStatus(),
    queryFn: () => api.getFfmpegStatus(),
    staleTime: 5 * 60_000,
  });
}
