import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { eq } from 'drizzle-orm';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { books, importLists } from '@db/schema.js';

/**
 * Two outbound boundaries a sync crosses have no config seam, so both are stubbed; the route, the
 * service, the shared writer, the intake pipeline and every database write are real. The
 * `globalThis.fetch` guard below is what keeps this inventory honest — if a future change grows a
 * third outbound dependency, name it here rather than relaxing the guard.
 */
vi.mock('@core/import-lists/index.js', () => ({
  IMPORT_LIST_ADAPTER_FACTORIES: { nyt: vi.fn(), hardcover: vi.fn() },
}));

const { IMPORT_LIST_ADAPTER_FACTORIES } = await import('@core/import-lists/index.js');
const mockFactories = IMPORT_LIST_ADAPTER_FACTORIES as unknown as Record<string, ReturnType<typeof vi.fn>>;

const ITEM = { title: 'The Reckoning', author: 'Jane Doe' };
const SYNC_INTERVAL_MINUTES = 60;

describe('manual import-list run, end to end (#2306)', () => {
  let e2e: E2EApp;
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  beforeEach(async () => {
    e2e = await createE2EApp();
    // Fail closed: an unexpected outbound call must not reach the network before the per-case
    // assertion reports it.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) =>
      Promise.reject(new Error(`unexpected outbound request: ${String(input)}`)));

    // The harness stops after route registration, so `import-list-sync` would otherwise be absent
    // and `runExclusive` would answer a confusing task-flavoured 404.
    e2e.services.taskRegistry.register(
      'import-list-sync',
      'cron',
      () => e2e.services.importList.syncDueLists(),
      '* * * * *',
    );

    // No provider match: the created row keeps the list item's own title and author.
    vi.spyOn(e2e.services.metadata, 'resolveBook').mockResolvedValue(null);
  });

  afterEach(async () => {
    fetchSpy.mockRestore();
    vi.restoreAllMocks();
    await e2e.cleanup();
  });

  function stubProvider(fetchItems: ReturnType<typeof vi.fn>) {
    mockFactories.nyt!.mockReturnValue({ fetchItems, test: vi.fn().mockResolvedValue({ success: true }) });
  }

  /** A list whose next scheduled run is an hour out, so only a manual run can sync it. */
  async function seedList(overrides: { enabled?: boolean } = {}) {
    const list = await e2e.services.importList.create({
      name: 'NYT Bestsellers',
      type: 'nyt',
      settings: { apiKey: 'key', list: 'audio-fiction' },
      syncIntervalMinutes: SYNC_INTERVAL_MINUTES,
      ...overrides,
    });
    await e2e.db
      .update(importLists)
      .set({ nextRunAt: new Date(Date.now() + 60 * 60_000) })
      .where(eq(importLists.id, list.id));
    return list.id;
  }

  const run = (id: number) => e2e.app.inject({ method: 'POST', url: `/api/import-lists/${id}/run` });

  async function readList(id: number) {
    const [row] = await e2e.db.select().from(importLists).where(eq(importLists.id, id));
    return row!;
  }

  const expectAdvancedByOneInterval = (nextRunAt: Date | null) => {
    const diff = nextRunAt!.getTime() - Date.now();
    expect(diff).toBeGreaterThan((SYNC_INTERVAL_MINUTES - 1) * 60_000);
    expect(diff).toBeLessThan((SYNC_INTERVAL_MINUTES + 1) * 60_000);
  };

  it('syncs a list that is not due, writes the book, and resets its schedule', async () => {
    stubProvider(vi.fn().mockResolvedValue([ITEM]));
    const id = await seedList();

    const res = await run(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, createdCount: 1, heldReviewCount: 0, excludedCount: 0 });

    const rows = await e2e.db.select().from(books);
    expect(rows.map((r) => r.title)).toEqual(['The Reckoning']);
    expect(rows[0]!.importListId).toBe(id);

    const list = await readList(id);
    expect(list.lastRunAt).toBeInstanceOf(Date);
    expect(list.lastSyncError).toBeNull();
    expectAdvancedByOneInterval(list.nextRunAt);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('syncs a disabled list and leaves it disabled', async () => {
    stubProvider(vi.fn().mockResolvedValue([ITEM]));
    const id = await seedList({ enabled: false });

    const res = await run(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, createdCount: 1 });

    const rows = await e2e.db.select().from(books);
    expect(rows.map((r) => r.title)).toEqual(['The Reckoning']);

    const list = await readList(id);
    expect(list.enabled).toBe(false);
    expect(list.lastRunAt).toBeInstanceOf(Date);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records a provider failure exactly as a failed scheduled run would', async () => {
    stubProvider(vi.fn().mockRejectedValue(new Error('Connection timeout')));
    const id = await seedList();
    const before = await readList(id);

    const res = await run(id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: false, message: 'Connection timeout' });

    const list = await readList(id);
    expect(list.lastSyncError).toBe('Connection timeout');
    expect(list.lastRunAt).toEqual(before.lastRunAt);
    expectAdvancedByOneInterval(list.nextRunAt);
    expect(await e2e.db.select().from(books)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown list id without touching the library', async () => {
    stubProvider(vi.fn().mockResolvedValue([ITEM]));

    const res = await run(9999);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Import list not found' });
    expect(await e2e.db.select().from(books)).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('serves the refreshed lastRunAt and lastSyncError through the list endpoint the client refetches', async () => {
    stubProvider(vi.fn().mockRejectedValue(new Error('Connection timeout')));
    const id = await seedList();
    await run(id);

    const failed = await e2e.app.inject({ method: 'GET', url: '/api/import-lists' });
    expect(failed.statusCode).toBe(200);
    expect(failed.json()[0]).toMatchObject({ id, lastRunAt: null, lastSyncError: 'Connection timeout' });

    stubProvider(vi.fn().mockResolvedValue([ITEM]));
    await run(id);

    const recovered = await e2e.app.inject({ method: 'GET', url: '/api/import-lists' });
    expect(recovered.json()[0]).toMatchObject({ id, lastSyncError: null });
    expect(recovered.json()[0].lastRunAt).not.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
