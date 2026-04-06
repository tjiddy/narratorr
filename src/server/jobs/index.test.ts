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
vi.mock('./search.js', () => ({ runSearchJob: vi.fn() }));
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
    expect(qgCalls[1]).toBeLessThan(ioCalls[1]);
    expect(ioCalls[1]).toBeLessThan(dcOrder);
    expect(dcOrder).toBeLessThan(diOrder);
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

      expect(log.error).toHaveBeenCalledWith(error, 'monitor job error');
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
      expect(log.error).toHaveBeenCalledWith(jobError, 'search job error');

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
      expect(qgOrder).toBeLessThan(ioOrder);
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
