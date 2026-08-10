import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

// Tag embedding gates on mutagen rather than ffmpeg (#2210); all mutagen-gated surfaces share one
// generously cached auto-detected status so they cannot disagree about availability.
export function useMutagenStatus() {
  return useQuery({
    queryKey: queryKeys.mutagenStatus(),
    queryFn: () => api.getMutagenStatus(),
    staleTime: 5 * 60_000,
  });
}
