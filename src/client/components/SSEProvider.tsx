import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';

// Re-mint the stream token before the server-side TTL (5 min, #1453) lapses so the
// live EventSource connection is never dropped by expiry. The query refetches on
// this interval; when the token changes, useEventSource reopens the stream.
const STREAM_TOKEN_REFRESH_MS = 4 * 60 * 1000;

/**
 * Connects the SSE event stream for real-time updates.
 *
 * Mints a short-lived, session-scoped stream token (#1453) and passes it to
 * useEventSource instead of reading the long-lived API key from auth config —
 * the SSE endpoints are no longer API-key-reachable. The token is refreshed on
 * an interval and re-minted on a stream error (e.g. expiry) so the connection
 * recovers transparently. Mount once inside the authenticated layout.
 */
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
