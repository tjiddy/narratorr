import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import type { Services } from '../services/di.js';
import { createMockServices, createMockLogger } from '../__tests__/helpers.js';
import { TaskRegistry } from '../services/task-registry.js';

// Keep real Cron math, but track instances so afterEach can stop their live timers.
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

// Trigger the real Cron wrapper, not TaskRegistry directly.
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
    services.taskRegistry = new TaskRegistry() as unknown as Services['taskRegistry'];
    log = createMockLogger() as unknown as FastifyBaseLogger;
    db = createMockDb();
    (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
      if (category === 'search') return { intervalMinutes: 30 };
      if (category === 'rss') return { intervalMinutes: 30 };
      if (category === 'system') return { backupIntervalMinutes: 60 };
      if (category === 'discovery') return { intervalHours: 24 };
      if (category === 'general') return { housekeepingRetentionDays: 90 };
      return {};
    });
    db.update.mockReturnValue(mockDbChain([]));

    // The mock helper rejects unconfigured methods by default; explicitly resolve them here.
    (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.qualityGateOrchestrator.cleanupDeferredRejections as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.import.cleanupDeferredImports as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (services.importStaging.sweepStaleReceiving as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    (services.importStaging.pruneCompletedDetails as ReturnType<typeof vi.fn>).mockResolvedValue(0);
    // startJobs attaches .catch to the boot check and invokes this setter synchronously.
    vi.mocked(checkForUpdate).mockResolvedValue(undefined);
    (services.healthCheck.setVersionUpdateCallback as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  afterEach(() => {
    for (const job of cronInstances) job.stop();
    cronInstances.length = 0;
  });

  it('registers all jobs with the task registry', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

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
    // Capture before construction; a sub-minute boundary may pass immediately afterward.
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

    await new Promise((resolve) => setTimeout(resolve, 10));

    await services.taskRegistry.executeTracked('import-maintenance');

    expect(services.qualityGateOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(2);
    expect(services.importOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(2);
    expect(services.qualityGateOrchestrator.cleanupDeferredRejections).toHaveBeenCalledTimes(1);
    expect(services.import.cleanupDeferredImports).toHaveBeenCalledTimes(1);

    const qgCalls = (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const ioCalls = (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    const dcOrder = (services.qualityGateOrchestrator.cleanupDeferredRejections as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const diOrder = (services.import.cleanupDeferredImports as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    // Index 0 is startup recovery; index 1 is import maintenance.
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
    (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
      if (category === 'discovery') return { enabled: true, intervalHours: 12, maxSuggestionsPerAuthor: 5 };
      if (category === 'search') return { intervalMinutes: 30 };
      if (category === 'rss') return { intervalMinutes: 15 };
      if (category === 'system') return { backupIntervalMinutes: 60 };
      return {};
    });

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    const expectedMs = 12 * 60 * 60 * 1000;
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

    await triggerCron('*/30 * * * * *');

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

  it('monitor callback retryDeps reuses services.retrySearchDeps and services.blacklist (single-instance contract)', async () => {
    const { monitorDownloads } = await import('./monitor.js');
    const { startJobs } = await import('./index.js');
    startJobs(injectHelper<Db>(db), services, log);

    await triggerCron('*/30 * * * * *');

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

      // eventHistory is positional argument 7.
      const callArgs = vi.mocked(runSearchJob).mock.calls[0];
      expect(callArgs![7]).toBe(services.eventHistory);

      setTimeoutSpy.mockRestore();
    });
  });

  describe('scheduleCron error handling (#448 item 9)', () => {
    it('logs error when cron job callback throws', async () => {
      const { monitorDownloads } = await import('./monitor.js');
      const error = new Error('monitor boom');
      vi.mocked(monitorDownloads).mockRejectedValueOnce(error);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('*/30 * * * * *');

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: error.message, type: 'Error' }) }),
        'monitor job error',
      );
    });
  });

  describe('scheduleTimeoutLoop error handling (#448 item 9)', () => {
    it('logs error and retries in 5 minutes when getIntervalMinutes throws', async () => {
      const settingsError = new Error('settings unavailable');
      (services.settings.get as ReturnType<typeof vi.fn>).mockRejectedValue(settingsError);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      const fiveMinMs = 5 * 60 * 1000;
      await vi.waitFor(() => {
        expect(log.error).toHaveBeenCalled();
      });

      const retryCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === fiveMinMs);
      expect(retryCall).toBeDefined();

      setTimeoutSpy.mockRestore();
    });

    it('logs error when executeTracked throws and still calls scheduleNext', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'search') return { intervalMinutes: 1 };
        if (category === 'rss') return { intervalMinutes: 1 };
        if (category === 'discovery') return { enabled: true, intervalHours: 1, maxSuggestionsPerAuthor: 5 };
        if (category === 'system') return { backupIntervalMinutes: 1 };
        return {};
      });

      const { runSearchJob } = await import('./search.js');
      const jobError = new Error('search exploded');
      vi.mocked(runSearchJob).mockRejectedValue(jobError);

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      const oneMinMs = 1 * 60 * 1000;
      await vi.waitFor(() => {
        const call = setTimeoutSpy.mock.calls.find(([, delay]) => delay === oneMinMs);
        expect(call).toBeDefined();
      });

      const timeoutCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === oneMinMs);
      const timeoutCallback = timeoutCall![0] as () => Promise<void>;
      await timeoutCallback();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: jobError.message, type: 'Error' }) }),
        'search job error',
      );

      const laterCalls = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === oneMinMs);
      expect(laterCalls.length).toBeGreaterThanOrEqual(2);

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

    it('invokes the staged stale-receiving sweep (F17)', async () => {
      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler.stopAll();

      vi.clearAllMocks();
      db.update.mockReturnValue(mockDbChain([]));
      (services.importStaging.sweepStaleReceiving as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await services.taskRegistry.executeTracked('import-maintenance');

      expect(services.importStaging.sweepStaleReceiving).toHaveBeenCalledTimes(1);
    });

    it('still runs the staged sweep after completed-download processing rejects, and logs its own rejection (F17)', async () => {
      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler.stopAll();

      vi.clearAllMocks();
      db.update.mockReturnValue(mockDbChain([]));
      (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('QG down'));
      (services.importStaging.sweepStaleReceiving as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sweep down'));

      await services.taskRegistry.executeTracked('import-maintenance');

      expect(services.importStaging.sweepStaleReceiving).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String) }) }),
        expect.stringContaining('stale-receiving'),
      );
    });
  });

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
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.clearAllMocks();
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
      // Drizzle stores VACUUM in the first query chunk.
      const sqlArg = runMock!.mock.calls[0]![0] as { queryChunks: { value: string[] }[] };
      expect(sqlArg.queryChunks[0]!.value[0]).toBe('VACUUM');
      expect(services.eventHistory.pruneOlderThan).toHaveBeenCalledWith(30);
      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
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
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('VACUUM failure does not prevent pruneOlderThan, deleteExpired, and sweepOrphanSeries from running', async () => {
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

    it('pruneOlderThan failure does not prevent deleteExpired and sweepOrphanSeries from running', async () => {
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

    it('deleteExpired failure does not affect already-completed VACUUM and prune, and does not prevent sweepOrphanSeries', async () => {
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

      expect(services.eventHistory.pruneOlderThan).not.toHaveBeenCalled();
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

    it('invokes the staged completed-detail prune with the configured retention days (F18)', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 45 };
        if (category === 'search') return { intervalMinutes: 30 };
        if (category === 'rss') return { intervalMinutes: 30 };
        if (category === 'system') return { backupIntervalMinutes: 60 };
        if (category === 'discovery') return { intervalHours: 24 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler.stopAll();

      vi.clearAllMocks();
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 45 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.importStaging.pruneCompletedDetails as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.importStaging.pruneCompletedDetails).toHaveBeenCalledWith(45);
    });

    it('defaults the staged prune to 90 days when housekeepingRetentionDays is null (F18)', async () => {
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
      const scheduler = startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler.stopAll();

      vi.clearAllMocks();
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: null };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.importStaging.pruneCompletedDetails as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.importStaging.pruneCompletedDetails).toHaveBeenCalledWith(90);
    });

    it('runs the staged prune after an event-history failure, and its own failure does not suppress blacklist cleanup (F18)', async () => {
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));
      scheduler.stopAll();

      vi.clearAllMocks();
      (services.settings.get as ReturnType<typeof vi.fn>).mockImplementation(async (category: string) => {
        if (category === 'general') return { housekeepingRetentionDays: 30 };
        return {};
      });
      (db as Record<string, unknown>).run = vi.fn().mockResolvedValue(undefined);
      (services.eventHistory.pruneOlderThan as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('event-history down'));
      (services.importStaging.pruneCompletedDetails as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('staged prune down'));
      (services.blacklist.deleteExpired as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await services.taskRegistry.executeTracked('housekeeping');

      expect(services.importStaging.pruneCompletedDetails).toHaveBeenCalledWith(30);
      expect(services.blacklist.deleteExpired).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: expect.any(String) }) }),
        expect.stringContaining('staged-detail prune'),
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

      expect(db.update).toHaveBeenCalled();
      const setCalls = (chain.set as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
      // Recovery resets pipelineStage only; clientStatus remains completed.
      expect(setCalls).toContainEqual(expect.objectContaining({ pipelineStage: 'idle' }));
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
        services.connector, // enables refresh notifications
      );
    });

    it('does not block job startup when recovery throws', async () => {
      db.update.mockReturnValue(mockDbChain([], { error: new Error('DB unavailable') }));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const tasks = services.taskRegistry.getAll();
      expect(tasks.length).toBeGreaterThan(0);
    });
  });

  describe('startup version check (#1225)', () => {
    it('routes the boot check through runTask and stamps lastRun (#1317)', async () => {
      const runTaskSpy = vi.spyOn(services.taskRegistry, 'runTask');

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(runTaskSpy).toHaveBeenCalledTimes(1);
      expect(runTaskSpy).toHaveBeenCalledWith('version-check');

      expect(checkForUpdate).toHaveBeenCalledTimes(1);
      expect(checkForUpdate).toHaveBeenCalledWith(log, expect.any(Function));

      const versionCheck = services.taskRegistry.getAll().find((t) => t.name === 'version-check');
      expect(versionCheck?.lastRun).not.toBeNull();
    });

    it('does not await checkForUpdate — startJobs returns promptly even when the check never settles', async () => {
      vi.mocked(checkForUpdate).mockReturnValue(new Promise<void>(() => {}));

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      expect(log.info).toHaveBeenCalledWith('Background jobs started');
      expect(checkForUpdate).toHaveBeenCalledTimes(1);
    });

    it('startup failure is non-fatal — a rejected check is caught and logged, jobs still register', async () => {
      const checkError = new Error('GitHub unreachable');
      vi.mocked(checkForUpdate).mockRejectedValue(checkError);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      const tasks = services.taskRegistry.getAll();
      expect(tasks.length).toBeGreaterThan(0);

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

      const tasks = services.taskRegistry.getAll();
      expect(tasks.map((t) => t.name)).toContain('version-check');
      const cronExpressions = cronInstances.map((c) => c.getPattern());
      expect(cronExpressions).toContain('0 2 * * *');
    });
  });

  describe('version-check → health-check nudge wiring (#1262)', () => {
    it('boot version-check is passed an onUpdateChanged callback that recomputes health', async () => {
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

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

      expect(services.healthCheck.runAllChecks).not.toHaveBeenCalled();
    });

    it('registers the version-update nudge on the health service for the manual Run Now path (#1411 AC#5)', async () => {
      const setCb = services.healthCheck.setVersionUpdateCallback as ReturnType<typeof vi.fn>;
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      vi.mocked(checkForUpdate).mockClear();

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(setCb).toHaveBeenCalledTimes(1);
      const registered = setCb.mock.calls[0]![0] as () => void;
      expect(typeof registered).toBe('function');

      // Manual and cron paths must share the same callback reference.
      await services.taskRegistry.executeTracked('version-check');
      const cronCall = vi.mocked(checkForUpdate).mock.calls.find((c) => typeof c[1] === 'function');
      expect(cronCall).toBeDefined();
      expect(cronCall![1]).toBe(registered);
    });

    it('the scheduled health-check cron stays cache-only — it does not fire a version check (#1411 AC#3)', async () => {
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);
      await new Promise((resolve) => setTimeout(resolve, 10));

      vi.mocked(checkForUpdate).mockClear();
      (services.healthCheck.runAllChecks as ReturnType<typeof vi.fn>).mockClear();

      await services.taskRegistry.executeTracked('health-check');

      expect(services.healthCheck.runAllChecks).toHaveBeenCalledTimes(1);
      expect(checkForUpdate).not.toHaveBeenCalled();
    });
  });

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

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: unexpected.message, type: 'Error' }) }),
        'library-rescan job error',
      );
      expect(log.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Scheduled library rescan skipped',
      );
    });

    it('AC9/AC12: a successful scheduled rescan triggers exactly one companion sweep', async () => {
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockResolvedValue({ scanned: 2, missing: 0, restored: 0 });
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await services.taskRegistry.executeTracked('library-rescan');

      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(services.companionEbook.reconcileBook).not.toHaveBeenCalled();
    });

    it('AC12: ScanInProgressError triggers ZERO sweeps and still warns-and-returns', async () => {
      const { ScanInProgressError } = await import('../services/library-scan.service.js');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(new ScanInProgressError());
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      expect(services.companionEbook.reconcileAll).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ type: 'ScanInProgressError' }) }),
        'Scheduled library rescan skipped',
      );
    });

    it('AC12: LibraryPathError DOES sweep and the warn-and-swallow is unchanged', async () => {
      const { LibraryPathError } = await import('../services/library-scan.service.js');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(
        new LibraryPathError('Library path is not configured'),
      );
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ type: 'LibraryPathError' }) }),
        'Scheduled library rescan skipped',
      );
      expect(log.error).not.toHaveBeenCalledWith(expect.anything(), 'library-rescan job error');
    });

    it('AC12: an unexpected error DOES sweep and still falls through to the cron error handler', async () => {
      const unexpected = new Error('unexpected db failure');
      (services.libraryScan.rescanLibrary as ReturnType<typeof vi.fn>).mockRejectedValue(unexpected);
      (services.companionEbook.reconcileAll as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      startJobs(injectHelper<Db>(db), services, log);

      await triggerCron('0 */6 * * *');

      expect(services.companionEbook.reconcileAll).toHaveBeenCalledTimes(1);
      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: unexpected.message, type: 'Error' }) }),
        'library-rescan job error',
      );
    });
  });

  // Croner remains real here; only instance tracking is mocked.
  describe('scheduleCron next-run wiring (#1270)', () => {
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
        // Register before scheduling; otherwise setNextRun no-ops.
        reg.register(name, 'cron', vi.fn().mockResolvedValue(undefined), expr);

        const before = Date.now();
        const job = scheduleCron(reg, name, expr, log);
        cronInstances.push(job);

        const task = reg.getAll().find((t) => t.name === name);
        expect(task!.nextRun).not.toBeNull();
        const nextRunMs = new Date(task!.nextRun!).getTime();
        expect(Number.isNaN(nextRunMs)).toBe(false);
        expect(nextRunMs).toBeGreaterThan(before);
      },
    );

    it('reports a fixed-time cron (0 2 * * *) more than a minute out — guards the old "≈now" fallback', async () => {
      // Freeze Date away from 02:00; the next daily fire can legitimately be under 60s.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2024-06-15T12:00:00'));
      try {
        const { scheduleCron } = await import('./index.js');
        const reg = new TaskRegistry();
        reg.register('version-check', 'cron', vi.fn().mockResolvedValue(undefined), '0 2 * * *');

        const job = scheduleCron(reg, 'version-check', '0 2 * * *', log);
        cronInstances.push(job);

        const task = reg.getAll().find((t) => t.name === 'version-check');
        const deltaMs = new Date(task!.nextRun!).getTime() - Date.now();
        expect(deltaMs).toBeGreaterThan(60 * 1000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refreshes nextRun after each fire via the callback finally-block', async () => {
      const { scheduleCron } = await import('./index.js');
      const reg = new TaskRegistry();
      const fn = vi.fn().mockResolvedValue(undefined);
      reg.register('monitor', 'cron', fn, '*/30 * * * * *');

      const job = scheduleCron(reg, 'monitor', '*/30 * * * * *', log);
      cronInstances.push(job);

      // Capture before trigger; a post-trigger read can cross the sub-minute boundary.
      const before = Date.now();
      await job.trigger();

      expect(fn).toHaveBeenCalledTimes(1);
      const task = reg.getAll().find((t) => t.name === 'monitor');
      expect(task!.nextRun).not.toBeNull();
      expect(new Date(task!.nextRun!).getTime()).toBeGreaterThan(before);
    });

    it('skips setNextRun (leaves the prior value) when nextRun() returns null, without throwing', async () => {
      const { scheduleCron } = await import('./index.js');
      const reg = new TaskRegistry();
      reg.register('null-job', 'cron', vi.fn().mockResolvedValue(undefined), '* * * * *');

      const prior = new Date('2026-01-01T00:00:00.000Z');
      reg.setNextRun('null-job', prior);

      // Cron is the tracking subclass; nextRun lives on its real superclass prototype.
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

  describe('scheduler stop (#1515)', () => {
    async function waitForBackupTimers(spy: ReturnType<typeof vi.spyOn>, n: number, ms: number): Promise<void> {
      await vi.waitFor(() => {
        const calls = (spy.mock.calls as Array<[unknown, number]>).filter(([, d]) => d === ms);
        expect(calls.length).toBe(n);
      });
    }

    const BACKUP_MS = 60 * 60 * 1000; // uniquely identifies the backup loop

    it('stopAll() calls Cron.stop() exactly once on every constructed cron', async () => {
      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);

      const stopSpies = cronInstances.map((c) => vi.spyOn(c, 'stop'));
      expect(stopSpies.length).toBeGreaterThan(0);

      scheduler.stopAll();

      for (const s of stopSpies) expect(s).toHaveBeenCalledTimes(1);
    });

    it('stopAll() is idempotent — a second call does not re-stop the crons and does not throw', async () => {
      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);

      const stopSpies = cronInstances.map((c) => vi.spyOn(c, 'stop'));

      scheduler.stopAll();
      expect(() => scheduler.stopAll()).not.toThrow();

      for (const s of stopSpies) expect(s).toHaveBeenCalledTimes(1);
    });

    it('stopAll() cancels a pending timeout-loop tick — its callback does not fire and does not re-arm', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const execSpy = vi.spyOn(services.taskRegistry, 'executeTracked');

      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);

      await waitForBackupTimers(setTimeoutSpy, 1, BACKUP_MS);
      const tick = setTimeoutSpy.mock.calls.find(([, d]) => d === BACKUP_MS)![0] as () => Promise<void>;

      scheduler.stopAll();
      const execCallsBefore = execSpy.mock.calls.length;
      const setTimeoutCallsBefore = setTimeoutSpy.mock.calls.length;

      await tick();

      expect(execSpy.mock.calls.length).toBe(execCallsBefore);
      expect(setTimeoutSpy.mock.calls.length).toBe(setTimeoutCallsBefore);

      setTimeoutSpy.mockRestore();
    });

    it('a tick that fired before stopAll re-armed, but stopAll halts that re-armed tick', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const execSpy = vi.spyOn(services.taskRegistry, 'executeTracked').mockResolvedValue(undefined);

      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);

      await waitForBackupTimers(setTimeoutSpy, 1, BACKUP_MS);
      const firstTick = setTimeoutSpy.mock.calls.find(([, d]) => d === BACKUP_MS)![0] as () => Promise<void>;

      await firstTick();
      expect(execSpy).toHaveBeenCalledWith('backup');
      await waitForBackupTimers(setTimeoutSpy, 2, BACKUP_MS);
      const secondTick = (setTimeoutSpy.mock.calls.filter(([, d]) => d === BACKUP_MS)[1]![0]) as () => Promise<void>;

      scheduler.stopAll();
      const backupCallsBefore = execSpy.mock.calls.filter((c) => c[0] === 'backup').length;
      await secondTick();
      expect(execSpy.mock.calls.filter((c) => c[0] === 'backup').length).toBe(backupCallsBefore);

      setTimeoutSpy.mockRestore();
    });

    it('unref()s the timeout-loop timers so a pending tick does not pin the event loop past SIGTERM', async () => {
      const unrefs: Array<ReturnType<typeof vi.fn>> = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms) as ReturnType<typeof setTimeout>;
        const origUnref = handle.unref.bind(handle);
        const u = vi.fn(() => origUnref());
        handle.unref = u as unknown as typeof handle.unref;
        unrefs.push(u);
        return handle;
      }) as unknown as typeof setTimeout);
      try {
        const { startJobs } = await import('./index.js');
        startJobs(injectHelper<Db>(db), services, log);

        // search, rss, backup, and discovery each arm one timeout.
        await vi.waitFor(() => {
          const unreffed = unrefs.filter((u) => u.mock.calls.length === 1);
          expect(unreffed.length).toBeGreaterThanOrEqual(4);
        });
      } finally {
        vi.mocked(globalThis.setTimeout).mockRestore();
      }
    });

    it('no timeout-loop job fires its service work after stopAll', async () => {
      const { runBackupJob } = await import('./backup.js');
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { startJobs } = await import('./index.js');
      const scheduler = startJobs(injectHelper<Db>(db), services, log);

      await waitForBackupTimers(setTimeoutSpy, 1, BACKUP_MS);
      const tick = setTimeoutSpy.mock.calls.find(([, d]) => d === BACKUP_MS)![0] as () => Promise<void>;

      scheduler.stopAll();
      await tick();

      expect(runBackupJob).not.toHaveBeenCalled();

      setTimeoutSpy.mockRestore();
    });
  });
});
