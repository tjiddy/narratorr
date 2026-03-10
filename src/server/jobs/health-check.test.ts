import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({
  default: { schedule: vi.fn() },
}));

import cron from 'node-cron';
import { startHealthCheckJob, _resetHealthCheck } from './health-check.js';
import type { HealthCheckService } from '../services/health-check.service.js';
import { inject } from '../__tests__/helpers.js';

const mockSchedule = vi.mocked(cron.schedule);

describe('Health check cron job', () => {
  let healthCheckService: { runAllChecks: ReturnType<typeof vi.fn> };
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthCheck();
    healthCheckService = { runAllChecks: vi.fn().mockResolvedValue([]) };
  });

  it('registers with cron.schedule at */5 * * * * expression', () => {
    startHealthCheckJob(inject<HealthCheckService>(healthCheckService), inject(log));
    expect(mockSchedule).toHaveBeenCalledWith('*/5 * * * *', expect.any(Function));
  });

  it('callback calls HealthCheckService.runAllChecks()', async () => {
    startHealthCheckJob(inject<HealthCheckService>(healthCheckService), inject(log));
    const callback = mockSchedule.mock.calls[0][1] as () => Promise<void>;
    await callback();
    expect(healthCheckService.runAllChecks).toHaveBeenCalledOnce();
  });

  it('exports _resetHealthCheck for test cleanup', () => {
    expect(typeof _resetHealthCheck).toBe('function');
  });
});
