import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createTestApp, createMockServices, resetMockServices } from '../__tests__/helpers.js';
import type { Services } from './index.js';
import type { Db } from '../../db/index.js';
import { TaskRegistryError } from '../services/task-registry.js';

vi.mock('fs/promises', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, default: { ...actual, statfs: vi.fn() } };
});

vi.mock('../utils/version.js', () => ({
  getVersion: () => '99.88.77',
  getCommit: () => 'abc1234def',
  getBuildTime: () => '2026-03-29T11:29:40Z',
}));

import fsp from 'fs/promises';

describe('Health routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/system/health/status', () => {
    it('returns array of check results with checkName, state, message', async () => {
      const mockResults = [
        { checkName: 'indexer:NZBgeek', state: 'healthy' },
        { checkName: 'library-root', state: 'error', message: 'Path not writable' },
      ];
      (services.healthCheck.getCachedResults as Mock).mockReturnValue(mockResults);

      const res = await app.inject({ method: 'GET', url: '/api/system/health/status' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual(mockResults);
    });
  });

  describe('GET /api/system/health/summary', () => {
    it('returns aggregate state (worst-of: error > warning > healthy)', async () => {
      (services.healthCheck.getAggregateState as Mock).mockReturnValue('warning');

      const res = await app.inject({ method: 'GET', url: '/api/system/health/summary' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual({ state: 'warning' });
    });
  });

  describe('POST /api/system/health/run', () => {
    it('triggers immediate health check and returns results', async () => {
      const mockResults = [{ checkName: 'disk-space', state: 'healthy' }];
      (services.healthCheck.runAllChecks as Mock).mockResolvedValue(mockResults);

      const res = await app.inject({ method: 'POST', url: '/api/system/health/run' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual(mockResults);
      expect(services.healthCheck.runAllChecks).toHaveBeenCalledOnce();
    });

    it('returns latest cached results with 200 when check already in progress', async () => {
      // runAllChecks returns cached results when already running (mutex in service)
      const cachedResults = [{ checkName: 'ffmpeg', state: 'error', message: 'not found' }];
      (services.healthCheck.runAllChecks as Mock).mockResolvedValue(cachedResults);

      const res = await app.inject({ method: 'POST', url: '/api/system/health/run' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual(cachedResults);
    });
  });
});

describe('Task routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
  });

  describe('GET /api/system/tasks', () => {
    it('returns list with name, type, lastRun, nextRun, running per task', async () => {
      const mockTasks = [
        { name: 'monitor', type: 'cron', lastRun: null, nextRun: '2026-03-10T12:00:00Z', running: false },
        { name: 'search', type: 'timeout', lastRun: '2026-03-10T11:55:00Z', nextRun: null, running: true },
      ];
      (services.taskRegistry.getAll as Mock).mockReturnValue(mockTasks);

      const res = await app.inject({ method: 'GET', url: '/api/system/tasks' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual(mockTasks);
    });
  });

  describe('POST /api/system/tasks/:name/run', () => {
    it('delegates to TaskRegistry.runTask and returns result', async () => {
      (services.taskRegistry.runTask as Mock).mockResolvedValue(undefined);

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/monitor/run' });
      expect(res.statusCode).toBe(200);
      expect(services.taskRegistry.runTask).toHaveBeenCalledWith('monitor');
    });

    it('returns 404 for invalid task name', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new TaskRegistryError('Task "nonexistent" not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/nonexistent/run' });
      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when task is already running', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new TaskRegistryError('Task "monitor" is already running', 'ALREADY_RUNNING'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/monitor/run' });
      expect(res.statusCode).toBe(409);
    });

    it('returns 500 with error message for unexpected failures', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new Error('Database connection lost'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/monitor/run' });
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });

    // #149 — typed error routing via plugin (ERR-1)
    it('returns 404 when task registry throws TaskRegistryError NOT_FOUND (plugin-routed)', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new TaskRegistryError('Task "nonexistent" not found', 'NOT_FOUND'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/nonexistent/run' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Task "nonexistent" not found' });
    });

    it('returns 409 when task registry throws TaskRegistryError ALREADY_RUNNING (plugin-routed)', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new TaskRegistryError('Task "monitor" is already running', 'ALREADY_RUNNING'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/monitor/run' });

      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Task "monitor" is already running' });
    });

    it('returns 500 with body { error: "Internal server error" } when unrelated error message contains "not found" substring (regression: proves plugin bubbling not local catch)', async () => {
      (services.taskRegistry.runTask as Mock).mockRejectedValue(new Error('Config key not found in env'));

      const res = await app.inject({ method: 'POST', url: '/api/system/tasks/monitor/run' });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.payload)).toEqual({ error: 'Internal server error' });
    });
  });
});

describe('System info routes', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  const mockDb = { run: vi.fn() } as unknown as Db;

  beforeAll(async () => {
    services = createMockServices();
    app = await createTestApp(services, mockDb);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    resetMockServices(services);
    (mockDb.run as Mock).mockReset();
    (fsp.statfs as unknown as Mock).mockReset();
  });

  describe('GET /api/system/info', () => {
    it('computes dbSize from page_count * page_size', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[100, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 1000, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.dbSize).toBe(100 * 4096);
    });

    it('computes freeSpace from statfs bavail * bsize', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 500, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.freeSpace).toBe(500 * 4096);
    });

    it('returns dbSize null when db.run() throws', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockRejectedValue(new Error('DB error'));
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 1000, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.dbSize).toBeNull();
    });

    it('returns freeSpace null when statfs throws', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockRejectedValue(new Error('ENOENT'));

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.freeSpace).toBeNull();
    });

    it('returns freeSpace null when library path not configured', async () => {
      (services.settings.get as Mock).mockResolvedValue(null);
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.libraryPath).toBeNull();
      expect(payload.freeSpace).toBeNull();
    });

    it('includes commit field in response', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 500, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      expect(payload.commit).toBe('abc1234def');
    });

    it('commit field reflects getCommit() value, not a hardcoded string', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 500, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);
      // getCommit() is mocked to return 'abc1234def' — proves dynamic read, not hardcoded
      expect(payload.commit).toBe('abc1234def');
    });

    // L-14: version should come from getVersion() instead of hardcoded '0.1.0'
    it('returns version from getVersion() instead of hardcoded string', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 500, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);

      // getVersion() is mocked to return '99.88.77' — if the route
      // uses getVersion(), we'll see that; if hardcoded, we'll see '0.1.0'
      expect(payload.version).toBe('99.88.77');
    });
  });
});
