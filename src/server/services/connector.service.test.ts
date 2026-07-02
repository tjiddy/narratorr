import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { ConnectorService } from './connector.service.js';
import { FlushResolutionError, type PendingFlush, type ResolvedFlush } from './connector-refresh-queue.js';
import { mockDbChain, createMockDb, createMockLogger } from '../__tests__/helpers.js';
import { initializeKey, _resetKey, encrypt, isEncrypted, maskFields, makeTestSchema } from '../utils/secret-codec.js';
import { createMockDbConnector } from '../__tests__/factories.js';
import { connectorTypeSchema, connectorTargetsSettingsSchemas } from '../../shared/schemas/connector.js';
import { ConnectorRequestError, type ConnectorAdapter, type ConnectorImportBatch } from '../../core/connectors/index.js';
import { CONNECTOR_TIMEOUT_MS } from '../../core/utils/constants.js';
import type { ConnectorRow } from './types.js';

// Mock the network boundary only (the adapters' single transport call) so the
// REAL ADAPTER_FACTORIES -> createAdapter -> parseEntitySettings construction
// path runs in the listTargetsConfig regression test below (#1523 F1). The
// adapters are the only callers of fetchWithTimeout in this file's scope, so a
// module-level mock here doesn't touch the stubbed-adapter queue tests.
vi.mock('../../core/utils/network-service.js', () => ({
  fetchWithTimeout: vi.fn(),
}));
import { fetchWithTimeout } from '../../core/utils/network-service.js';

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

    // #1523 — a new connector fetches its dropdown before the selector is known.
    // listTargetsConfig must build the adapter through the targets-scoped schema
    // (selector optional), NOT the strict schema (which would throw on an empty
    // libraryId/sectionId before the adapter is ever built).
    it.each(['audiobookshelf', 'plex'] as const)(
      'listTargetsConfig builds the %s adapter via the targets-scoped schema (empty selector)',
      async (type) => {
        const service = new ConnectorService(db as never, log as never);
        const spy = vi
          .spyOn(service as unknown as { adapterForConfig: (...a: unknown[]) => Promise<unknown> }, 'adapterForConfig')
          .mockResolvedValue({
            type,
            test: vi.fn(),
            listTargets: vi.fn().mockResolvedValue([{ id: 'sel-1', name: 'First' }]),
            refreshImport: vi.fn(),
          } as never);

        const settings = type === 'audiobookshelf'
          ? { baseUrl: 'http://abs.local', apiKey: 'k' }
          : { baseUrl: 'http://plex.local', token: 't' };
        const result = await service.listTargetsConfig({ type, settings });

        expect(result).toEqual({ success: true, targets: [{ id: 'sel-1', name: 'First' }] });
        expect(spy).toHaveBeenCalledWith({ type, settings }, connectorTargetsSettingsSchemas);
      },
    );

    // #1523 F1 — exercise the REAL adapter-construction path (no adapterForConfig
    // mock): a new connector with an empty/missing selector must parse through the
    // targets-scoped schema, build the adapter, and reach listTargets() instead of
    // throwing at parseEntitySettings before the network call (the original bug).
    it.each([
      {
        type: 'audiobookshelf' as const,
        // libraryId omitted entirely — the regressed field.
        settings: { baseUrl: 'http://abs.local:13378', apiKey: 'real-key' },
        targetsUrl: 'http://abs.local:13378/api/libraries',
        body: { libraries: [{ id: 'lib-1', name: 'Audiobooks' }] },
      },
      {
        type: 'plex' as const,
        // sectionId omitted entirely — the regressed field.
        settings: { baseUrl: 'http://plex.local:32400', token: 'real-token' },
        targetsUrl: 'http://plex.local:32400/library/sections',
        body: { MediaContainer: { Directory: [{ key: 'lib-1', title: 'Audiobooks' }] } },
      },
    ])('listTargetsConfig builds the real $type adapter and reaches listTargets() with a missing selector', async ({ type, settings, targetsUrl, body }) => {
      const service = new ConnectorService(db as never, log as never);
      vi.mocked(fetchWithTimeout).mockResolvedValue({
        ok: true,
        json: async () => body,
      } as unknown as Response);

      const result = await service.listTargetsConfig({ type, settings });

      expect(result).toEqual({ success: true, targets: [{ id: 'lib-1', name: 'Audiobooks' }] });
      // The real adapter actually issued its single list-targets request — proves
      // construction did not throw on the absent selector before the network call.
      expect(fetchWithTimeout).toHaveBeenCalledWith(targetsUrl, expect.anything(), CONNECTOR_TIMEOUT_MS);
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

  // ── refresh queue: delegation + connector-specific resolver ──────────────────
  // The queue's own behavior (debounce/serialization/retry/timeout/drain/logging)
  // is exercised against ConnectorRefreshQueue directly in
  // connector-refresh-queue.test.ts. Here we cover the two ConnectorService-owned
  // seams: delegating notifyRefresh/stop to the queue, and the resolveFlush
  // callback that resolves a pending entry to the connector-specific request plan.
  describe('refresh queue delegation + resolver', () => {
    function connectorRow(id: number, enabled = true): ConnectorRow {
      return createMockDbConnector({ id, enabled }) as unknown as ConnectorRow;
    }
    const ITEM = (bookId: number) => ({ bookId, title: `Book ${bookId}`, libraryPath: `/lib/${bookId}` });
    // resolveFlush only reads connectorId/reasons/items — timers are unused here.
    function entry(connectorId: number, reasons: PendingFlush['reasons'] = ['import'], items = [ITEM(1)]): PendingFlush {
      return { connectorId, reasons, items, timer: 0 as never, deadlineTimer: 0 as never };
    }
    function resolveFlush(service: ConnectorService, e: PendingFlush): Promise<ResolvedFlush | null> {
      return (service as unknown as { resolveFlush: (e: PendingFlush) => Promise<ResolvedFlush | null> }).resolveFlush(e);
    }

    // ── delegation ─────────────────────────────────────────────────────────────
    it('notifyRefresh enumerates enabled connectors and delegates one queue.enqueue per (connector × item)', async () => {
      const service = new ConnectorService(db as never, log as never);
      db.select.mockReturnValue(mockDbChain([createMockDbConnector({ id: 1 }), createMockDbConnector({ id: 2 })]));
      const enqueueSpy = vi.spyOn(service['queue'], 'enqueue').mockImplementation(() => {});

      await service.notifyRefresh('import', [ITEM(1), ITEM(2)]);

      expect(enqueueSpy).toHaveBeenCalledTimes(4);
      expect(enqueueSpy).toHaveBeenCalledWith(1, 'import', expect.objectContaining({ bookId: 1 }));
      expect(enqueueSpy).toHaveBeenCalledWith(2, 'import', expect.objectContaining({ bookId: 2 }));
    });

    it('notifyRefresh with no items is a no-op that never enumerates or touches the queue', async () => {
      const service = new ConnectorService(db as never, log as never);
      const enqueueSpy = vi.spyOn(service['queue'], 'enqueue');
      await service.notifyRefresh('import', []);
      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    });

    it('stop() forwards to queue.stop()', async () => {
      const service = new ConnectorService(db as never, log as never);
      const stopSpy = vi.spyOn(service['queue'], 'stop').mockResolvedValue();
      await service.stop();
      expect(stopSpy).toHaveBeenCalledTimes(1);
    });

    // ── resolver: skip / resolve / failure-context (the extraction seam) ─────────
    it('resolveFlush returns null (skip) when the connector is disabled at flush time — adapter never resolved', async () => {
      // Ports the pre-extraction "skips the flush when the connector is disabled at
      // flush time" onto the resolver: null → the queue treats it as a no-op skip.
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1, false));
      const getAdapterSpy = vi.spyOn(service, 'getAdapter');

      await expect(resolveFlush(service, entry(1))).resolves.toBeNull();
      expect(getAdapterSpy).not.toHaveBeenCalled();
    });

    it('resolveFlush returns null (skip) when the connector was deleted before the flush', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(null);
      const getAdapterSpy = vi.spyOn(service, 'getAdapter');

      await expect(resolveFlush(service, entry(1))).resolves.toBeNull();
      expect(getAdapterSpy).not.toHaveBeenCalled();
    });

    it('resolveFlush resolves an enabled row to { requestCount, logContext, run } — run invokes refreshImport with the batch + signal', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1));
      const refresh = vi.fn().mockResolvedValue({ success: true });
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(refresh, 2));

      const resolved = await resolveFlush(service, entry(1, ['import', 'restored'], [ITEM(1), ITEM(2)]));
      expect(resolved).not.toBeNull();
      expect(resolved!.requestCount).toBe(2);
      // NO connectorName leak into the success context assembly — that field is only
      // read on the failed branch; the queue merges reasons/count from the entry.
      expect(resolved!.logContext).toEqual({ connectorId: 1, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378' });

      const signal = new AbortController().signal;
      await resolved!.run(signal);
      const batch = refresh.mock.calls[0]![0] as ConnectorImportBatch;
      expect(batch.reasons).toEqual(['import', 'restored']);
      expect(batch.items.map((i) => i.bookId)).toEqual([1, 2]);
      expect(refresh.mock.calls[0]![1]).toBe(signal);
    });

    it('resolveFlush clamps the reported request count to at least 1', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1));
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(vi.fn().mockResolvedValue({ success: true }), 0));

      const resolved = await resolveFlush(service, entry(1));
      expect(resolved!.requestCount).toBe(1);
    });

    it('resolveFlush derives the redacted host: null settings → [unknown], unparseable URL → [unparseable]', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getAdapter').mockReturnValue(stubAdapter(vi.fn().mockResolvedValue({ success: true })));

      vi.spyOn(service, 'getById').mockResolvedValueOnce(createMockDbConnector({ id: 1, settings: null }) as unknown as ConnectorRow);
      const r1 = await resolveFlush(service, entry(1));
      expect(r1!.logContext.url).toBe('[unknown]');

      vi.spyOn(service, 'getById').mockResolvedValueOnce(createMockDbConnector({ id: 2, settings: { baseUrl: 'not a url', apiKey: 'k' } }) as unknown as ConnectorRow);
      const r2 = await resolveFlush(service, entry(2));
      expect(r2!.logContext.url).toBe('[unparseable]');
    });

    // The F5 guard on the ConnectorService side: a getAdapter failure AFTER the row
    // resolved must surface the connector-derived context so the queue's failed-flush
    // warn keeps type/name/url (the redacted host that disambiguates same-type
    // connectors at 3am), rather than degrading them.
    it('resolveFlush wraps a getAdapter ZodError (drifted settings) in FlushResolutionError carrying the full logContext + original error', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1));
      const zodErr = new z.ZodError([]);
      vi.spyOn(service, 'getAdapter').mockImplementation(() => { throw zodErr; });

      let caught: FlushResolutionError | undefined;
      try { await resolveFlush(service, entry(1)); } catch (e) { caught = e as FlushResolutionError; }
      expect(caught).toBeInstanceOf(FlushResolutionError);
      expect(caught!.logContext).toEqual({ connectorId: 1, connectorType: 'audiobookshelf', connectorName: 'Test ABS', url: 'http://abs.local:13378' });
      expect(caught!.cause).toBe(zodErr);
    });

    it('resolveFlush wraps an unknown-connector-type getAdapter error in FlushResolutionError with context', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockResolvedValue(connectorRow(1));
      vi.spyOn(service, 'getAdapter').mockImplementation((c: ConnectorRow) => { throw new Error(`Unknown connector type: ${c.type}`); });

      let caught: FlushResolutionError | undefined;
      try { await resolveFlush(service, entry(1)); } catch (e) { caught = e as FlushResolutionError; }
      expect(caught).toBeInstanceOf(FlushResolutionError);
      expect(caught!.logContext).toMatchObject({ connectorId: 1, connectorType: 'audiobookshelf' });
    });

    it('resolveFlush lets a getById rejection propagate BARE (not wrapped) — no row existed, so the queue degrades the context', async () => {
      const service = new ConnectorService(db as never, log as never);
      vi.spyOn(service, 'getById').mockRejectedValue(new Error('db is down'));
      const getAdapterSpy = vi.spyOn(service, 'getAdapter');

      let caught: unknown;
      try { await resolveFlush(service, entry(1)); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(FlushResolutionError);
      expect((caught as Error).message).toBe('db is down');
      expect(getAdapterSpy).not.toHaveBeenCalled();
    });
  });
});
