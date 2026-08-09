import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type CompanionEbookState } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';

/** A 409 is a stable disabled setting and never retries; other failures retain three attempts. */
export function retryUnlessDisabled(failureCount: number, queryError: unknown): boolean {
  return !(queryError instanceof ApiError && queryError.status === 409) && failureCount < 3;
}

/**
 * Returns a count only for readable metadata matching the rendered state filename (#2022).
 * State and metadata reads can straddle reconciliation, so the gate, coherence check, and
 * mismatch recovery prevent wasted reads, wrong counts, and permanently missing counts.
 */
export function useCompanionChapterCount(bookId: number, state: CompanionEbookState | undefined): number | null {
  const queryClient = useQueryClient();

  // Only available rows with filenames need metadata. Reconciliation may still change server
  // state after the request starts; that race is handled as an ordinary metadata failure.
  const stateFilename = state?.status === 'available' ? state.filename : null;

  const metadata = useQuery({
    // Filename isolates cache entries but records only the expected file; response coherence is
    // still required. Inherit the 60s default because invalidation handles explicit refreshes.
    queryKey: queryKeys.companionEbookMetadata(bookId, stateFilename ?? ''),
    queryFn: () => api.getCompanionEbookMetadata(bookId),
    enabled: stateFilename !== null,
    retry: retryUnlessDisabled,
  });

  // A disabled observer can retain cached data, so mask it while state is not available.
  const observed = stateFilename !== null ? metadata.data : undefined;
  const metadataFilename = observed?.filename ?? null;

  // Bind count to the server-reported filename and omit unreadable TOCs. Coherent retained data
  // survives refetch failures; deriving from the cache prevents a stale local copy.
  const coherent = metadataFilename !== null && metadataFilename === stateFilename;
  const toc = coherent ? (observed?.toc ?? null) : null;

  // A fire-and-forget reconcile can leave state stale while metadata is newer. Invalidate only
  // the exact state key; a prefix refetch repeats metadata under the stale filename. Primitive
  // filename dependencies bound repeats, so a handled-pair registry would suppress valid remount
  // recovery without improving correctness.
  useEffect(() => {
    if (stateFilename === null || metadataFilename === null) return;
    if (stateFilename === metadataFilename) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.companionEbook(bookId), exact: true });
  }, [queryClient, bookId, stateFilename, metadataFilename]);

  return toc === null ? null : toc.length;
}
