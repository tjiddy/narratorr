import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { BulkJob, MAX_JOB_FAILURE_DETAILS, type BulkJobFailure, type WorkFn } from './bulk-job.js';

function makeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  } as unknown as FastifyBaseLogger;
}

/** Start a job over a synthetic `WorkFn` and resolve once it has completed. */
function runJob(work: WorkFn): Promise<BulkJob> {
  return new Promise((resolve) => {
    const job = new BulkJob('job-1', 'rename', makeLog(), work, () => resolve(job));
    job.start();
  });
}

function failure(bookId: number, overrides: Partial<BulkJobFailure> = {}): BulkJobFailure {
  return { bookId, title: `Book ${bookId}`, error: 'CONFLICT: target exists', ...overrides };
}

describe('BulkJob — failure-detail accumulation (#2159)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('exposes failureDetails as an empty ARRAY on a clean job (never undefined)', async () => {
    const job = await runJob(async (setTotal, tick) => {
      setTotal(2);
      tick(false);
      tick(false);
    });

    const status = job.getStatus();
    expect(status).toHaveProperty('failureDetails');
    expect(Array.isArray(status.failureDetails)).toBe(true);
    expect(status.failureDetails).toEqual([]);
    expect(status.failures).toBe(0);
  });

  it('accumulates a row for tick(true, detail)', async () => {
    const job = await runJob(async (setTotal, tick) => {
      setTotal(1);
      tick(true, failure(226, { title: "Captain's Fury", error: 'ENOENT: no such file' }));
    });

    expect(job.getStatus().failureDetails).toEqual([
      { bookId: 226, title: "Captain's Fury", error: 'ENOENT: no such file' },
    ]);
  });

  it('counts a bare tick(true) but records no row — failures >= failureDetails.length', async () => {
    const job = await runJob(async (setTotal, tick) => {
      setTotal(3);
      tick(true);
      tick(true, failure(2));
      tick(true);
    });

    const status = job.getStatus();
    expect(status.failures).toBe(3);
    expect(status.failureDetails).toEqual([failure(2)]);
    expect(status.failures).toBeGreaterThanOrEqual(status.failureDetails.length);
  });

  it('IGNORES a detail passed alongside a success tick', async () => {
    const job = await runJob(async (setTotal, tick) => {
      setTotal(1);
      tick(false, failure(5));
    });

    const status = job.getStatus();
    expect(status.failures).toBe(0);
    expect(status.failureDetails).toEqual([]);
    expect(status.completed).toBe(1);
  });

  it('retains the FIRST 50 details while the count stays uncapped', async () => {
    const job = await runJob(async (setTotal, tick) => {
      setTotal(60);
      for (let bookId = 1; bookId <= 60; bookId++) tick(true, failure(bookId));
    });

    const status = job.getStatus();
    expect(status.failures).toBe(60);
    expect(status.failureDetails).toHaveLength(MAX_JOB_FAILURE_DETAILS);
    expect(status.failureDetails[0]!.bookId).toBe(1);
    expect(status.failureDetails.at(-1)!.bookId).toBe(50);
    // The 51st book is dropped — proving the head is retained, not the tail.
    expect(status.failureDetails.map(d => d.bookId)).not.toContain(51);
    expect(status.failureDetails.map(d => d.bookId)).not.toContain(60);
  });

  it('returns the PARTIAL list mid-run and the final list after completion', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let observedMidRun!: BulkJobFailure[];

    const job = new BulkJob('job-2', 'retag', makeLog(), async (setTotal, tick) => {
      setTotal(2);
      tick(true, failure(1));
      // Hold the FINAL iteration pending rather than counting calls — an order-blind call count
      // cannot tell "the list grew as the job ran" from "the list appeared at the end".
      await held;
      tick(true, failure(2));
    }, () => {});
    job.start();

    await vi.waitFor(() => {
      observedMidRun = job.getStatus().failureDetails;
      expect(observedMidRun).toHaveLength(1);
    });
    expect(job.getStatus().status).toBe('running');
    expect(observedMidRun[0]!.bookId).toBe(1);

    release();
    await vi.waitFor(() => { expect(job.getStatus().status).toBe('completed'); });
    expect(job.getStatus().failureDetails.map(d => d.bookId)).toEqual([1, 2]);
  });

  it('hands out a COPY — a status already returned does not grow as later books fail', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const job = new BulkJob('job-3', 'write_metadata_sidecars', makeLog(), async (setTotal, tick) => {
      setTotal(2);
      tick(true, failure(1));
      await held;
      tick(true, failure(2));
    }, () => {});
    job.start();

    let snapshot!: BulkJobFailure[];
    await vi.waitFor(() => {
      snapshot = job.getStatus().failureDetails;
      expect(snapshot).toHaveLength(1);
    });

    release();
    await vi.waitFor(() => { expect(job.getStatus().status).toBe('completed'); });
    expect(snapshot).toHaveLength(1);
  });
});
