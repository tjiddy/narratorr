import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { api, type BulkOpType, type BulkJobStatus } from '@/lib/api';

const POLL_INTERVAL = 2000;

interface BulkProgress {
  completed: number;
  total: number;
  failures: number;
}

interface UseBulkOperationReturn {
  isRunning: boolean;
  jobType: BulkOpType | null;
  progress: BulkProgress;
  startJob: (type: BulkOpType) => Promise<void>;
}

const IDLE_PROGRESS: BulkProgress = Object.freeze({ completed: 0, total: 0, failures: 0 });

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
    setProgress({ completed: status.completed, total: status.total, failures: status.failures });
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
          // Server restarted or job expired — reset to idle silently
          stopPolling();
          setIsRunning(false);
          setJobType(null);
          setProgress(IDLE_PROGRESS);
          jobIdRef.current = null;
        } else {
          // Unexpected error (500, network failure, etc.) — reset to idle with toast
          stopPolling();
          setIsRunning(false);
          setJobType(null);
          setProgress(IDLE_PROGRESS);
          jobIdRef.current = null;
          toast.error(error instanceof Error ? error.message : 'Bulk operation polling failed');
        }
      }
    }, POLL_INTERVAL);
  }, [stopPolling, applyJobStatus]);

  // On mount: check for an active job and resume polling if found
  useEffect(() => {
    let cancelled = false;
    api.getActiveBulkJob().then((activeJob) => {
      if (cancelled || !activeJob) return;
      jobIdRef.current = activeJob.jobId;
      setIsRunning(true);
      setJobType(activeJob.type);
      setProgress({ completed: activeJob.completed, total: activeJob.total, failures: activeJob.failures });
      startPolling(activeJob.jobId);
    }).catch(() => {});

    return () => { cancelled = true; };
  }, [startPolling]);

  // Cleanup on unmount — stop interval but do NOT cancel the server-side job
  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, [stopPolling]);

  const startJob = useCallback(async (type: BulkOpType) => {
    const startFn =
      type === 'rename' ? api.startBulkRename :
      type === 'retag' ? api.startBulkRetag :
      api.startBulkConvert;

    const { jobId } = await startFn();
    jobIdRef.current = jobId;
    setIsRunning(true);
    setJobType(type);
    setProgress(IDLE_PROGRESS);
    startPolling(jobId);
  }, [startPolling]);

  return { isRunning, jobType, progress, startJob };
}
