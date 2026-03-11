import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockServices, createMockLogger, inject } from '../__tests__/helpers.js';
import type { Services } from '../routes/index.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { Mock } from 'vitest';

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(),
  },
}));

import cron from 'node-cron';

const { startJobs } = await import('./index.js');

describe('recycle-cleanup job', () => {
  let services: Services;
  let db: { run: ReturnType<typeof vi.fn> };
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    services = createMockServices();
    db = { run: vi.fn().mockResolvedValue(undefined) };
    log = createMockLogger();
  });

  it('registers recycle-cleanup as cron task at 0 2 * * * (separate from housekeeping)', () => {
    startJobs(inject<Db>(db), services, inject<FastifyBaseLogger>(log));

    const calls = (cron.schedule as Mock).mock.calls;
    const recycleCall = calls.find((c: unknown[]) => c[0] === '0 2 * * *');
    expect(recycleCall).toBeDefined();
  });

  it('calls recyclingBinService.purgeExpired on execution', async () => {
    (services.recyclingBin.purgeExpired as Mock).mockResolvedValue({ purged: 2, failed: 0 });

    startJobs(inject<Db>(db), services, inject<FastifyBaseLogger>(log));

    // Find the recycle-cleanup callback registered via TaskRegistry
    // The registry's executeTracked will call the registered function
    const reg = services.taskRegistry;
    const registerCalls = (reg.register as Mock).mock.calls;
    const recycleRegistration = registerCalls.find((c: unknown[]) => c[0] === 'recycle-cleanup');
    expect(recycleRegistration).toBeDefined();

    // Execute the registered callback directly
    const callback = recycleRegistration![2] as () => Promise<unknown>;
    await callback();

    expect(services.recyclingBin.purgeExpired).toHaveBeenCalled();
  });

  it('does not affect existing housekeeping task schedule or behavior', () => {
    startJobs(inject<Db>(db), services, inject<FastifyBaseLogger>(log));

    const registerCalls = (services.taskRegistry.register as Mock).mock.calls;
    const housekeepingReg = registerCalls.find((c: unknown[]) => c[0] === 'housekeeping');
    const recycleReg = registerCalls.find((c: unknown[]) => c[0] === 'recycle-cleanup');

    // Both registered as separate tasks
    expect(housekeepingReg).toBeDefined();
    expect(recycleReg).toBeDefined();
    // Different cron expressions
    expect(housekeepingReg![3]).toBe('0 0 * * 0');
    expect(recycleReg![3]).toBe('0 2 * * *');
  });
});
