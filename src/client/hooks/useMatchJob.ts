import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MatchCandidate, type MatchResult } from '@/lib/api';
import { MatchEngine, type MatchEngineSnapshot } from './match-engine.js';
import type { PausedReason } from './match-recovery.js';

// Re-exported so existing importers (and the chunking tests) keep their entry point.
export { packMatchCandidates, MATCH_CHUNK_BYTE_BUDGET } from './match-packing.js';
export type { PausedReason } from './match-recovery.js';

const INITIAL_SNAPSHOT: MatchEngineSnapshot = {
  results: [],
  progress: { matched: 0, total: 0 },
  isMatching: false,
  recovering: false,
  paused: false,
  reason: null,
  remaining: 0,
  matchedCount: 0,
  total: 0,
};

export interface UseMatchJobReturn {
  results: MatchResult[];
  progress: { matched: number; total: number };
  isMatching: boolean;
  /** True while a Restart-all / Resume-remaining attempt is in flight (fail-closed CTA). */
  recovering: boolean;
  paused: boolean;
  reason: PausedReason | null;
  remaining: number;
  matchedCount: number;
  total: number;
  /** Initial automatic run after a scan. Fresh logical run; allowance reset. */
  startMatching: (candidates: MatchCandidate[]) => void;
  /** Restart all — a new logical run over the CALLER's current candidate values. */
  restart: (candidates: MatchCandidate[]) => void;
  /** Resume remaining — one authorized recovery attempt for the result-less remainder. */
  resume: () => void;
  cancel: () => void;
}

/**
 * Chunked match engine with bounded failure recovery (#1864). Wires the
 * framework-agnostic {@link MatchEngine} — single-flight polling, bounded retry,
 * 404 auto-resume, probe-before-replace, rechunked remainder — to React state.
 * Serves the library initial scan, library Restart, and manual import scan.
 */
export function useMatchJob(): UseMatchJobReturn {
  const [snap, setSnap] = useState<MatchEngineSnapshot>(INITIAL_SNAPSHOT);
  const engineRef = useRef<MatchEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new MatchEngine(
      { startMatchJob: api.startMatchJob, getMatchJob: api.getMatchJob, cancelMatchJob: api.cancelMatchJob },
      setSnap,
    );
  }

  useEffect(() => () => engineRef.current?.dispose(), []);

  const startMatching = useCallback((candidates: MatchCandidate[]) => engineRef.current!.startMatching(candidates), []);
  const restart = useCallback((candidates: MatchCandidate[]) => engineRef.current!.restart(candidates), []);
  const resume = useCallback(() => engineRef.current!.resume(), []);
  const cancel = useCallback(() => engineRef.current!.cancel(), []);

  return {
    results: snap.results,
    progress: snap.progress,
    isMatching: snap.isMatching,
    recovering: snap.recovering,
    paused: snap.paused,
    reason: snap.reason,
    remaining: snap.remaining,
    matchedCount: snap.matchedCount,
    total: snap.total,
    startMatching,
    restart,
    resume,
    cancel,
  };
}
