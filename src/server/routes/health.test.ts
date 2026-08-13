import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach, type Mock } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { createTestApp, createMockServices, resetMockServices, createMockDb, createMockLogger, mockDbChain, inject } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbImportList } from '../__tests__/factories.js';
import type { Services } from './index.js';
import type { Db } from '@db/index.js';
import { TaskRegistry, TaskRegistryError } from '../services/task-registry.js';
import { ImportListService } from '../services/import-list.service.js';
import type { BookService } from '../services/book.service.js';
import type { ImmediateSearchDeps } from '../services/trigger-immediate-search.js';
import { initializeKey, _resetKey } from '../utils/secret-codec.js';
import { randomBytes } from 'node:crypto';

// Only import-list.service.ts reaches these two, so stubbing them here isolates the AC10 chain
// without touching any other route in the graph.
vi.mock('@core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: { nyt: vi.fn(), hardcover: vi.fn() },
}));
vi.mock('../services/trigger-immediate-search.js', () => ({
  triggerImmediateSearch: vi.fn(),
  runImmediateSearch: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, default: { ...actual, statfs: vi.fn() } };
});

vi.mock('../utils/version.js', () => ({
  getVersion: () => '99.88.77',
  getCommit: () => 'abc1234def',
  getBuildTime: () => '2026-03-29T11:29:40Z',
}));

import fsp from 'fs/promises';
import { IMPORT_LIST_ADAPTER_FACTORIES } from '@core/import-lists/index.js';
import { runImmediateSearch } from '../services/trigger-immediate-search.js';

const mockRunImmediateSearch = runImmediateSearch as unknown as Mock;

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
    it('triggers immediate health check via runManualChecks and returns results', async () => {
      const mockResults = [{ checkName: 'disk-space', state: 'healthy' }];
      (services.healthCheck.runManualChecks as Mock).mockResolvedValue(mockResults);

      const res = await app.inject({ method: 'POST', url: '/api/system/health/run' });
      expect(res.statusCode).toBe(200);

      const payload = JSON.parse(res.payload);
      expect(payload).toEqual(mockResults);
      expect(services.healthCheck.runManualChecks).toHaveBeenCalledOnce();
      expect(services.healthCheck.runAllChecks).not.toHaveBeenCalled();
    });

    it('passes the request logger to runManualChecks (drives the version-check log scope, #1411)', async () => {
      (services.healthCheck.runManualChecks as Mock).mockResolvedValue([]);

      const res = await app.inject({ method: 'POST', url: '/api/system/health/run' });
      expect(res.statusCode).toBe(200);

      const loggerArg = (services.healthCheck.runManualChecks as Mock).mock.calls[0]![0];
      expect(typeof loggerArg?.error).toBe('function');
      expect(typeof loggerArg?.info).toBe('function');
    });

    it('returns latest cached results with 200 when check already in progress', async () => {
      const cachedResults = [{ checkName: 'ffmpeg', state: 'error', message: 'not found' }];
      (services.healthCheck.runManualChecks as Mock).mockResolvedValue(cachedResults);

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

// #2304 (AC10, spec-review F5): a manual import-list sync now awaits its serial search chain, so
// the shared task route blocks for the whole cycle. That is the accepted trade for keeping the
// TaskRegistry guard honest, and it needs pinning at the route — not just stated in a PR body.
describe('POST /api/system/tasks/import-list-sync/run — the response spans the search chain', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let services: Services;
  let registry: TaskRegistry;
  let searchGate: { promise: Promise<void>; resolve: () => void };
  let fetchItems: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRunImmediateSearch.mockReset();
    // `decryptRow` reads the secret key before the provider is ever built.
    _resetKey();
    initializeKey(randomBytes(32));

    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    searchGate = { promise, resolve: release };
    mockRunImmediateSearch.mockImplementation(async () => { await searchGate.promise; });

    fetchItems = vi.fn().mockResolvedValue([{ title: 'Gated Book', author: 'Gated Author' }]);
    (IMPORT_LIST_ADAPTER_FACTORIES as Record<string, Mock>).nyt!.mockReturnValue({ fetchItems, test: vi.fn() });

    const db = createMockDb();
    db.select.mockReturnValue(mockDbChain([createMockDbImportList({
      type: 'nyt', enabled: true, nextRunAt: new Date(Date.now() - 60_000),
      settings: { apiKey: 'key', list: 'audio-fiction' },
    })]));
    db.insert.mockReturnValue(mockDbChain([]));
    db.update.mockReturnValue(mockDbChain([]));

    const bookService = inject<BookService>({
      findDuplicate: vi.fn().mockResolvedValue({ verdict: 'different-recording', book: null }),
      create: vi.fn().mockResolvedValue({ ...createMockDbBook({ status: 'wanted' }), authors: [], narrators: [] }),
      getById: vi.fn().mockResolvedValue(null),
    });
    const importList = new ImportListService(
      inject<Db>(db), createMockLogger() as unknown as FastifyBaseLogger, bookService, undefined,
      inject<ImmediateSearchDeps>({ settingsService: { get: vi.fn().mockResolvedValue({ searchImmediately: true }) } }),
    );

    registry = new TaskRegistry();
    registry.register('import-list-sync', 'cron', () => importList.syncDueLists(), '* * * * *');

    services = createMockServices();
    (services as unknown as Record<string, unknown>).taskRegistry = registry;
    app = await createTestApp(services);
  });

  afterEach(async () => {
    searchGate.resolve();
    await app.close();
  });

  it('withholds the response until the chain settles, then answers { ok: true }', async () => {
    let settled = false;
    const response = app.inject({ method: 'POST', url: '/api/system/tasks/import-list-sync/run' })
      .then((res) => { settled = true; return res; });

    await vi.waitFor(() => expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1));
    expect(fetchItems).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    searchGate.resolve();
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ ok: true });
  });

  it('rejects a concurrent run with ALREADY_RUNNING rather than starting a second cycle', async () => {
    const first = app.inject({ method: 'POST', url: '/api/system/tasks/import-list-sync/run' });
    await vi.waitFor(() => expect(mockRunImmediateSearch).toHaveBeenCalledTimes(1));

    await expect(registry.runTask('import-list-sync')).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
    expect(fetchItems).toHaveBeenCalledTimes(1);

    searchGate.resolve();
    expect((await first).statusCode).toBe(200);
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
      expect(payload.commit).toBe('abc1234def');
    });

    it('returns version from getVersion() instead of hardcoded string', async () => {
      (services.settings.get as Mock).mockResolvedValue({ path: '/audiobooks' });
      (mockDb.run as Mock).mockResolvedValue({ rows: [[10, 4096]] });
      (fsp.statfs as unknown as Mock).mockResolvedValue({ bavail: 500, bsize: 4096 });

      const res = await app.inject({ method: 'GET', url: '/api/system/info' });
      const payload = JSON.parse(res.payload);

      expect(payload.version).toBe('99.88.77');
    });
  });
});
