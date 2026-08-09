import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type MatchCandidate, type MatchResult } from '@/lib/api';
import { MatchEngine, type MatchEngineSnapshot } from './match-engine.js';
import type { PausedReason } from './match-recovery.js';

// Preserve the existing entry point for importers and chunking tests.
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
  /** Locks the fail-closed CTA while recovery is in flight. */
  recovering: boolean;
  paused: boolean;
  reason: PausedReason | null;
  remaining: number;
  matchedCount: number;
  total: number;
  /** Start a fresh automatic run and reset its allowance. */
  startMatching: (candidates: MatchCandidate[]) => void;
  /** Restart over the caller's current candidate values. */
  restart: (candidates: MatchCandidate[]) => void;
  /** Authorize one attempt over the result-less remainder. */
  resume: () => void;
  cancel: () => void;
}

/** React state wrapper for the shared library/manual-import match engine (#1864). */
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
