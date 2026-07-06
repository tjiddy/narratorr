import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type MatchCandidate, type MatchResult, type MatchJobStatus } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';

const POLL_INTERVAL = 2000;

/**
 * Byte-budgeted chunking for match-start candidates (#1831). Candidates are
 * `{ path, title, author }` (~250 B, no metadata blob) so a large scan crosses the
 * 1 MiB body limit near ~4,000 books — enough for a big library to 413 at match-start
 * before confirm is ever reached. Chunking here (rather than in the confirm chunker —
 * they share only array splitting) covers all three call sites by construction: the
 * library initial scan, library Retry Match, and manual scan.
 */
const MATCH_CHUNK_BYTE_BUDGET = 400 * 1024; // 400 KiB — well under 1 MiB
const MATCH_CHUNK_MAX_ITEMS = 1000; // secondary count bound

export function packMatchCandidates(candidates: MatchCandidate[]): MatchCandidate[][] {
  const chunks: MatchCandidate[][] = [];
  let current: MatchCandidate[] = [];
  let bytes = 0;
  for (const candidate of candidates) {
    const size = new TextEncoder().encode(JSON.stringify(candidate)).length;
    if (current.length > 0 && (bytes + size > MATCH_CHUNK_BYTE_BUDGET || current.length >= MATCH_CHUNK_MAX_ITEMS)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(candidate);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

interface QueueState {
  chunks: MatchCandidate[][];
  index: number;
  /** Frozen results from completed chunks — the append-only prefix. */
  completed: MatchResult[];
  total: number;
  cancelled: boolean;
}

interface UseMatchJobReturn {
  results: MatchResult[];
  progress: { matched: number; total: number };
  isMatching: boolean;
  error: string | null;
  startMatching: (candidates: MatchCandidate[]) => Promise<void>;
  cancel: () => void;
}

export function useMatchJob(): UseMatchJobReturn {
  const [results, setResults] = useState<MatchResult[]>([]);
  const [progress, setProgress] = useState({ matched: 0, total: 0 });
  const [isMatching, setIsMatching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const queueRef = useRef<QueueState | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    stopPolling();
    // Drain the pending queue: the active-chunk poll/advance both bail on `cancelled`,
    // so no queued chunk starts once this is set.
    if (queueRef.current) queueRef.current.cancelled = true;
    if (jobIdRef.current) {
      api.cancelMatchJob(jobIdRef.current).catch(() => {});
      jobIdRef.current = null;
    }
    setIsMatching(false);
  }, [stopPolling]);

  // The setInterval poll and the chunk-advance are mutually recursive (a completed chunk
  // launches the next). Route both through refs so neither captures a stale closure.
  const pollTickRef = useRef<() => void>(() => {});
  const startChunkRef = useRef<() => void>(() => {});

  const handlePollStatus = useCallback((status: MatchJobStatus) => {
    const q = queueRef.current;
    if (!q || q.cancelled) return;

    // Append-only view: frozen completed-chunks prefix + this chunk's partial results,
    // preserving the monotonic slice contract both consumers depend on.
    setResults([...q.completed, ...status.results]);
    setProgress({ matched: q.completed.length + status.matched, total: q.total });

    if (status.status === 'completed' || status.status === 'cancelled') {
      stopPolling();
      jobIdRef.current = null;
      // Freeze this chunk's results into the prefix and advance to the next chunk.
      q.completed = [...q.completed, ...status.results];
      q.index += 1;
      startChunkRef.current();
    }
  }, [stopPolling]);

  const pollTick = useCallback(async () => {
    if (!jobIdRef.current) return;
    try {
      const status = await api.getMatchJob(jobIdRef.current);
      handlePollStatus(status);
    } catch (error: unknown) {
      // The active chunk's job may have expired — stop and surface the error.
      stopPolling();
      setIsMatching(false);
      setError(getErrorMessage(error));
    }
  }, [handlePollStatus, stopPolling]);

  const startChunk = useCallback(async () => {
    const q = queueRef.current;
    if (!q || q.cancelled) return;
    if (q.index >= q.chunks.length) {
      // Queue drained — every chunk completed.
      setIsMatching(false);
      return;
    }
    try {
      const { jobId } = await api.startMatchJob(q.chunks[q.index]!);
      if (q.cancelled) {
        api.cancelMatchJob(jobId).catch(() => {});
        return;
      }
      jobIdRef.current = jobId;
      intervalRef.current = setInterval(() => pollTickRef.current(), POLL_INTERVAL);
    } catch (error: unknown) {
      stopPolling();
      setIsMatching(false);
      setError(getErrorMessage(error));
    }
  }, [stopPolling]);

  // Keep the engine refs pointing at the latest callbacks each render.
  useEffect(() => {
    pollTickRef.current = () => { void pollTick(); };
    startChunkRef.current = () => { void startChunk(); };
  });

  const startMatching = useCallback(async (candidates: MatchCandidate[]) => {
    // Cancel any existing run and reset for the new queue.
    cancel();

    const chunks = packMatchCandidates(candidates);
    queueRef.current = { chunks, index: 0, completed: [], total: candidates.length, cancelled: false };
    setResults([]);
    setProgress({ matched: 0, total: candidates.length });
    setError(null);

    if (chunks.length === 0) {
      setIsMatching(false);
      return;
    }
    setIsMatching(true);
    await startChunk();
  }, [cancel, startChunk]);

  // Cleanup on unmount — abandon the queue and cancel the in-flight chunk.
  useEffect(() => {
    return () => {
      stopPolling();
      if (queueRef.current) queueRef.current.cancelled = true;
      if (jobIdRef.current) {
        api.cancelMatchJob(jobIdRef.current).catch(() => {});
      }
    };
  }, [stopPolling]);

  return { results, progress, isMatching, error, startMatching, cancel };
}
