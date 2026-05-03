import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Services } from '../routes/index.js';
import { createMockServices, createMockLogger } from '../__tests__/helpers.js';
import { TaskRegistry } from '../services/task-registry.js';

// Mock node-cron to prevent real scheduling
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

// Mock job modules — only the run functions are used now
vi.mock('./monitor.js', () => ({ monitorDownloads: vi.fn() }));
vi.mock('./enrichment.js', () => ({ runEnrichment: vi.fn() }));
vi.mock('./search.js', () => ({ runSearchJob: vi.fn(), runUpgradeSearchJob: vi.fn() }));
vi.mock('./rss.js', () => ({ runRssJob: vi.fn() }));
vi.mock('./backup.js', () => ({ runBackupJob: vi.fn() }));
vi.mock('./version-check.js', () => ({ checkForUpdate: vi.fn() }));
vi.mock('./cover-backfill.js', () => ({ runCoverBackfill: vi.fn().mockResolvedValue(undefined) }));

import cron from 'node-cron';
import { runCoverBackfill } from './cover-backfill.js';
import { createMockDb, mockDbChain, inject as injectHelper } from '../__tests__/helpers.js';

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
    expect(names).toContain('upgrade-search');
    expect(names).toContain('rss');
    expect(names).toContain('backup');
    expect(names).toContain('housekeeping');
    expect(names).toContain('health-check');
    expect(names).toContain('version-check');
    expect(names).toContain('import-list-sync');
    expect(names).toContain('discovery');
    expect(names).not.toContain('import');
  });

  it('schedules cron jobs via cron.schedule', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cronCalls = vi.mocked(cron.schedule).mock.calls;
    const expressions = cronCalls.map(([expr]) => expr);
    expect(expressions).toContain('*/30 * * * * *'); // monitor
    expect(expressions).toContain('*/5 * * * *');    // enrichment, health-check
    expect(expressions).toContain('*/5 * * * *');    // import-maintenance (shares schedule with enrichment, health-check)
    expect(expressions).toContain('0 0 * * 0');      // housekeeping
    expect(expressions).toContain('0 2 * * *');      // version-check
    expect(expressions).toContain('* * * * *');      // import-list-sync
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

  // #755 Wave 11.2 — upgrade-search wired into the registry as a `timeout` job
  // sharing the search.intervalMinutes cadence with the regular search job.
  describe('upgrade-search task (#755)', () => {
    it('registers upgrade-search as a timeout job', async () => {
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const tasks = services.taskRegistry.getAll();
      const entry = tasks.find((t) => t.name === 'upgrade-search');
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('timeout');
    });

    it('callback invokes runUpgradeSearchJob with services.settings, services.book, services.indexerSearch, services.downloadOrchestrator, log', async () => {
      const { runUpgradeSearchJob } = await import('./search.js');
      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await services.taskRegistry.executeTracked('upgrade-search');

      expect(runUpgradeSearchJob).toHaveBeenCalledWith(
        services.settings,
        services.book,
        services.indexerSearch,
        services.downloadOrchestrator,
        log,
      );
    });

    it('reads cadence from search.intervalMinutes (shared with the search job)', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 17 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 90 };
        return {};
      });

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      const expectedMs = 17 * 60 * 1000;
      // Both `search` and `upgrade-search` schedule with this delay; assert at
      // least two scheduling calls land on it (search + upgrade-search).
      await vi.waitFor(() => {
        const matches = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === expectedMs);
        expect(matches.length).toBeGreaterThanOrEqual(2);
      });

      setTimeoutSpy.mockRestore();
    });
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

    // Find and execute the monitor cron callback
    const cronCalls = vi.mocked(cron.schedule).mock.calls;
    const monitorCall = cronCalls.find(([expr]) => expr === '*/30 * * * * *');
    expect(monitorCall).toBeDefined();
    const cronCallback = monitorCall![1] as () => Promise<void>;
    await cronCallback();

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

    const cronCalls = vi.mocked(cron.schedule).mock.calls;
    const monitorCall = cronCalls.find(([expr]) => expr === '*/30 * * * * *');
    expect(monitorCall).toBeDefined();
    const cronCallback = monitorCall![1] as () => Promise<void>;
    await cronCallback();

    // The retryDeps object passed to monitorDownloads (5th arg) must contain
    // the SAME instances that createServices wired into the service graph.
    // Recreating RetrySearchDeps locally inside startJobs (the pre-fix bug)
    // would produce a new object and fail this identity check.
    const callArgs = vi.mocked(monitorDownloads).mock.calls[0];
    const retryDepsArg = callArgs![4] as { blacklistService: unknown; retrySearchDeps: unknown };
    expect(retryDepsArg.blacklistService).toBe(services.blacklist);
    expect(retryDepsArg.retrySearchDeps).toBe(services.retrySearchDeps);
  });

  describe('scheduleCron error handling (#448 item 9)', () => {
    it('logs error when cron job callback throws', async () => {
      // Make the monitor job's callback throw by making monitorDownloads reject
      const { monitorDownloads } = await import('./monitor.js');
      const error = new Error('monitor boom');
      vi.mocked(monitorDownloads).mockRejectedValueOnce(error);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      // Find the cron callback for monitor (first cron.schedule call)
      const cronCalls = vi.mocked(cron.schedule).mock.calls;
      const monitorCall = cronCalls.find(([expr]) => expr === '*/30 * * * * *');
      expect(monitorCall).toBeDefined();

      // Execute the cron callback — scheduleCron wraps it in try/catch
      const cronCallback = monitorCall![1] as () => Promise<void>;
      await cronCallback();

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
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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

    it('uses fallback retention of 90 when housekeepingRetentionDays is null', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: null };
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
        if (category === 'general') return { housekeepingRetentionDays: null };
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
    it('VACUUM failure does not prevent pruneOlderThan and deleteExpired from running', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockRejectedValue(new Error('VACUUM failed'));
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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

    it('pruneOlderThan failure does not prevent deleteExpired from running', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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

    it('deleteExpired failure does not affect already-completed VACUUM and prune', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        if (category === 'general') return { housekeepingRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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

    it('settings.get general failure does not prevent deleteExpired from running', async () => {
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
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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
        if (category === 'general') return { housekeepingRetentionDays: 30 };
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
});
