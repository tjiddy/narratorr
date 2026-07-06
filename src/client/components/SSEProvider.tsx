import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';

// Re-mint the stream token on this interval so a fresh token is always on hand to
// authorize the next open/reconnect (#1453). A healthy live stream is authorized
// connect-time-only and is NOT reopened just because the token refreshed; it stays
// open until an error, logout/null token, unmount, or the server-side max-age close
// (#1796), each of which drives useEventSource to reopen with the current token.
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
