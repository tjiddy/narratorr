import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';

// Refreshing only caches a token for the next reconnect; a healthy stream stays open
// until an error, null token, unmount, or server max-age close.
const STREAM_TOKEN_REFRESH_MS = 4 * 60 * 1000;

/** Uses session-scoped stream tokens instead of exposing the long-lived API key to SSE. */
export function SSEProvider() {
  const { data: streamToken, refetch } = useQuery({
    queryKey: queryKeys.auth.streamToken(),
    queryFn: api.mintStreamToken,
    staleTime: STREAM_TOKEN_REFRESH_MS,
    refetchInterval: STREAM_TOKEN_REFRESH_MS,
    refetchOnWindowFocus: false,
  });

  const remint = useCallback(() => { void refetch(); }, [refetch]);

  useEventSource(streamToken?.token ?? null, remint);

  return null;
}
