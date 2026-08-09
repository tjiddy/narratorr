import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { api, type BulkOpType, type BulkJobStatus, type BulkJobFailure } from '@/lib/api';
import { getErrorMessage } from '@/lib/error-message.js';

const POLL_INTERVAL = 2000;

interface BulkProgress {
  completed: number;
  total: number;
  failures: number;
  /** Server-capped named failures; `failures` may exceed this array's length. */
  failureDetails: BulkJobFailure[];
}

interface UseBulkOperationReturn {
  isRunning: boolean;
  jobType: BulkOpType | null;
  progress: BulkProgress;
  startJob: (type: BulkOpType) => Promise<void>;
}

const IDLE_PROGRESS: BulkProgress = Object.freeze({ completed: 0, total: 0, failures: 0, failureDetails: [] });

/** Exhaustive so a new `BulkOpType` cannot silently fall through to the wrong endpoint (#2056). */
const START_FNS: Record<BulkOpType, () => Promise<{ jobId: string }>> = {
  rename: () => api.startBulkRename(),
  retag: () => api.startBulkRetag(),
  write_metadata_sidecars: () => api.startBulkWriteMetadataSidecars(),
};

export function useBulkOperation(): UseBulkOperationReturn {
  const [isRunning, setIsRunning] = useState(false);
  const [jobType, setJobType] = useState<BulkOpType | null>(null);
  const [progress, setProgress] = useState<BulkProgress>(IDLE_PROGRESS);
  const jobIdRef = useRef<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const applyJobStatus = useCallback((status: BulkJobStatus) => {
    setProgress({
      completed: status.completed,
      total: status.total,
      failures: status.failures,
      failureDetails: status.failureDetails,
    });
    if (status.status === 'completed') {
      stopPolling();
      setIsRunning(false);
      jobIdRef.current = null;
    }
  }, [stopPolling]);

  const startPolling = useCallback((jobId: string) => {
    stopPolling();
    intervalRef.current = setInterval(async () => {
      try {
        const status = await api.getBulkJob(jobId);
        applyJobStatus(status);
      } catch (error: unknown) {
        if (error instanceof Error && (error as { status?: number }).status === 404) {
          // A missing job usually means the server restarted or it expired; reset silently.
          stopPolling();
          setIsRunning(false);
          setJobType(null);
          setProgress(IDLE_PROGRESS);
          jobIdRef.current = null;
        } else {
          stopPolling();
          setIsRunning(false);
          setJobType(null);
          setProgress(IDLE_PROGRESS);
          jobIdRef.current = null;
          toast.error(getErrorMessage(error));
        }
      }
    }, POLL_INTERVAL);
  }, [stopPolling, applyJobStatus]);

  useEffect(() => {
    let cancelled = false;
    api.getActiveBulkJob().then((activeJob) => {
      if (cancelled || !activeJob) return;
      jobIdRef.current = activeJob.jobId;
      setIsRunning(true);
      setJobType(activeJob.type);
      setProgress({
        completed: activeJob.completed,
        total: activeJob.total,
        failures: activeJob.failures,
        failureDetails: activeJob.failureDetails,
      });
      startPolling(activeJob.jobId);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [startPolling]);

  // Unmount stops local polling, not the server-side job.
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const startJob = useCallback(async (type: BulkOpType) => {
    const { jobId } = await START_FNS[type]();
    jobIdRef.current = jobId;
    setIsRunning(true);
    setJobType(type);
    setProgress(IDLE_PROGRESS);
    startPolling(jobId);
  }, [startPolling]);

  return { isRunning, jobType, progress, startJob };
}
