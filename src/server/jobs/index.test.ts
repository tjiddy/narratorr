import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { Services } from '../routes/index.js';
import { createMockServices, createMockLogger } from '../__tests__/helpers.js';

vi.mock('./monitor.js', () => ({ startMonitorJob: vi.fn() }));
vi.mock('./enrichment.js', () => ({ startEnrichmentJob: vi.fn() }));
vi.mock('./import.js', () => ({ startImportJob: vi.fn() }));
vi.mock('./search.js', () => ({ startSearchJob: vi.fn() }));
vi.mock('./rss.js', () => ({ startRssJob: vi.fn() }));

import { startMonitorJob } from './monitor.js';
import { startEnrichmentJob } from './enrichment.js';
import { startImportJob } from './import.js';
import { startSearchJob } from './search.js';
import { startRssJob } from './rss.js';

describe('startJobs', () => {
  let services: Services;
  let log: FastifyBaseLogger;
  const db = {} as Db;

  beforeEach(() => {
    vi.clearAllMocks();
    services = createMockServices();
    log = createMockLogger() as unknown as FastifyBaseLogger;
  });

  it('starts all background jobs and logs startup', async () => {
    const { startJobs } = await import('./index.js');
    startJobs(db, services, log);

    expect(startMonitorJob).toHaveBeenCalled();
    expect(startEnrichmentJob).toHaveBeenCalled();
    expect(startImportJob).toHaveBeenCalledWith(services.import, services.qualityGate, log);
    expect(startSearchJob).toHaveBeenCalled();
    expect(startRssJob).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('Background jobs started');
  });
});
