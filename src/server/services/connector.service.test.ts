import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectorService } from './connector.service.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, encrypt, isEncrypted, maskFields } from '../utils/secret-codec.js';
import { createMockDbConnector } from '../__tests__/factories.js';
import { ConnectorRequestError, type ConnectorAdapter, type ConnectorImportBatch } from '../../core/connectors/index.js';
import type { ConnectorRow } from './types.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

function stubAdapter(refresh: ConnectorAdapter['refreshImport']): ConnectorAdapter {
  return {
    type: 'audiobookshelf',
    test: vi.fn().mockResolvedValue({ success: true }),
    listTargets: vi.fn().mockResolvedValue([]),
    refreshImport: refresh,
  };
}

describe('ConnectorService', () => {
  let db: ReturnType<typeof createMockDb>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    initializeKey(TEST_KEY);
    db = createMockDb();
    log = createMockLogger();
  });

  afterEach(() => {
    _resetKey();
  });

  // ── CRUD + secrets ──────────────────────────────────────────────────────────
  describe('CRUD + encryption', () => {
    function makeService() {
      return new ConnectorService(db as never, log as never);
    }

    it('create encrypts both baseUrl and apiKey before insert', async () => {
      const insertChain = mockDbChain([createMockDbConnector()]);
      db.insert.mockReturnValue(insertChain);

      await makeService().create({
        name: 'ABS', type: 'audiobookshelf', enabled: true,
        settings: { baseUrl: 'http://abs.local', apiKey: 'plain-key', libraryId: 'lib-1' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, unknown> };
      // baseUrl is a registered connector secret (#1491) — encrypted alongside apiKey.
      expect(isEncrypted(valuesArg.settings.baseUrl as string)).toBe(true);
      expect(isEncrypted(valuesArg.settings.apiKey as string)).toBe(true);
      // libraryId is not a secret — stays plaintext.
      expect(valuesArg.settings.libraryId).toBe('lib-1');
    });

    it('getById decrypts both baseUrl and apiKey', async () => {
      const encUrl = encrypt('http://abs.local', TEST_KEY);
      const encKey = encrypt('real-key', TEST_KEY);
      db.select.mockReturnValue(mockDbChain([createMockDbConnector({ settings: { baseUrl: encUrl, apiKey: encKey, libraryId: 'lib-1' } })]));
      const row = await makeService().getById(1);
      expect(row?.settings).toMatchObject({ baseUrl: 'http://abs.local', apiKey: 'real-key' });
    });

    it('API responses mask both baseUrl and apiKey (not libraryId)', () => {
      const masked = maskFields('connector', { baseUrl: 'http://abs.local', apiKey: 'real-key', libraryId: 'lib-1' });
      expect(masked.baseUrl).toBe('********');
      expect(masked.apiKey).toBe('********');
      expect(masked.libraryId).toBe('lib-1');
    });

    it('update with ******** sentinel preserves stored baseUrl + apiKey ciphertext and bumps updatedAt', async () => {
      const encryptedUrl = encrypt('http://saved.local', TEST_KEY);
      const encryptedKey = encrypt('saved-key', TEST_KEY);
      const existing = createMockDbConnector({ settings: { baseUrl: encryptedUrl, apiKey: encryptedKey, libraryId: 'lib-1' } });
      db.select.mockReturnValue(mockDbChain([existing]));
      const updateChain = mockDbChain([existing]);
      db.update.mockReturnValue(updateChain);

      await makeService().update(1, { type: 'audiobookshelf', settings: { baseUrl: '********', apiKey: '********', libraryId: 'lib-2' } });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown>; updatedAt: Date };
      // Sentinels resolve against RAW (encrypted) stored values — byte-for-byte preserved.
      expect(setArg.settings.baseUrl).toBe(encryptedUrl);
      expect(setArg.settings.apiKey).toBe(encryptedKey);
      expect(setArg.settings.libraryId).toBe('lib-2');
      expect(setArg.updatedAt).toBeInstanceOf(Date);
    });

    it('update invalidates the cached adapter', async () => {
      const service = makeService();
      const existing = createMockDbConnector();
      db.select.mockReturnValue(mockDbChain([existing]));
      db.update.mockReturnValue(mockDbChain([existing]));
      const spy = vi.spyOn(service['adapters'], 'delete');

      await service.update(1, { name: 'Renamed' });
      expect(spy).toHaveBeenCalledWith(1);
    });

    it('delete removes the row and drops the cached adapter', async () => {
      const service = makeService();
      db.select.mockReturnValue(mockDbChain([createMockDbConnector()]));
      db.delete.mockReturnValue(mockDbChain());
      const spy = vi.spyOn(service['adapters'], 'delete');

      const ok = await service.delete(1);
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(1);
    });
  });

  // ── targets ─────────────────────────────────────────────────────────────────
  describe('targets', () => {
    it('listTargetsConfig returns targets on success', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service as unknown as { adapterForConfig: (...a: unknown[]) => Promise<unknown> }, 'adapterForConfig').mockResolvedValue({
        type: 'audiobookshelf',
        test: vi.fn(),
        listTargets: vi.fn().mockResolvedValue([{ id: 'lib-1', name: 'Audiobooks' }]),
        refreshImport: vi.fn(),
      } as never);

      const result = await service.listTargetsConfig({ type: 'audiobookshelf', settings: { baseUrl: 'http://abs.local', apiKey: 'k', libraryId: 'lib-1' } });
      expect(result).toEqual({ success: true, targets: [{ id: 'lib-1', name: 'Audiobooks' }] });
    });

    it('listTargetsConfig translates a thrown ConnectorRequestError into a field-scoped envelope', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service as unknown as { adapterForConfig: (...a: unknown[]) => Promise<unknown> }, 'adapterForConfig').mockResolvedValue({
        type: 'audiobookshelf',
        test: vi.fn(),
        listTargets: vi.fn().mockRejectedValue(new ConnectorRequestError('bad key', { retryable: false, fieldErrors: { apiKey: 'Invalid API key' } })),
        refreshImport: vi.fn(),
      } as never);

      const result = await service.listTargetsConfig({ type: 'audiobookshelf', settings: { baseUrl: 'http://abs.local', apiKey: 'k', libraryId: 'lib-1' } });
      expect(result).toEqual({ success: false, message: 'bad key', fieldErrors: { apiKey: 'Invalid API key' } });
    });
  });

  // ── queue: debounce, retry, isolation, handle ownership ──────────────────────
  describe('refresh queue', () => {
    const DEBOUNCE = 1000;
    let service: ConnectorService;

    function connectorRow(id: number, enabled = true): ConnectorRow {
      return createMockDbConnector({ id, enabled }) as unknown as ConnectorRow;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      service = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });
      // flush() resolves the connector via getById and builds the adapter via getAdapter.
      vi.spyOn(service, 'getById').mockImplementation(async (id: number) => connectorRow(id));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const ITEM = (bookId: number) => ({ bookId, title: `Book ${bookId}`, libraryPath: `/lib/${bookId}` });

    it('coalesces same-reason enqueues into one batch carrying all items', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      service.enqueue(1, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
      const batch = refresh.mock.calls[0]![0] as ConnectorImportBatch;
      expect(batch.reason).toBe('import');
      expect(batch.items.map((i) => i.bookId)).toEqual([1, 2]);
    });

    it('mixed reasons for one connector flush separately (one batch per reason)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      service.enqueue(1, 'restored', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(2);
      const batches = refresh.mock.calls.map((c) => c[0] as ConnectorImportBatch);
      expect(batches).toContainEqual(expect.objectContaining({ reason: 'import', items: [ITEM(1)] }));
      expect(batches).toContainEqual(expect.objectContaining({ reason: 'restored', items: [ITEM(2)] }));
    });

    it('debounces per connector-id, not per host (two ids → two flushes)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));
      const getByIdSpy = vi.spyOn(service, 'getById');

      service.enqueue(1, 'import', ITEM(1));
      service.enqueue(2, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(getByIdSpy).toHaveBeenCalledWith(1);
      expect(getByIdSpy).toHaveBeenCalledWith(2);
    });

    it('retries exactly once when refreshImport throws a retryable error then succeeds', async () => {
      const refresh = vi.fn()
        .mockRejectedValueOnce(new ConnectorRequestError('5xx', { retryable: true }))
        .mockResolvedValueOnce({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('does NOT retry a non-retryable thrown error', async () => {
      const refresh = vi.fn().mockRejectedValue(new ConnectorRequestError('401', { retryable: false }));
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry a resolved { success: false } result', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: false, message: 'rejected' });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('logs a redacted URL (no apiKey) and does not throw when retries are exhausted', async () => {
      const refresh = vi.fn().mockRejectedValue(new ConnectorRequestError('still 5xx', { retryable: true }));
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      // Must not throw despite retry exhaustion (fire-and-forget).
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378' }),
        'Connector refresh failed',
      );
      const payload = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(JSON.stringify(payload)).not.toContain('secret-key');
    });

    it('skips the flush when the connector is disabled at flush time', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1, false));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).not.toHaveBeenCalled();
    });

    it('handle ownership: the deferred flush uses the service deps after the triggering call returned', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));
      const getByIdSpy = vi.spyOn(service, 'getById');

      // Simulate a request handler that enqueues and returns synchronously.
      const handleRequest = () => { service.enqueue(1, 'import', ITEM(1)); return 'returned'; };
      expect(handleRequest()).toBe('returned');

      // Nothing has flushed yet — the work is deferred past the request.
      expect(refresh).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      // Flush ran later, resolving its connector via the service's own getById/db.
      expect(getByIdSpy).toHaveBeenCalledWith(1);
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  });

  // ── fan-out ──────────────────────────────────────────────────────────────────
  describe('notifyRefresh fan-out', () => {
    it('enqueues per enabled connector × item', async () => {
      const service = new ConnectorService(db as never, log as never);
      db.select.mockReturnValue(mockDbChain([createMockDbConnector({ id: 1 }), createMockDbConnector({ id: 2 })]));
      const enqueueSpy = vi.spyOn(service, 'enqueue').mockImplementation(() => {});

      await service.notifyRefresh('import', [
        { bookId: 1, title: 'A', libraryPath: '/a' },
        { bookId: 2, title: 'B', libraryPath: '/b' },
      ]);

      expect(enqueueSpy).toHaveBeenCalledTimes(4);
      expect(enqueueSpy).toHaveBeenCalledWith(1, 'import', expect.objectContaining({ bookId: 1 }));
      expect(enqueueSpy).toHaveBeenCalledWith(2, 'import', expect.objectContaining({ bookId: 2 }));
    });

    it('is a no-op when there are no items', async () => {
      const service = new ConnectorService(db as never, log as never);
      const enqueueSpy = vi.spyOn(service, 'enqueue');
      await service.notifyRefresh('import', []);
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });
  });
});
