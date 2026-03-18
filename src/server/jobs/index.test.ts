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

import cron from 'node-cron';

describe('startJobs', () => {
  let services: Services;
  let log: FastifyBaseLogger;
  const db = {} as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    services = createMockServices();
    // Use a real TaskRegistry so register/getAll work properly
    services.taskRegistry = new TaskRegistry() as unknown as Services['taskRegistry'];
    log = createMockLogger() as unknown as FastifyBaseLogger;
    // Mock settings.get for timeout-loop jobs
    (services.settings.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      intervalMinutes: 30,
      backupIntervalMinutes: 60,
    });
  });

  it('registers all jobs with the task registry', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    const tasks = services.taskRegistry.getAll();
    const names = tasks.map((t) => t.name);
    expect(names).toContain('monitor');
    expect(names).toContain('enrichment');
    expect(names).toContain('import');
    expect(names).toContain('search');
    expect(names).toContain('rss');
    expect(names).toContain('backup');
    expect(names).toContain('housekeeping');
    expect(names).toContain('recycle-cleanup');
    expect(names).toContain('health-check');
    expect(names).toContain('version-check');
    expect(names).toContain('import-list-sync');
    expect(names).toContain('discovery');
  });

  it('schedules cron jobs via cron.schedule', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    const cronCalls = vi.mocked(cron.schedule).mock.calls;
    const expressions = cronCalls.map(([expr]) => expr);
    expect(expressions).toContain('*/30 * * * * *'); // monitor
    expect(expressions).toContain('*/5 * * * *');    // enrichment, health-check
    expect(expressions).toContain('*/60 * * * * *'); // import
    expect(expressions).toContain('0 0 * * 0');      // housekeeping
    expect(expressions).toContain('0 2 * * *');      // recycle-cleanup, version-check
    expect(expressions).toContain('* * * * *');      // import-list-sync
  });

  it('logs startup message', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    expect(log.info).toHaveBeenCalledWith('Background jobs started');
  });

  it('import task callback calls qualityGate then importOrchestrator processCompletedDownloads', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    // Execute the registered import task
    await services.taskRegistry.executeTracked('import');

    expect(services.qualityGateOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(1);
    expect(services.importOrchestrator.processCompletedDownloads).toHaveBeenCalledTimes(1);

    // Quality gate must be called before import orchestrator
    const qgOrder = (services.qualityGateOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const ioOrder = (services.importOrchestrator.processCompletedDownloads as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(qgOrder).toBeLessThan(ioOrder);
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
    startJobs(db, services, log);

    // Wait for all async scheduleNext() calls to resolve and call setTimeout
    const expectedMs = 12 * 60 * 60 * 1000; // 12 hours in ms
    await vi.waitFor(() => {
      const discoveryTimeout = setTimeoutSpy.mock.calls.find(([, delay]) => delay === expectedMs);
      expect(discoveryTimeout).toBeDefined();
    });

    setTimeoutSpy.mockRestore();
  });
});
