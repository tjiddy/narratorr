import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type ImportJobWithBook } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { useSSEConnected } from '@/hooks/useEventSource';
import { useMergeProgress } from '@/hooks/useMergeProgress.js';
import type { MergeDisplayPhase } from '@shared/schemas/sse-events.js';

export interface BookActivity {
  state: 'working' | 'queued';
  /** Display unit (0..100) — converted here from the store's 0..1 wire fraction. */
  percentage?: number;
  label: string;
}

const MERGE_WORKING_LABELS: Partial<Record<MergeDisplayPhase, string>> = {
  starting: 'Merging…',
  staging: 'Preparing files…',
  processing: 'Encoding…',
  verifying: 'Verifying output…',
  committing: 'Finishing…',
};

/**
 * Live "is anything happening to this book" signal for library surfaces.
 * Merges come from the SSE-fed per-book store; import jobs share the Activity
 * page's query key, so however many cards subscribe there is one fetch. A
 * terminal merge (outcome set) reports null — the grid shows nothing during
 * the Activity card's dismiss window.
 */
export function useBookActivity(bookId: number): BookActivity | null {
  const sseConnected = useSSEConnected();
  const merge = useMergeProgress(bookId);

  const selectJob = useCallback(
    (jobs: ImportJobWithBook[]) =>
      jobs.find((j) => j.bookId === bookId && (j.status === 'pending' || j.status === 'processing')) ?? null,
    [bookId],
  );
  const { data: importJob } = useQuery({
    queryKey: queryKeys.importJobs(),
    queryFn: () => api.getImportJobs(),
    refetchInterval: sseConnected ? false : 5000,
    select: selectJob,
  });

  if (merge && merge.outcome === undefined) {
    if (merge.phase === 'queued') return { state: 'queued', label: 'Merge queued' };
    const label = MERGE_WORKING_LABELS[merge.phase];
    if (label) {
      return {
        state: 'working',
        label,
        ...(merge.percentage !== undefined && { percentage: merge.percentage * 100 }),
      };
    }
  }
  if (importJob) {
    return importJob.status === 'pending'
      ? { state: 'queued', label: 'Import queued' }
      : { state: 'working', label: 'Importing…' };
  }
  return null;
}
