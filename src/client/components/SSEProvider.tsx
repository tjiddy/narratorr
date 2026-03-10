import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/queryKeys';
import { api } from '@/lib/api';
import { useEventSource } from '@/hooks/useEventSource';

/**
 * Connects the SSE event stream for real-time updates.
 * Fetches the API key from auth config and passes it to useEventSource.
 * Mount once inside the authenticated layout.
 */
export function SSEProvider() {
  const { data: authConfig } = useQuery({
    queryKey: queryKeys.auth.config(),
    queryFn: api.getAuthConfig,
    staleTime: Infinity,
  });

  useEventSource(authConfig?.apiKey ?? null);

  return null;
}
