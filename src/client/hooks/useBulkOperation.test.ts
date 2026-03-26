import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBulkOperation } from './useBulkOperation.js';
import type { BulkJobStatus } from '@/lib/api';

const mockGetActiveBulkJob = vi.fn();
const mockGetBulkJob = vi.fn();
const mockStartBulkRename = vi.fn();
const mockStartBulkRetag = vi.fn();
const mockStartBulkConvert = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    getActiveBulkJob: (...args: unknown[]) => mockGetActiveBulkJob(...args),
    getBulkJob: (...args: unknown[]) => mockGetBulkJob(...args),
    startBulkRename: (...args: unknown[]) => mockStartBulkRename(...args),
    startBulkRetag: (...args: unknown[]) => mockStartBulkRetag(...args),
    startBulkConvert: (...args: unknown[]) => mockStartBulkConvert(...args),
  },
}));

function make404Error() {
  const err = new Error('Not found');
  (err as { status?: number }).status = 404;
  return err;
}

function makeRunningJob(overrides?: Partial<BulkJobStatus>): BulkJobStatus {
  return {
    id: 'job-1',
    type: 'rename',
    status: 'running',
    completed: 3,
    total: 10,
    failures: 0,
    ...overrides,
  };
}

function makeCompletedJob(overrides?: Partial<BulkJobStatus>): BulkJobStatus {
  return {
    id: 'job-1',
    type: 'rename',
    status: 'completed',
    completed: 10,
    total: 10,
    failures: 0,
    ...overrides,
  };
}

describe('useBulkOperation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockGetActiveBulkJob.mockResolvedValue(null);
    mockGetBulkJob.mockResolvedValue(makeRunningJob());
    mockStartBulkRename.mockResolvedValue({ jobId: 'job-1' });
    mockStartBulkRetag.mockResolvedValue({ jobId: 'job-2' });
    mockStartBulkConvert.mockResolvedValue({ jobId: 'job-3' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('queries bulk/active on mount and resumes polling when a job is running', async () => {
    const running = makeRunningJob();
    mockGetActiveBulkJob.mockResolvedValue(running);
    mockGetBulkJob.mockResolvedValue(running);

    const { result } = renderHook(() => useBulkOperation());

    await act(async () => {}); // flush the getActiveBulkJob promise

    expect(result.current.isRunning).toBe(true);
    expect(result.current.jobType).toBe('rename');
    expect(result.current.progress.completed).toBe(3);
    expect(result.current.progress.total).toBe(10);
  });

  it('queries bulk/active on mount and sets idle state when null returned', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);

    const { result } = renderHook(() => useBulkOperation());

    await act(async () => {}); // flush mount effect

    expect(mockGetActiveBulkJob).toHaveBeenCalled();
    expect(result.current.isRunning).toBe(false);
    expect(result.current.jobType).toBeNull();
  });

  it('starts polling after job is confirmed started', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);

    const { result } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    expect(mockStartBulkRename).toHaveBeenCalled();
    expect(result.current.isRunning).toBe(true);
    expect(result.current.jobType).toBe('rename');
  });

  it('increments progress as poll results update completed count', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);
    mockGetBulkJob
      .mockResolvedValueOnce(makeRunningJob({ completed: 5, total: 20 }))
      .mockResolvedValueOnce(makeRunningJob({ completed: 10, total: 20 }));

    const { result } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(result.current.progress.completed).toBe(5);

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(result.current.progress.completed).toBe(10);
  });

  it('stops polling and marks complete when status=completed', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);
    mockGetBulkJob.mockResolvedValue(makeCompletedJob({ completed: 10, total: 10 }));

    const { result } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(result.current.isRunning).toBe(false);

    // Advance again — should not poll anymore
    mockGetBulkJob.mockClear();
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(mockGetBulkJob).not.toHaveBeenCalled();
  });

  it('resets to idle when poll returns 404 (server restart)', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);
    mockGetBulkJob.mockRejectedValue(make404Error());

    const { result } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    await act(async () => { vi.advanceTimersByTime(2000); });

    expect(result.current.isRunning).toBe(false);
    expect(result.current.jobType).toBeNull();
  });

  it('does NOT cancel the active job on unmount (unlike useMatchJob)', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);

    const { result, unmount } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    unmount();

    // Verify only startBulkRename was called, no cancel call
    expect(mockStartBulkRename).toHaveBeenCalledTimes(1);
    // The api object has no cancelBulkJob — this is by design
    expect(mockGetBulkJob).toHaveBeenCalledTimes(0); // no polls before interval fires
  });

  it('stops polling interval on unmount (clears interval)', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);

    const { result, unmount } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    unmount();

    // After unmount, advancing timers should not trigger more polls
    const callCountBefore = mockGetBulkJob.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(mockGetBulkJob.mock.calls.length).toBe(callCountBefore);
  });

  it('reports failure count from completed job status', async () => {
    mockGetActiveBulkJob.mockResolvedValue(null);
    mockGetBulkJob.mockResolvedValue(makeCompletedJob({ completed: 10, total: 10, failures: 3 }));

    const { result } = renderHook(() => useBulkOperation());
    await act(async () => {}); // flush mount

    await act(async () => {
      await result.current.startJob('rename');
    });

    await act(async () => { vi.advanceTimersByTime(2000); });

    expect(result.current.progress.failures).toBe(3);
  });
});
