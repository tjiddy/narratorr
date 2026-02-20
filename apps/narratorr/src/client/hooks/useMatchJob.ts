import { useState, useEffect, useRef, useCallback } from 'react';
import { api, type MatchCandidate, type MatchResult, type MatchJobStatus } from '@/lib/api';

const POLL_INTERVAL = 2000;

interface UseMatchJobReturn {
  results: MatchResult[];
  progress: { matched: number; total: number };
  isMatching: boolean;
  startMatching: (candidates: MatchCandidate[]) => void;
  cancel: () => void;
}

export function useMatchJob(): UseMatchJobReturn {
  const [results, setResults] = useState<MatchResult[]>([]);
  const [progress, setProgress] = useState({ matched: 0, total: 0 });
  const [isMatching, setIsMatching] = useState(false);
  const jobIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    stopPolling();
    if (jobIdRef.current) {
      api.cancelMatchJob(jobIdRef.current).catch(() => {});
      jobIdRef.current = null;
    }
    setIsMatching(false);
  }, [stopPolling]);

  const handlePollResult = useCallback((status: MatchJobStatus) => {
    setResults(status.results);
    setProgress({ matched: status.matched, total: status.total });

    if (status.status === 'completed' || status.status === 'cancelled') {
      stopPolling();
      setIsMatching(false);
      jobIdRef.current = null;
    }
  }, [stopPolling]);

  const startMatching = useCallback(async (candidates: MatchCandidate[]) => {
    // Cancel any existing job
    cancel();

    setResults([]);
    setProgress({ matched: 0, total: candidates.length });
    setIsMatching(true);

    try {
      const { jobId } = await api.startMatchJob(candidates);
      jobIdRef.current = jobId;

      intervalRef.current = setInterval(async () => {
        if (!jobIdRef.current) return;
        try {
          const status = await api.getMatchJob(jobIdRef.current);
          handlePollResult(status);
        } catch {
          // Job may have expired — stop polling
          stopPolling();
          setIsMatching(false);
        }
      }, POLL_INTERVAL);
    } catch {
      setIsMatching(false);
    }
  }, [cancel, handlePollResult, stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopPolling();
      if (jobIdRef.current) {
        api.cancelMatchJob(jobIdRef.current).catch(() => {});
      }
    };
  }, [stopPolling]);

  return { results, progress, isMatching, startMatching, cancel };
}
