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
export const MATCH_CHUNK_BYTE_BUDGET = 400 * 1024; // 400 KiB — well under 1 MiB
const MATCH_CHUNK_MAX_ITEMS = 1000; // secondary count bound

/** Reused across every candidate serialization instead of ~5k per-pack allocations (#1833). */
const encoder = new TextEncoder();
/**
 * Byte cost of the `{ books: [...] }` request envelope for an EMPTY array —
 * `{"books":[]}` = 12 bytes. Reserved up front so the budget bounds what actually
 * crosses the wire, not the bare candidate array (#1833). Each item after the first
 * in a chunk additionally costs a `,` separator, accounted for below.
 */
const MATCH_ENVELOPE_BYTES = encoder.encode(JSON.stringify({ books: [] })).length;

export function packMatchCandidates(candidates: MatchCandidate[]): MatchCandidate[][] {
  const chunks: MatchCandidate[][] = [];
  let current: MatchCandidate[] = [];
  // Track the serialized size of the whole `{ books: current }` body, not just the
  // summed candidate bytes — the wire body is `JSON.stringify({ books: chunk })` (#1833).
  let bodyBytes = MATCH_ENVELOPE_BYTES;
  for (const candidate of candidates) {
    const size = encoder.encode(JSON.stringify(candidate)).length;
    // Adding to a non-empty chunk also costs a separating comma.
    const wouldExceed = bodyBytes + size + 1 > MATCH_CHUNK_BYTE_BUDGET;
    if (current.length > 0 && (wouldExceed || current.length >= MATCH_CHUNK_MAX_ITEMS)) {
      chunks.push(current);
      current = [];
      bodyBytes = MATCH_ENVELOPE_BYTES;
    }
    // First item in a chunk pays no comma; subsequent items pay one.
    bodyBytes += current.length > 0 ? size + 1 : size;
    current.push(candidate);
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
    // Response-identity guard (#1833): ignore any poll whose job is no longer the active
    // one. Two triggers this closes — (a) an overlapping poll that resolves after we already
    // advanced past this job (the 2 s interval firing while a slow getMatchJob is pending),
    // and (b) a stale poll resolving after Retry Match swapped in a fresh queue (which reads
    // `queueRef` fresh, so `q.cancelled` alone would not catch it). Without this the frozen
    // prefix duplicates and a whole chunk is silently skipped.
    if (status.id !== jobIdRef.current) return;

    // Append-only view: frozen completed-chunks prefix + this chunk's partial results,
    // preserving the monotonic slice contract both consumers depend on.
    setResults([...q.completed, ...status.results]);
    setProgress({ matched: q.completed.length + status.matched, total: q.total });

    // A server-reported cancellation (#1833) — e.g. cancelJob() from a second tab — terminates
    // the WHOLE queue. It must NOT advance like completion: launching the next chunk against an
    // intentionally-stopped run would resurrect a cancelled job. Partial results are retained.
    if (status.status === 'cancelled') {
      stopPolling();
      q.cancelled = true;
      jobIdRef.current = null;
      setIsMatching(false);
      return;
    }

    if (status.status === 'completed') {
      stopPolling();
      jobIdRef.current = null;
      // Freeze this chunk's results into the prefix and advance to the next chunk.
      q.completed = [...q.completed, ...status.results];
      q.index += 1;
      startChunkRef.current();
    }
  }, [stopPolling]);

  const pollTick = useCallback(async () => {
    // Capture the polled job id before the await so a rejection can be attributed to the run
    // it belongs to (#1833) — jobIdRef may have moved on by the time the promise settles.
    const jobId = jobIdRef.current;
    if (!jobId) return;
    try {
      const status = await api.getMatchJob(jobId);
      handlePollStatus(status);
    } catch (error: unknown) {
      // A rejection from a superseded run (Retry Match / cancel already moved on) must not
      // stop the NEW run's polling or surface a spurious error that disables Register (#1833).
      if (jobId !== jobIdRef.current) return;
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
      // A stale rejection from a superseded run (this queue was cancelled/replaced while the
      // start was in flight) must not stop polling or error the NEW run (#1833). The captured
      // `q` is this run's queue; `cancel()` marks it before swapping in the replacement.
      if (q.cancelled) return;
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
