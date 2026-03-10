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

  it('registers all 8 jobs with the task registry', async () => {
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
    expect(names).toContain('health-check');
    expect(tasks).toHaveLength(8);
  });

  it('schedules 5 cron jobs via cron.schedule', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    const cronCalls = vi.mocked(cron.schedule).mock.calls;
    const expressions = cronCalls.map(([expr]) => expr);
    expect(expressions).toContain('*/30 * * * * *'); // monitor
    expect(expressions).toContain('*/5 * * * *');    // enrichment, health-check
    expect(expressions).toContain('*/60 * * * * *'); // import
    expect(expressions).toContain('0 0 * * 0');      // housekeeping
    expect(cronCalls).toHaveLength(5);
  });

  it('logs startup message', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    expect(log.info).toHaveBeenCalledWith('Background jobs started');
  });
});
