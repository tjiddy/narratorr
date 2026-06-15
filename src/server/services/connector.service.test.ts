import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ConnectorService } from './connector.service.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, encrypt, isEncrypted, maskFields, makeTestSchema } from '../utils/secret-codec.js';
import { createMockDbConnector } from '../__tests__/factories.js';
import { connectorTypeSchema } from '../../shared/schemas/connector.js';
import { ConnectorRequestError, type ConnectorAdapter, type ConnectorImportBatch } from '../../core/connectors/index.js';
import { CONNECTOR_TIMEOUT_MS } from '../../core/utils/constants.js';
import type { ConnectorRow } from './types.js';

const TEST_KEY = Buffer.from('a'.repeat(64), 'hex');

function stubAdapter(refresh: ConnectorAdapter['refreshImport'], requestCount = 1): ConnectorAdapter {
  return {
    type: 'audiobookshelf',
    test: vi.fn().mockResolvedValue({ success: true }),
    listTargets: vi.fn().mockResolvedValue([]),
    refreshImport: refresh,
    estimateRequestCount: vi.fn().mockReturnValue(requestCount),
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

    it('create encrypts the Plex token before insert', async () => {
      const insertChain = mockDbChain([createMockDbConnector()]);
      db.insert.mockReturnValue(insertChain);

      await makeService().create({
        name: 'Plex', type: 'plex', enabled: true,
        settings: { baseUrl: 'http://plex.local', token: 'plain-token', sectionId: '1' },
      });

      const valuesArg = (insertChain as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(isEncrypted(valuesArg.settings.token as string)).toBe(true);
      // sectionId is not a secret — stays plaintext.
      expect(valuesArg.settings.sectionId).toBe('1');
    });

    it('API responses mask the Plex token (not sectionId)', () => {
      const masked = maskFields('connector', { baseUrl: 'http://plex.local', token: 'real-token', sectionId: '1' });
      expect(masked.token).toBe('********');
      expect(masked.sectionId).toBe('1');
    });

    it('update with ******** sentinel preserves the stored Plex token ciphertext', async () => {
      const encryptedUrl = encrypt('http://plex.saved', TEST_KEY);
      const encryptedToken = encrypt('saved-token', TEST_KEY);
      const existing = createMockDbConnector({ type: 'plex', settings: { baseUrl: encryptedUrl, token: encryptedToken, sectionId: '1' } });
      db.select.mockReturnValue(mockDbChain([existing]));
      const updateChain = mockDbChain([existing]);
      db.update.mockReturnValue(updateChain);

      await makeService().update(1, { type: 'plex', settings: { baseUrl: '********', token: '********', sectionId: '2' } });

      const setArg = (updateChain as { set: ReturnType<typeof vi.fn> }).set.mock.calls[0]![0] as { settings: Record<string, unknown> };
      expect(setArg.settings.token).toBe(encryptedToken);
      expect(setArg.settings.sectionId).toBe('2');
    });

    it('makeTestSchema(connector) accepts the Plex token sentinel', () => {
      const cfg = z.object({ type: connectorTypeSchema, settings: z.record(z.string(), z.unknown()) });
      const schema = makeTestSchema(cfg, 'connector');
      const result = schema.safeParse({
        type: 'plex', id: 1,
        settings: { baseUrl: 'http://plex.local', token: '********', sectionId: '1' },
      });
      expect(result.success).toBe(true);
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

    it('logs the returned success message (skip counts) instead of a bare debug dispatch (F7)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 2 paths, skipped 1' });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, message: 'refreshed 2 paths, skipped 1' }),
        'Connector refresh dispatched',
      );
    });

    it('logs a warning (not a successful dispatch) when refreshImport resolves { success: false } (F7)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: false, message: 'provider rejected the scan' });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, message: 'provider rejected the scan' }),
        'Connector refresh rejected',
      );
    });

    // ── structured-outcome log levels + redacted host (#1505) ────────────────
    it('warns (NOT info-dispatch) when the result reports skipped items — fallback OFF', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 0 paths, skipped 2 items', skipped: 2, passthrough: 0, resolvedServerPaths: [] });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, message: 'refreshed 0 paths, skipped 2 items' }),
        'Connector refresh ineffective',
      );
      expect(log.info).not.toHaveBeenCalledWith(expect.anything(), 'Connector refresh dispatched');
    });

    it('warns when the result reports passthrough items (silent no-op against a remapped server)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 1 paths (1 passthrough — no mapping matched)', skipped: 0, passthrough: 1, resolvedServerPaths: ['/lib/A'] });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, message: expect.stringContaining('passthrough') }),
        'Connector refresh ineffective',
      );
    });

    it('does NOT warn for a fallback-ON rescued batch (fallbackRefreshed>0, skipped:0, passthrough:0) → info dispatched', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 0 paths, 2 no-derivable-path items via full section refresh', skipped: 0, passthrough: 0, fallbackRefreshed: 2, resolvedServerPaths: [] });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.warn).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, message: expect.stringContaining('full section refresh') }),
        'Connector refresh dispatched',
      );
    });

    it('does NOT warn when skipped:0, passthrough:0, message undefined — 0 must not coerce to "present" (falsy guard)', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, skipped: 0, passthrough: 0, message: undefined });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.warn).not.toHaveBeenCalled();
      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1 }),
        'Connector refresh dispatched',
      );
    });

    it('emits resolvedServerPaths at debug for a successful flush', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'refreshed 2 paths', skipped: 0, passthrough: 0, resolvedServerPaths: ['/srv/A', '/srv/B'] });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.debug).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, resolvedServerPaths: ['/srv/A', '/srv/B'] }),
        'Connector resolved server paths',
      );
    });

    it('carries the redacted host on dispatched, rejected, AND failed branches — two same-type connectors disambiguate', async () => {
      vi.spyOn(service, 'getById').mockImplementation(async (id: number) =>
        createMockDbConnector({
          id,
          settings: { baseUrl: `http://plex-${id}.local:32400`, apiKey: 'k', libraryId: 'lib' },
        }) as unknown as ConnectorRow);
      const refresh = vi.fn().mockImplementation(async (batch: ConnectorImportBatch) => {
        const which = batch.items[0]!.bookId;
        if (which === 1) return { success: true, message: 'refreshed 1 paths', resolvedServerPaths: ['/x'] };
        if (which === 2) return { success: false, message: 'rejected' };
        throw new ConnectorRequestError('boom', { retryable: false });
      });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      service.enqueue(2, 'import', ITEM(2));
      service.enqueue(3, 'import', ITEM(3));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, url: 'http://plex-1.local:32400' }),
        'Connector refresh dispatched',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 2, url: 'http://plex-2.local:32400' }),
        'Connector refresh rejected',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 3, url: 'http://plex-3.local:32400' }),
        'Connector refresh failed',
      );
    });

    it('redactBaseUrl robustness: null settings → [unknown], unparseable URL → [unparseable]', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true, message: 'ok' });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      vi.spyOn(service, 'getById').mockResolvedValueOnce(createMockDbConnector({ id: 1, settings: null }) as unknown as ConnectorRow);
      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      vi.spyOn(service, 'getById').mockResolvedValueOnce(createMockDbConnector({ id: 2, settings: { baseUrl: 'not a url', apiKey: 'k' } }) as unknown as ConnectorRow);
      service.enqueue(2, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 1, url: '[unknown]' }), 'Connector refresh dispatched');
      expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ connectorId: 2, url: '[unparseable]' }), 'Connector refresh dispatched');
    });

    it('flushes immediately at maxBatchItems without waiting for the debounce timer (F8)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 3 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      svc.enqueue(1, 'import', ITEM(1));
      svc.enqueue(1, 'import', ITEM(2));
      svc.enqueue(1, 'import', ITEM(3)); // hits the cap → immediate flush
      // Advance LESS than the debounce window: the flush must already have run.
      await vi.advanceTimersByTimeAsync(1);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
    });

    it('flushes at the maxBatchWaitMs deadline despite continuous debounce resets (F8)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: 1000, backoffMs: 0, flushTimeoutMs: 0, maxBatchWaitMs: 2500 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      svc.enqueue(1, 'import', ITEM(1));        // t=0, deadline at 2500
      await vi.advanceTimersByTimeAsync(900);   // t=900
      svc.enqueue(1, 'import', ITEM(2));        // resets debounce (would fire ~1900)
      await vi.advanceTimersByTimeAsync(900);   // t=1800
      svc.enqueue(1, 'import', ITEM(3));        // resets debounce (would fire ~2800)
      expect(refresh).not.toHaveBeenCalled();   // neither bound has fired yet
      await vi.advanceTimersByTimeAsync(700);   // t=2500 → deadline pre-empts debounce

      expect(refresh).toHaveBeenCalledTimes(1);
      expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items).toHaveLength(3);
    });

    it('aborts the signal passed into refreshImport when the outer flush timeout fires (F10)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 500 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      let captured: AbortSignal | undefined;
      const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise((_resolve, reject) => {
        captured = signal;
        signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
      }));
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts refreshImport
      await vi.advanceTimersByTimeAsync(500);      // outer timeout fires → signal aborts

      expect(captured?.aborted).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    // ── multi-request-aware timeout (#1506 AC1): the outer watchdog scales with
    //    the adapter's reported request count so a healthy multi-path Plex batch
    //    is not aborted mid-flush ────────────────────────────────────────────────
    it('scales the outer flush timeout by the adapter request count so a healthy multi-path batch is NOT aborted (AC1)', async () => {
      const BASE = CONNECTOR_TIMEOUT_MS + 5_000;       // single-request budget + margin
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      // Reports 3 sequential requests; takes 2.5 per-request timeouts total — over
      // the base budget but under the scaled budget (BASE + 2 * CONNECTOR_TIMEOUT_MS).
      const work = 2.5 * CONNECTOR_TIMEOUT_MS;
      const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ success: true }), work);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new ConnectorRequestError('aborted', { retryable: false })); });
      }));
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport'], 3));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts refreshImport
      await vi.advanceTimersByTimeAsync(work);     // request completes before the scaled budget fires

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(log.warn).not.toHaveBeenCalled(); // not aborted, not logged as failed
    });

    it('control: the SAME long work aborts at the base budget when the adapter reports a single request (AC1)', async () => {
      const BASE = CONNECTOR_TIMEOUT_MS + 5_000;
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: BASE });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      let captured: AbortSignal | undefined;
      const refresh = vi.fn((_b: ConnectorImportBatch, signal: AbortSignal) => new Promise((_resolve, reject) => {
        captured = signal;
        // Non-retryable so the abort doesn't trigger the retry path — keeps timing simple.
        signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable: false })));
      }));
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport'], 1));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await vi.advanceTimersByTimeAsync(BASE); // base single-request budget elapses → abort

      expect(captured?.aborted).toBe(true);
    });

    // ── per-connector in-flight serialization (#1506 AC2) ───────────────────────
    // A gated refreshImport that records peak concurrency per connector id.
    function gatedRefresh() {
      let inFlight = 0;
      let maxInFlight = 0;
      const gates: Array<() => void> = [];
      const batches: ConnectorImportBatch[] = [];
      const refresh = vi.fn((batch: ConnectorImportBatch) => {
        batches.push(batch);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<{ success: true }>((resolve) => {
          gates.push(() => { inFlight--; resolve({ success: true }); });
        });
      });
      return { refresh, gates, batches, get maxInFlight() { return maxInFlight; } };
    }

    it('cap-triggered flushes for one connector serialize — refreshImport never overlaps (AC2)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 2 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const g = gatedRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(g.refresh as unknown as ConnectorAdapter['refreshImport']));

      // Synchronous >maxBatchItems burst: the cap fires mid-flush, creating a fresh
      // pending entry for the SAME connector while the first flush is in flight.
      svc.enqueue(1, 'import', ITEM(1));
      svc.enqueue(1, 'import', ITEM(2)); // cap → flush #1
      svc.enqueue(1, 'import', ITEM(3));
      svc.enqueue(1, 'import', ITEM(4)); // cap → flush #2 (chained behind #1)
      await vi.advanceTimersByTimeAsync(0);

      expect(g.refresh).toHaveBeenCalledTimes(1); // only #1 entered; #2 is chained
      expect(g.maxInFlight).toBe(1);

      g.gates[0]!();                          // release #1
      await vi.advanceTimersByTimeAsync(0);

      expect(g.refresh).toHaveBeenCalledTimes(2); // #2 now runs — still serial
      expect(g.maxInFlight).toBe(1);
      g.gates[1]!();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('mixed-reason flushes for one connector serialize per connector id, not per (id, reason) key (F1)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const g = gatedRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(g.refresh as unknown as ConnectorAdapter['refreshImport']));

      // Two distinct reasons (separate pending keys) for the SAME connector id.
      svc.enqueue(1, 'import', ITEM(1));
      svc.enqueue(1, 'restored', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // both debounce timers fire → two flushes

      expect(g.refresh).toHaveBeenCalledTimes(1); // second reason chained behind the first
      expect(g.maxInFlight).toBe(1);

      g.gates[0]!();
      await vi.advanceTimersByTimeAsync(0);

      expect(g.refresh).toHaveBeenCalledTimes(2);
      expect(g.maxInFlight).toBe(1);
      expect(new Set(g.batches.map((b) => b.reason))).toEqual(new Set(['import', 'restored']));
      g.gates[1]!();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('different connector ids flush concurrently — serialization is per connector, not a global lock (AC2)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const g = gatedRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(g.refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      svc.enqueue(2, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(g.refresh).toHaveBeenCalledTimes(2); // both connectors run in parallel
      expect(g.maxInFlight).toBe(2);
      g.gates.forEach((release) => release());
      await vi.advanceTimersByTimeAsync(0);
    });

    it('an item enqueued while a flush is in flight is re-coalesced into a fresh batch, never dropped (AC2 boundary)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 1 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const g = gatedRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(g.refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1)); // maxBatchItems=1 → immediate flush #1
      await vi.advanceTimersByTimeAsync(0);
      expect(g.refresh).toHaveBeenCalledTimes(1); // #1 in flight (gated)

      // New item arrives during the in-flight window → fresh pending entry, immediate
      // flush (cap=1), chained behind the in-flight #1 rather than lost.
      svc.enqueue(1, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(0);
      expect(g.refresh).toHaveBeenCalledTimes(1); // still serialized — #2 chained, not entered

      g.gates[0]!();
      await vi.advanceTimersByTimeAsync(0);

      expect(g.refresh).toHaveBeenCalledTimes(2);
      expect(g.batches.map((b) => b.items.map((i) => i.bookId))).toEqual([[1], [2]]); // item 2 NOT dropped
      g.gates[1]!();
      await vi.advanceTimersByTimeAsync(0);
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

    // ── crash-path isolation: getById/getAdapter failures must NOT escape the
    //    detached flush as an unhandled rejection (#1497) ──────────────────────
    it('catches a getAdapter ZodError (drifted settings) — warn-logs, no crash, no refresh', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        const refresh = vi.fn();
        // Adapter construction throws on a settings-shape drift (strict schema parse).
        vi.spyOn(service, 'getAdapter').mockImplementation(() => {
          throw new z.ZodError([]);
        });

        service.enqueue(1, 'import', ITEM(1));
        await vi.advanceTimersByTimeAsync(DEBOUNCE);
        await vi.advanceTimersByTimeAsync(0);

        expect(refresh).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ connectorId: 1, reason: 'import', count: 1, error: expect.anything() }),
          'Connector refresh failed',
        );
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('catches a getById rejection (DB error) — warn-logs connectorId without dereferencing the undefined connector', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        vi.spyOn(service, 'getById').mockRejectedValue(new Error('db is down'));
        const adapterSpy = vi.spyOn(service, 'getAdapter');

        service.enqueue(7, 'import', ITEM(1));
        await vi.advanceTimersByTimeAsync(DEBOUNCE);
        await vi.advanceTimersByTimeAsync(0);

        // The catch must degrade to the queue entry's connectorId — connector is undefined.
        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ connectorId: 7, reason: 'import', count: 1, error: expect.anything() }),
          'Connector refresh failed',
        );
        // No adapter built, no second throw inside the catch, no unhandled rejection.
        expect(adapterSpy).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('catches an unknown-connector-type error from getAdapter — warn-logs, no crash', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        vi.spyOn(service, 'getAdapter').mockImplementation((c: ConnectorRow) => {
          throw new Error(`Unknown connector type: ${c.type}`);
        });

        service.enqueue(1, 'import', ITEM(1));
        await vi.advanceTimersByTimeAsync(DEBOUNCE);
        await vi.advanceTimersByTimeAsync(0);

        expect(log.warn).toHaveBeenCalledWith(
          expect.objectContaining({ connectorId: 1, error: expect.anything() }),
          'Connector refresh failed',
        );
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('removes the pending key after a failing flush so a later enqueue schedules a fresh flush', async () => {
      // First flush fails in getAdapter.
      const failing = vi.spyOn(service, 'getAdapter').mockImplementation(() => {
        throw new z.ZodError([]);
      });
      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      await vi.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalledTimes(1);

      // The key is gone (no stuck entry): a fresh enqueue + debounce flushes again.
      const refresh = vi.fn().mockResolvedValue({ success: true });
      failing.mockReturnValue(stubAdapter(refresh));
      service.enqueue(1, 'import', ITEM(2));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect((refresh.mock.calls[0]![0] as ConnectorImportBatch).items.map((i) => i.bookId)).toEqual([2]);
    });

    // ── shutdown drain: stop() (#1498) ──────────────────────────────────────────
    // A manually-gated refreshImport: each call parks until its gate is released.
    function deferredRefresh() {
      const gates: Array<() => void> = [];
      const refresh = vi.fn(() => new Promise<{ success: true }>((resolve) => {
        gates.push(() => resolve({ success: true }));
      }));
      return { refresh, gates };
    }

    it('stop() before the debounce window drops the pending batch (clear path): no flush, warn logged, no throw', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      await expect(service.stop()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // the cleared timers must NOT fire a flush

      expect(refresh).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, reason: 'import', count: 1 }),
        'Connector refresh dropped on shutdown',
      );
    });

    it('stop() awaits an in-flight flush — does not resolve until refreshImport settles', async () => {
      const { refresh, gates } = deferredRefresh();
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; refreshImport in flight (gated)
      expect(refresh).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = service.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false); // still awaiting the in-flight draining chain

      gates[0]!(); // settle refreshImport
      await stopPromise;
      expect(stopped).toBe(true);
    });

    it('stop() waits out an in-flight retry backoff (shutdown landing mid-backoff)', async () => {
      const BACKOFF = 500;
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: BACKOFF, flushTimeoutMs: 0 });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const refresh = vi.fn()
        .mockRejectedValueOnce(new ConnectorRequestError('5xx', { retryable: true }))
        .mockResolvedValueOnce({ success: true });
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; first attempt rejects → enters backoff sleep
      expect(refresh).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = svc.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false); // mid-backoff: the in-flight flush (in draining) hasn't settled

      await vi.advanceTimersByTimeAsync(BACKOFF * 1.3); // backoff (+ max jitter) elapses → retry runs & succeeds
      await stopPromise;
      expect(stopped).toBe(true);
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('enqueue() after stop() is a no-op — no flush scheduled or executed', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      await service.stop();
      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).not.toHaveBeenCalled();
    });

    it('unref()s the debounce, deadline, and request-timeout queue timers so none pins the event loop (AC3)', async () => {
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
        const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 1000 });
        vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
        const refresh = vi.fn().mockResolvedValue({ success: true });
        vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh));

        svc.enqueue(1, 'import', ITEM(1));       // arms debounce + deadline timers
        await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush → withTimeout arms the request-timeout timer

        expect(refresh).toHaveBeenCalledTimes(1);
        // debounce + deadline + request-timeout = 3 queue timers, every one unref()'d.
        expect(unrefs.length).toBeGreaterThanOrEqual(3);
        for (const u of unrefs) expect(u).toHaveBeenCalledTimes(1);
      } finally {
        vi.mocked(globalThis.setTimeout).mockRestore();
      }
    });

    it('warn-logs each dropped pending entry on stop() with connector id + item count', async () => {
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh));

      service.enqueue(1, 'import', ITEM(1));
      service.enqueue(1, 'import', ITEM(2)); // same (id, reason) entry → count 2
      service.enqueue(2, 'import', ITEM(3)); // distinct connector → its own entry

      await service.stop();
      await vi.advanceTimersByTimeAsync(DEBOUNCE);

      expect(refresh).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, reason: 'import', count: 2 }),
        'Connector refresh dropped on shutdown',
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 2, reason: 'import', count: 1 }),
        'Connector refresh dropped on shutdown',
      );
    });

    it('stop() is idempotent — a second call does not throw or re-flush', async () => {
      const { refresh, gates } = deferredRefresh();
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      service.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(refresh).toHaveBeenCalledTimes(1);

      const first = service.stop();
      const second = service.stop();
      gates[0]!();
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(refresh).toHaveBeenCalledTimes(1); // no duplicate flush
    });

    // ── bounded shutdown drain (#1512) ─────────────────────────────────────────
    const DRAIN = 5_000;

    // A refresh that records its AbortSignal and rejects when it fires — so the
    // in-flight attempt actually unwinds at the drain deadline.
    function abortAwareRefresh(retryable = false) {
      let captured: AbortSignal | undefined;
      const refresh = vi.fn((_batch: ConnectorImportBatch, signal: AbortSignal) => new Promise((_resolve, reject) => {
        captured = signal;
        signal.addEventListener('abort', () => reject(new ConnectorRequestError('aborted', { retryable })));
      }));
      return { refresh, get signal() { return captured; } };
    }

    it('stop() resolves within the shutdown drain budget even with a large in-flight Plex batch — bounded by shutdownDrainMs, NOT the scaled withTimeout budget (AC1)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: CONNECTOR_TIMEOUT_MS + 5_000, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const { refresh } = deferredRefresh(); // 500-path batch in flight, never settles on its own
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport'], 500));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE); // flush starts; in-flight in `draining`
      expect(refresh).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = svc.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(DRAIN - 1);
      expect(stopped).toBe(false); // still draining just under the budget
      await vi.advanceTimersByTimeAsync(1); // budget elapses → bounded resolve (NOT the ~7.5M ms scaled budget)
      await stopPromise;
      expect(stopped).toBe(true);
    });

    it('aborts the in-flight refresh signal when the drain budget elapses (AC2)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const a = abortAwareRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(a.refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(a.signal?.aborted).toBe(false);

      const stopPromise = svc.stop();
      await vi.advanceTimersByTimeAsync(DRAIN);
      await stopPromise;
      expect(a.signal?.aborted).toBe(true);
    });

    it('a deadline abort does NOT burn a retry — even when the abort error is retryable (AC3)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 1_000, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      // retryable:true proves it's the ABORT, not retryability, that stops the retry.
      const a = abortAwareRefresh(true);
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(a.refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      const stopPromise = svc.stop();
      await vi.advanceTimersByTimeAsync(DRAIN);
      await stopPromise;
      await vi.advanceTimersByTimeAsync(0);

      expect(a.refresh).toHaveBeenCalledTimes(1); // aborted attempt not retried
    });

    it('a chained draining tail does NOT start connector work after shutdown — dropped + warn-logged (AC4)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, maxBatchItems: 2, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const a = abortAwareRefresh(); // active attempt rejects on abort so the chain unwinds
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(a.refresh as unknown as ConnectorAdapter['refreshImport']));

      // Cap-triggered chain for ONE connector: #1 active, #2 queued behind it.
      svc.enqueue(1, 'import', ITEM(1));
      svc.enqueue(1, 'import', ITEM(2)); // cap → flush #1 (active)
      svc.enqueue(1, 'import', ITEM(3));
      svc.enqueue(1, 'import', ITEM(4)); // cap → flush #2 (chained tail)
      await vi.advanceTimersByTimeAsync(0);
      expect(a.refresh).toHaveBeenCalledTimes(1); // only #1 entered; #2 chained

      const stopPromise = svc.stop();
      await vi.advanceTimersByTimeAsync(DRAIN);
      await stopPromise;
      await vi.advanceTimersByTimeAsync(0); // let the active unwind + the tail short-circuit

      // The tail must never enter refreshImport, even after the active attempt unwound.
      expect(a.refresh).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorId: 1, reason: 'import', count: 2 }),
        'Connector refresh dropped on shutdown',
      );
    });

    it('warn-logs still-in-flight connectors as dropped at the drain deadline (AC5)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const { refresh } = deferredRefresh(); // never settles, ignores abort → still in flight at deadline
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      const stopPromise = svc.stop();
      await vi.advanceTimersByTimeAsync(DRAIN);
      await stopPromise;

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ connectorIds: [1], count: 1 }),
        'Connector refreshes dropped at shutdown drain deadline',
      );
    });

    it('a small batch that settles before the deadline drains fully — no premature abort, no dropped warn (regression)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const { refresh, gates } = deferredRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      expect(refresh).toHaveBeenCalledTimes(1);

      let stopped = false;
      const stopPromise = svc.stop().then(() => { stopped = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);

      gates[0]!(); // genuine completion well inside the budget
      await stopPromise;
      expect(stopped).toBe(true);
      expect(log.warn).not.toHaveBeenCalled(); // no premature deadline abort / dropped warn
    });

    it('a second stop() after the first bounded stop returned is a no-op — does not re-warn the deadline (F7)', async () => {
      const svc = new ConnectorService(db as never, log as never, { debounceMs: DEBOUNCE, backoffMs: 0, flushTimeoutMs: 0, shutdownDrainMs: DRAIN });
      vi.spyOn(svc, 'getById').mockImplementation(async (id: number) => connectorRow(id));
      const { refresh } = deferredRefresh();
      vi.spyOn(svc, 'getAdapter').mockReturnValue(stubAdapter(refresh as unknown as ConnectorAdapter['refreshImport']));

      svc.enqueue(1, 'import', ITEM(1));
      await vi.advanceTimersByTimeAsync(DEBOUNCE);
      const first = svc.stop();
      await vi.advanceTimersByTimeAsync(DRAIN); // first resolves at the deadline (drops + warns once)
      await first;

      const warnMock = log.warn as unknown as ReturnType<typeof vi.fn>;
      const deadlineWarns = () => warnMock.mock.calls.filter((c: unknown[]) => c[1] === 'Connector refreshes dropped at shutdown drain deadline');
      expect(deadlineWarns()).toHaveLength(1);

      await svc.stop(); // second call in the post-deadline window
      await vi.advanceTimersByTimeAsync(0);
      expect(deadlineWarns()).toHaveLength(1); // not re-warned
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
