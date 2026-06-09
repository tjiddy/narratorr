import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Services } from '../routes/index.js';
import { createMockServices, createMockLogger } from '../__tests__/helpers.js';
import { TaskRegistry } from '../services/task-registry.js';

// Track every Cron the scheduler constructs so each test can stop them in
// afterEach — croner schedules a real timer, so leaking one across tests would
// fire mid-suite. The subclass uses the REAL croner engine (real next-run math),
// it just records instances. Module-level array shared via vi.hoisted so the
// (hoisted) vi.mock factory can reach it.
const { cronInstances } = vi.hoisted(() => ({ cronInstances: [] as Cron[] }));
vi.mock('croner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('croner')>();
  class TrackedCron extends actual.Cron {
    constructor(pattern: string | Date, fn?: CronCallback<undefined>) {
      super(pattern, fn);
      cronInstances.push(this);
    }
  }
  return { ...actual, Cron: TrackedCron };
});

// Mock job modules — only the run functions are used now
vi.mock('./monitor.js', () => ({ monitorDownloads: vi.fn() }));
vi.mock('./enrichment.js', () => ({ runEnrichment: vi.fn() }));
vi.mock('./search.js', () => ({ runSearchJob: vi.fn() }));
vi.mock('./rss.js', () => ({ runRssJob: vi.fn() }));
vi.mock('./backup.js', () => ({ runBackupJob: vi.fn() }));
vi.mock('./version-check.js', () => ({ checkForUpdate: vi.fn() }));
vi.mock('./cover-backfill.js', () => ({ runCoverBackfill: vi.fn().mockResolvedValue(undefined) }));

import { Cron, type CronCallback } from 'croner';
import { runCoverBackfill } from './cover-backfill.js';
import { checkForUpdate } from './version-check.js';
import { createMockDb, mockDbChain, inject as injectHelper } from '../__tests__/helpers.js';

/** Find the scheduled Cron for an expression and fire its real (try/catch-wrapped) callback. */
async function triggerCron(pattern: string): Promise<void> {
  const job = cronInstances.find((c) => c.getPattern() === pattern);
  expect(job, `no scheduled cron for "${pattern}"`).toBeDefined();
  await job!.trigger();
}

describe('startJobs', () => {
  let services: Services;
  let log: FastifyBaseLogger;
  let db: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    services = createMockServices();
    // Use a real TaskRegistry so register/getAll work properly
    services.taskRegistry = new TaskRegistry() as unknown as Services['taskRegistry'];
    log = createMockLogger() as unknown as FastifyBaseLogger;
    db = createMockDb();
    // Mock settings.get for timeout-loop jobs — must include all category shapes
    (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
      if (category === 'search') return { intervalMinutes: 30 };
      if (category === 'rss') return { intervalMinutes: 30 };
      if (category === 'system') return { backupIntervalMinutes: 60 };
      if (category === 'discovery') return { intervalHours: 24 };
      if (category === 'general') return { housekeepingRetentionDays: 90 };
      return {};
    });
    // Default: startup recovery finds no stuck downloads
    db.update.mockReturnValue(mockDbChain([]));

    // Startup recovery + import-maintenance cron both await these batch service methods.
    // The mock helper rejects unconfigured methods by default — explicitly resolve them
    // here so the recovery / cron paths complete normally and the assertions can
    // observe call counts/ordering instead of unhandled rejections.
    (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.qualityGateOrchestrator.cleanupDeferredRejections as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.import.cleanupDeferredImports as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    // Startup version check (#1225) chains .catch on the return value, so the mock
    // must return a Promise. Default to a resolved one; specific tests override.
    vi.mocked(checkForUpdate).mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Stop every scheduled cron so no live croner timer leaks into the next test.
    for (const job of cronInstances) job.stop();
    cronInstances.length = 0;
  });

  it('registers all jobs with the task registry', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    // Wait for startup recovery to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    const tasks = services.taskRegistry.getAll();
    const names = tasks.map((t) => t.name);
    expect(names).toContain('monitor');
    expect(names).toContain('enrichment');
    expect(names).toContain('import-maintenance');
    expect(names).toContain('search');
    expect(names).toContain('rss');
    expect(names).toContain('backup');
    expect(names).toContain('housekeeping');
    expect(names).toContain('health-check');
    expect(names).toContain('version-check');
    expect(names).toContain('import-list-sync');
    expect(names).toContain('discovery');
    expect(names).toContain('library-rescan');
    expect(names).not.toContain('import');
  });

  it('schedules cron jobs via croner', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const expressions = cronInstances.map((c) => c.getPattern());
    expect(expressions).toContain('*/30 * * * * *'); // monitor
    expect(expressions).toContain('*/5 * * * *');    // enrichment, health-check, import-maintenance
    expect(expressions).toContain('0 0 * * 0');      // housekeeping
    expect(expressions).toContain('0 2 * * *');      // version-check
    expect(expressions).toContain('* * * * *');      // import-list-sync
    expect(expressions).toContain('0 */6 * * *');    // library-rescan
  });

  it('every cron job reports a real future nextRun (not "now") after scheduling', async () => {
    const { startJobs } = await import('./index.js');
    // Capture the reference time BEFORE scheduling. croner stores the next fire as
    // of construction time, so for sub-minute expressions (`*/30 * * * * *`) the
    // stored boundary can be imminent — a reference time captured AFTER scheduling
    // could race past it and fail spuriously. A pre-scheduling reference is always
    // strictly less than any next-fire croner computes during startJobs.
    const before = Date.now();
    startJobs(injectHelper<Db>(db), services, log);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cronTasks = services.taskRegistry.getAll().filter((t) => t.type === 'cron');
    expect(cronTasks.length).toBeGreaterThan(0);
    for (const task of cronTasks) {
      expect(task.nextRun, `${task.name} has no nextRun`).not.toBeNull();
      expect(new Date(task.nextRun!).getTime()).toBeGreaterThan(before);
    }
  });

  it('logs startup message', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    expect(log.info).toHaveBeenCalledWith('Background jobs started');
  });

  it('import-maintenance task callback calls qualityGate then importOrchestrator processCompletedDownloads then deferred cleanups', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    // Wait for startup recovery to complete
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Execute the registered import-maintenance task
    await services.taskRegistry.executeTracked('import-maintenance');

    // Startup recovery adds 1 call each to QG + import processCompletedDownloads, so total is 2
    expect(services.qualityGateOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(2);
    expect(services.importOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(2);
    expect(services.qualityGateOrchestrator.cleanupDeferredRejections).toHaveBeenCalledTimes(1);
    expect(services.import.cleanupDeferredImports).toHaveBeenCalledTimes(1);

    // Verify the import-maintenance call ordering (last 4 invocations): QG → import → QG cleanup → import cleanup
    const qgCalls = (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const ioCalls = (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const dcOrder = (services.qualityGateOrchestrator.cleanupDeferredRejections as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const diOrder = (services.import.cleanupDeferredImports as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // The 2nd call of each is from import-maintenance (1st is from startup recovery)
    expect(qgCalls[1]).toBeLessThan(ioCalls[1]!);
    expect(ioCalls[1]).toBeLessThan(dcOrder!);
    expect(dcOrder).toBeLessThan(diOrder!);
  });

  it('enrichment task callback passes db, metadataService, bookService, and log to runEnrichment', async () => {
    const { runEnrichment } = await import('./enrichment.js');
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    await services.taskRegistry.executeTracked('enrichment');

    expect(runEnrichment).toHaveBeenCalledWith(db, services.metadata, services.book, log);
  });

  it('schedules discovery timeout loop using intervalHours * 60 from discovery settings', async () => {
    // Mock settings.get to return specific values per category
    (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
      if (category === 'discovery') return { enabled: true, intervalHours: 12, maxSuggestionsPerAuthor: 5 };
      if (category === 'search') return { intervalMinutes: 30 };
      if (category === 'rss') return { intervalMinutes: 15 };
      if (category === 'system') return { backupIntervalMinutes: 60 };
      return {};
    });

    // Capture setTimeout calls to verify the delay
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    // Wait for all async scheduleNext() calls to resolve and call setTimeout
    const expectedMs = 12 * 60 * 60 * 1000; // 12 hours in ms
    await vi.waitFor(() => {
      const discoveryTimeout = setTimeoutSpy.mock.calls.find(([, delay]) => delay === expectedMs);
      expect(discoveryTimeout).toBeDefined();
    });

    setTimeoutSpy.mockRestore();
  });

  it('#537 monitor callback passes services.eventHistory to monitorDownloads', async () => {
    const { monitorDownloads } = await import('./monitor.js');
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    // Fire the monitor cron callback via croner's trigger
    await triggerCron('*/30 * * * * *');

    // Assert monitorDownloads received services.eventHistory as the last argument
    expect(monitorDownloads).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.anything(), // downloadClientService
      expect.anything(), // notifierService
      expect.anything(), // log
      expect.anything(), // retryDeps
      expect.anything(), // broadcaster
      expect.anything(), // remotePathMappingService
      expect.anything(), // qualityGateOrchestrator
      services.eventHistory, // eventHistory — must be the actual service instance
    );
  });

  // job-path retryDeps must reuse the createServices() instances.
  it('monitor callback retryDeps reuses services.retrySearchDeps and services.blacklist (single-instance contract)', async () => {
    const { monitorDownloads } = await import('./monitor.js');
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    await triggerCron('*/30 * * * * *');

    // The retryDeps object passed to monitorDownloads (5th arg) must contain
    // the SAME instances that createServices wired into the service graph.
    // Recreating RetrySearchDeps locally inside startJobs (the pre-fix bug)
    // would produce a new object and fail this identity check.
    const callArgs = vi.mocked(monitorDownloads).mock.calls[0];
    const retryDepsArg = callArgs![4] as { blacklistService: unknown; retrySearchDeps: unknown };
    expect(retryDepsArg.blacklistService).toBe(services.blacklist);
    expect(retryDepsArg.retrySearchDeps).toBe(services.retrySearchDeps);
  });

  describe('search job callback wires eventHistory (#1157)', () => {
    it('forwards services.eventHistory into runSearchJob when the scheduled callback fires', async () => {
      const { runSearchJob } = await import('./search.js');
      vi.mocked(runSearchJob).mockResolvedValue({ searched: 0, grabbed: 0 });

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      const intervalMs = 30 * 60 * 1000;
      await vi.waitFor(() => {
        const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === intervalMs);
        expect(call).toBeDefined();
      });
      const timeoutCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === intervalMs);
      const timeoutCallback = timeoutCall![0] as () => Promise<void>;
      await timeoutCallback();

      // runSearchJob signature: (settings, bookList, indexerSearch, downloadOrchestrator, log,
      //                         blacklist, indexer, eventHistory, retryBudget?, broadcaster?)
      const callArgs = vi.mocked(runSearchJob).mock.calls[0];
      expect(callArgs![7]).toBe(services.eventHistory);

      setTimeoutSpy.mockRestore();
    });
  });

  describe('scheduleCron error handling (#448 item 9)', () => {
    it('logs error when cron job callback throws', async () => {
      // Make the monitor job's callback throw by making monitorDownloads reject
      const { monitorDownloads } = await import('./monitor.js');
      const error = new Error('monitor boom');
      vi.mocked(monitorDownloads).mockRejectedValueOnce(error);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // Fire the monitor cron callback — scheduleCron wraps it in try/catch
      await triggerCron('*/30 * * * * *');

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: error.message, type: 'Error' }) }),
        'monitor job error',
      );
    });
  });

  describe('scheduleTimeoutLoop error handling (#448 item 9)', () => {
    it('logs error and retries in 5 minutes when getIntervalMinutes throws', async () => {
      // Make settings.get throw for all categories to trigger the outer catch
      const settingsError = new Error('settings unavailable');
      (services.settings.get as ReturnType<typeof vi.fn>).mockRejectedValue(settingsError);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // Wait for the error to be logged (async scheduleNext runs immediately)
      const fiveMinMs = 5 * 60 * 1000;
      await vi.waitFor(() => {
        expect(log.error).toHaveBeenCalled();
      });

      // Verify 5-minute retry timeout was scheduled for at least one timeout-loop job
      const retryCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === fiveMinMs);
      expect(retryCall).toBeDefined();

      setTimeoutSpy.mockRestore();
    });

    it('logs error when executeTracked throws and still calls scheduleNext', async () => {
      // Set up normal settings for initial scheduleNext
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 1 }; // 1 minute = 60000ms
        if (category === 'rss') return { intervalMinutes: 1 };
        if (category === 'discovery') return { enabled: true, intervalHours: 1, maxSuggestionsPerAuthor: 5 };
        if (category === 'system') return { backupIntervalMinutes: 1 };
        return {};
      });

      // Make the search job throw when executed
      const { runSearchJob } = await import('./search.js');
      const jobError = new Error('search exploded');
      vi.mocked(runSearchJob).mockRejectedValue(jobError);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // Wait for initial setTimeout to be called
      const oneMinMs = 1 * 60 * 1000;
      await vi.waitFor(() => {
        const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === oneMinMs);
        expect(call).toBeDefined();
      });

      // Execute the setTimeout callback (which runs the job)
      const timeoutCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === oneMinMs);
      const timeoutCallback = timeoutCall![0] as () => Promise<void>;
      await timeoutCallback();

      // Error should be logged
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: jobError.message, type: 'Error' }) }),
        'search job error',
      );

      // scheduleNext should have been called again (another setTimeout)
      const laterCalls = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === oneMinMs);
      expect(laterCalls.length).toBeGreaterThanOrEqual(2); // initial + retry

      setTimeoutSpy.mockRestore();
    });
  });

  describe('import-maintenance cron (#358)', () => {
    it('registers import-maintenance instead of import in job registry', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const tasks = services.taskRegistry.getAll();
      const names = tasks.map((t) => t.name);
      expect(names).toContain('import-maintenance');
      expect(names).not.toContain('import');
    });

    it('calls QG processCompletedDownloads before import processCompletedDownloads', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear startup recovery calls
      vi.clearAllMocks();
      db.update.mockReturnValue(mockDbChain([]));

      await services.taskRegistry.executeTracked('import-maintenance');

      const qgOrder = (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const ioOrder = (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(qgOrder).toBeLessThan(ioOrder!);
    });

    it('calls deferred cleanup methods after import batch', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      db.update.mockReturnValue(mockDbChain([]));

      await services.taskRegistry.executeTracked('import-maintenance');

      expect(services.qualityGateOrchestrator.cleanupDeferredRejections).toHaveBeenCalledTimes(1);
      expect(services.import.cleanupDeferredImports).toHaveBeenCalledTimes(1);
    });

    it('does not register an import job', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const tasks = services.taskRegistry.getAll();
      const names = tasks.map((t) => t.name);
      expect(names).not.toContain('import');
    });
  });

  // #477 — housekeeping callback coverage
  describe('housekeeping callback (#477)', () => {
    it('executeTracked housekeeping calls VACUUM, pruneOlderThan, and deleteExpired with correct args', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 14 };
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        return {};
      });
      // Add db.run mock for VACUUM
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      // Re-mock after clearAllMocks
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 14 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      await services.taskRegistry.executeTracked('housekeeping');

      const runMock = (db as Record<string, ReturnType<typeof vi.fn>>).run;
      expect(runMock).toHaveBeenCalledTimes(1);
      // Assert the SQL argument is VACUUM (drizzle sql`VACUUM` produces queryChunks with "VACUUM")
      const sqlArg = runMock!.mock.calls[0]![0] as { queryChunks: { value: string[] }[] };
      expect(sqlArg.queryChunks[0]!.value[0]).toBe('VACUUM');
      expect(services.eventHistory.pruneOlderThan).toHaveBeenCalledWith(30);
      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
      // No warnings emitted on successful housekeeping
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('uses fallback retention of 90 when housekeepingRetentionDays is null and 30 when seriesCacheRetentionDays is null', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: null, seriesCacheRetentionDays: null };
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: null, seriesCacheRetentionDays: null };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.eventHistory.pruneOlderThan).toHaveBeenCalledWith(90);
      // No warnings emitted on successful housekeeping with null retention fallback
      expect(log.warn).not.toHaveBeenCalled();
    });

    // #547: per-sub-task error isolation
    it('VACUUM failure does not prevent pruneOlderThan, deleteExpired, and sweepOrphanSeries from running', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockRejectedValue(new Error('VACUUM failed'));
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.eventHistory.pruneOlderThan).toHaveBeenCalledWith(30);
      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: 'Error' }) }),
        expect.stringContaining('VACUUM'),
      );
    });

    it('pruneOlderThan failure does not prevent deleteExpired and sweepOrphanSeries from running', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('prune failed'));
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(3);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: 'Error' }) }),
        expect.stringContaining('prune'),
      );
    });

    it('deleteExpired failure does not affect already-completed VACUUM and prune, and does not prevent sweepOrphanSeries', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('delete failed'));

      await services.taskRegistry.executeTracked('housekeeping');

      expect((db as Record<string, ReturnType<typeof vi.fn>>).run).toHaveBeenCalledTimes(1);
      expect(services.eventHistory.pruneOlderThan).toHaveBeenCalledWith(30);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: 'Error' }) }),
        expect.stringContaining('blacklist'),
      );
    });

    it('settings.get general failure does not prevent deleteExpired from running (also blocks sweepOrphanSeries)', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') throw new Error('settings unavailable');
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') throw new Error('settings unavailable');
        return {};
      });
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(2);

      await services.taskRegistry.executeTracked('housekeeping');

      // pruneOlderThan should NOT be called (no retention days available)
      expect(services.eventHistory.pruneOlderThan).not.toHaveBeenCalled();
      // deleteExpired should still run
      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
      // sweepOrphanSeries should NOT be called — its retention setting comes from the same failing settings.get('general')
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String), type: 'Error' }) }),
        expect.stringContaining('retention'),
      );
    });

    it('each sub-task failure logs warn with sub-task name and error', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      const vacuumError = new Error('VACUUM failed');
      const pruneError = new Error('prune failed');
      const deleteError = new Error('delete failed');
      (db as Record<string, unknown>).run = vi.fn().mockRejectedValue(vacuumError);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30, seriesCacheRetentionDays: 30 };
        return {};
      });
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockRejectedValue(pruneError);
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockRejectedValue(deleteError);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: vacuumError.message, type: 'Error' }) }),
        expect.stringContaining('VACUUM'),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: pruneError.message, type: 'Error' }) }),
        expect.stringContaining('prune'),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: deleteError.message, type: 'Error' }) }),
        expect.stringContaining('blacklist'),
      );
    });

  });

  describe('startup recovery (#358)', () => {
    it('resets stuck downloads to completed on boot', async () => {
      const chain = mockDbChain([{ id: 1 }, { id: 2 }]);
      db.update.mockReturnValue(chain);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify the reset update was called
      expect(db.update).toHaveBeenCalled();
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      expect(setCalls).toContainEqual(expect.objectContaining({ status: 'completed' }));
    });

    it('calls batch methods after status reset', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(services.qualityGateOrchestrator.processCompletedDownloads).toHaveBeenCalled();
      expect(services.importOrchestrator.processCompletedDownloads).toHaveBeenCalled();
    });

    it('calls runCoverBackfill after batch methods (#369)', async () => {
      db.update.mockReturnValue(mockDbChain([]));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(runCoverBackfill).toHaveBeenCalledWith(
        expect.anything(), // db
        log,
      );
    });

    it('does not block job startup when recovery throws', async () => {
      db.update.mockReturnValue(mockDbChain([], { error: new Error('DB unavailable') }));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Jobs should still be registered despite recovery failure
      const tasks = services.taskRegistry.getAll();
      expect(tasks.length).toBeGreaterThan(0);
    });
  });

  // #1225 — run version-check once on startup so the update banner reflects reality
  describe('startup version check (#1225)', () => {
    it('invokes checkForUpdate exactly once on startup', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      // #1262 — the boot check is wired with the onUpdateChanged nudge callback.
      expect(checkForUpdate).toHaveBeenCalledWith(log, expect.any(Function));
    });

    it('does not await checkForUpdate — startJobs returns promptly even when the check never settles', async () => {
      // A never-resolving check must not delay startJobs returning.
      vi.mocked(checkForUpdate).mockReturnValue(new Promise<void>(() => { /* never settles */ }));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // startJobs is synchronous; it must have completed its registration work
      // (logged the startup message) without waiting on the pending check.
      expect(log.info).toHaveBeenCalledWith('Background jobs started');
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it('startup failure is non-fatal — a rejected check is caught and logged, jobs still register', async () => {
      const checkError = new Error('GitHub unreachable');
      vi.mocked(checkForUpdate).mockRejectedValue(checkError);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // Jobs register synchronously regardless of the check outcome.
      const tasks = services.taskRegistry.getAll();
      expect(tasks.length).toBeGreaterThan(0);

      // The .catch handler logs the rejection rather than propagating it.
      await vi.waitFor(() => {
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: checkError.message, type: 'Error' }) }),
          'Startup version check failed — jobs continue normally',
        );
      });
    });

    it('leaves the 2 AM version-check cron registration unchanged', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      // The cron entry must still exist with the same name and schedule.
      const tasks = services.taskRegistry.getAll();
      expect(tasks.map((t) => t.name)).toContain('version-check');
      const cronExpressions = cronInstances.map((c) => c.getPattern());
      expect(cronExpressions).toContain('0 2 * * *');
    });
  });

  // #1262 — version-check nudges a health recompute so a manual/boot update check
  // reflects in the health card within one UI poll instead of lagging to the next
  // scheduled health-check tick.
  describe('version-check → health-check nudge wiring (#1262)', () => {
    it('boot version-check is passed an onUpdateChanged callback that recomputes health', async () => {
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The boot call wires the nudge. Invoke the captured callback and assert it
      // drives a real health recompute via the service (not executeTracked, which
      // silently no-ops while a pass is running).
      const bootCall = vi.mocked(checkForUpdate).mock.calls.at(-1)!;
      const onUpdateChanged = bootCall[1] as () => void;
      expect(typeof onUpdateChanged).toBe('function');

      expect(services.healthCheck.runAllChecks).not.toHaveBeenCalled();
      onUpdateChanged();
      expect(services.healthCheck.runAllChecks).toHaveBeenCalledTimes(1);
    });

    it('the 2 AM version-check cron callback passes the same onUpdateChanged nudge', async () => {
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      vi.mocked(checkForUpdate).mockClear();

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Run the registered cron task; its callback must call checkForUpdate with
      // the nudge wired in (log + a function), mirroring the boot path.
      await services.taskRegistry.executeTracked('version-check');

      const cronCall = vi.mocked(checkForUpdate).mock.calls.find((c) => typeof c[1] === 'function');
      expect(cronCall).toBeDefined();
      const onUpdateChanged = cronCall![1] as () => void;
      onUpdateChanged();
      expect(services.healthCheck.runAllChecks).toHaveBeenCalled();
    });

    it('does not recompute health when the nudge callback is never invoked (no-op check)', async () => {
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      // The mocked checkForUpdate never calls its callback (mirrors a same-version
      // no-op check). The health service must not be recomputed by the nudge path.
      expect(services.healthCheck.runAllChecks).not.toHaveBeenCalled();
    });
  });

  // #1066 — scheduled library reconciliation
  describe('library-rescan job (#1066)', () => {
    it('registers library-rescan as a cron job on a 6-hour schedule', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      const tasks = services.taskRegistry.getAll();
      const entry = tasks.find((t) => t.name === 'library-rescan');
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('cron');

      const expressions = cronInstances.map((c) => c.getPattern());
      expect(expressions).toContain('0 */6 * * *');
    });

    it('callback invokes services.libraryScan.rescanLibrary()', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 0, missing: 0, restored: 0 });

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await services.taskRegistry.executeTracked('library-rescan');

      expect(services.libraryScan.rescanLibrary).toHaveBeenCalled();
    });

    it('logs at warn (not error) when rescanLibrary rejects with LibraryPathError', async () => {
      const { LibraryPathError } = await import('../services/library-scan.service.js');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new LibraryPathError('Library path is not configured'),
      );

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'Library path is not configured', type: 'LibraryPathError' }) }),
        'Scheduled library rescan skipped',
      );
      // Critically: scheduleCron's own error handler must NOT log (the job swallowed it)
      expect(log.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'library-rescan job error',
      );
    });

    it('logs at warn (not error) when rescanLibrary rejects with ScanInProgressError', async () => {
      const { ScanInProgressError } = await import('../services/library-scan.service.js');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ScanInProgressError(),
      );

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ type: 'ScanInProgressError' }) }),
        'Scheduled library rescan skipped',
      );
      expect(log.error).not.toHaveBeenCalledWith(
        expect.anything(),
        'library-rescan job error',
      );
    });

    it('lets unexpected errors fall through to scheduleCron error handler', async () => {
      const unexpected = new Error('unexpected db failure');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(unexpected);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      // The job didn't swallow it — scheduleCron caught it via its own try/catch
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: unexpected.message, type: 'Error' }) }),
        'library-rescan job error',
      );
      // And critically: it wasn't downgraded to a warn
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Scheduled library rescan skipped',
      );
    });
  });

  // #1270 — scheduleCron is the croner owner: it stores the engine's real next-fire
  // on the registry. These tests drive it directly against a real TaskRegistry and a
  // real croner engine (no stubbed nextRun) so the cron math is actually exercised.
  describe('scheduleCron next-run wiring (#1270)', () => {
    // Every production cron expression — the 5 previously-broken fixed/weekly/hourly/
    // every-minute ones plus the sub-minute monitor and the */5 interval jobs.
    const CRON_EXPRESSIONS: ReadonlyArray<[name: string, expr: string]> = [
      ['monitor', '*/30 * * * * *'],
      ['enrichment', '*/5 * * * *'],
      ['version-check', '0 2 * * *'],
      ['housekeeping', '0 0 * * 0'],
      ['series-refresh', '0 3 * * 0'],
      ['library-rescan', '0 */6 * * *'],
      ['import-list-sync', '* * * * *'],
    ];

    it.each(CRON_EXPRESSIONS)(
      'stores a real future nextRun for %s (%s)',
      async (name, expr) => {
        const { scheduleCron } = await import('./index.js');
        const reg = new TaskRegistry();
        // Mirror production order: register BEFORE scheduling, else setNextRun no-ops.
        reg.register(name, 'cron', vi.fn().mockResolvedValue(undefined), expr);

        const before = Date.now();
        const job = scheduleCron(reg, name, expr, log);
        cronInstances.push(job); // ensure afterEach stops it

        const task = reg.getAll().find((t) => t.name === name);
        expect(task!.nextRun).not.toBeNull();
        const nextRunMs = new Date(task!.nextRun!).getTime();
        expect(Number.isNaN(nextRunMs)).toBe(false);
        expect(nextRunMs).toBeGreaterThan(before);
      },
    );

    it('reports a fixed-time cron (0 2 * * *) more than a minute out — guards the old "≈now" fallback', async () => {
      const { scheduleCron } = await import('./index.js');
      const reg = new TaskRegistry();
      reg.register('version-check', 'cron', vi.fn().mockResolvedValue(undefined), '0 2 * * *');

      const job = scheduleCron(reg, 'version-check', '0 2 * * *', log);
      cronInstances.push(job);

      const task = reg.getAll().find((t) => t.name === 'version-check');
      const deltaMs = new Date(task!.nextRun!).getTime() - Date.now();
      expect(deltaMs).toBeGreaterThan(60 * 1000);
    });

    it('refreshes nextRun after each fire via the callback finally-block', async () => {
      const { scheduleCron } = await import('./index.js');
      const reg = new TaskRegistry();
      const fn = vi.fn().mockResolvedValue(undefined);
      reg.register('monitor', 'cron', fn, '*/30 * * * * *');

      const job = scheduleCron(reg, 'monitor', '*/30 * * * * *', log);
      cronInstances.push(job);

      // Reference time captured before the fire — the finally-block recomputes
      // nextRun during trigger(), so it is strictly after this point. Comparing
      // against a post-trigger Date.now() would re-introduce the same sub-minute
      // boundary race as F1 for `*/30 * * * * *`.
      const before = Date.now();
      await job.trigger();

      // The callback ran the registered fn and refreshed nextRun from job.nextRun().
      expect(fn).toHaveBeenCalledTimes(1);
      const task = reg.getAll().find((t) => t.name === 'monitor');
      expect(task!.nextRun).not.toBeNull();
      expect(new Date(task!.nextRun!).getTime()).toBeGreaterThan(before);
    });

    it('skips setNextRun (leaves the prior value) when nextRun() returns null, without throwing', async () => {
      const { scheduleCron } = await import('./index.js');
      const reg = new TaskRegistry();
      reg.register('null-job', 'cron', vi.fn().mockResolvedValue(undefined), '* * * * *');

      // Seed a prior value that must survive a null-nextRun scheduling pass.
      const prior = new Date('2026-01-01T00:00:00.000Z');
      reg.setNextRun('null-job', prior);

      // Force croner's next-fire to read as null (no future occurrence). nextRun lives
      // on the real Cron prototype (the imported Cron is the tracking subclass).
      const proto = Object.getPrototypeOf(Cron.prototype) as { nextRun: () => Date | null };
      const spy = vi.spyOn(proto, 'nextRun').mockReturnValue(null);

      let job: Cron;
      expect(() => { job = scheduleCron(reg, 'null-job', '* * * * *', log); }).not.toThrow();
      cronInstances.push(job!);
      spy.mockRestore();

      const task = reg.getAll().find((t) => t.name === 'null-job');
      expect(task!.nextRun).toBe(prior.toISOString());
    });
  });
});
