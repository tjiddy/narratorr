import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { servesFullList } from '@core/__tests__/qb-hash-filter.js';
import { transmissionSelects } from '@core/__tests__/download-client-id-semantics.js';
import { QBittorrentClient } from '@core/download-clients/qbittorrent.js';
import { TransmissionClient } from '@core/download-clients/transmission.js';
import { DownloadClientError } from '@core/download-clients/errors.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { removeOrDeferTorrent } from './torrent-removal.helpers.js';
import { insertDownloadRecordOrCompensate, type InsertDownloadRecordCtx } from './download-record.js';
import { DownloadService } from './download.service.js';
import { ImportService } from './import.service.js';
import { monitorDownloads, type MonitorRetryDeps } from '../jobs/monitor.js';
import type { DownloadClientService } from './download-client.service.js';
import type { NotifierService } from './notifier.service.js';
import type { SettingsService } from './settings.service.js';
import type { DownloadRow } from './types.js';

/**
 * #2485 — `downloads.external_id` is nullable text and every server-side caller guards on FALSY,
 * so a whitespace-only id is truthy and reaches the adapter. The adapter now refuses it; these
 * cases pin what each caller does with that refusal. They drive the REAL QBittorrentClient over
 * MSW deliberately: a fake adapter that rejects proves only the caller's catch, not that the
 * adapter ever rejects ([[degrading-adapter-invisible-to-mock-suite]]).
 */
describe('#2485 a blank external id through the server call sites', () => {
  const server = useMswServer();
  const BASE_URL = 'http://localhost:8080';
  const VALID = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
  const BLANK = '   ';

  /** An unrelated torrent, so an adapter that probed a blank filter would have one to delete. */
  const unrelated = {
    hash: '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b',
    name: "Someone Else's Audiobook",
    state: 'uploading',
    progress: 1,
    total_size: 1_000_000,
    downloaded: 1_000_000,
    uploaded: 2_000_000,
    ratio: 2,
    num_seeds: 1,
    num_leechs: 0,
    eta: 0,
    save_path: '/downloads',
    added_on: 1_700_000_000,
    completion_on: 1_700_003_600,
  };

  let client: QBittorrentClient;
  let deletes: string[];
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    client = new QBittorrentClient({
      host: 'localhost', port: 8080, username: 'admin', password: 'password', useSsl: false,
    });
    deletes = [];
    log = createMockLogger();

    server.use(
      http.post(`${BASE_URL}/api/v2/auth/login`, () => new HttpResponse('Ok.', {
        headers: { 'Set-Cookie': 'SID=test-session-id; path=/' },
      })),
      // The real client's semantics: an ineffective `hashes` filter answers the FULL list.
      http.get(`${BASE_URL}/api/v2/torrents/info`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (servesFullList(params) || params.get('hashes') === VALID) {
          return HttpResponse.json([{ ...unrelated, ...(params.get('hashes') === VALID ? { hash: VALID } : {}) }]);
        }
        return HttpResponse.json([]);
      }),
      http.post(`${BASE_URL}/api/v2/torrents/delete`, async ({ request }) => {
        deletes.push(await request.text());
        return new HttpResponse('');
      }),
    );
  });

  function clientService(): DownloadClientService {
    return inject<DownloadClientService>({ getAdapter: vi.fn().mockResolvedValue(client) });
  }

  describe('removeOrDeferTorrent', () => {
    function makeDownload(externalId: string): DownloadRow {
      return inject<DownloadRow>({
        id: 1, bookId: 1, title: 'Test', status: 'imported',
        externalId, downloadClientId: 1, infoHash: 'abc',
        protocol: 'torrent', downloadUrl: null, size: 100,
        seeders: 1, progress: 1, errorMessage: null, guid: null,
        outputPath: null, addedAt: new Date(), completedAt: new Date(Date.now() - 7_200_000),
        indexerId: 1, progressUpdatedAt: null, pendingCleanup: null,
        bookStatusAtGrab: 'wanted',
      });
    }

    const removeWith = (externalId: string) => removeOrDeferTorrent(
      makeDownload(externalId),
      { minSeedTime: 0, minSeedRatio: 0 },
      { downloadClientService: clientService(), log: inject<FastifyBaseLogger>(log) },
      { deferOnUnavailableRatio: false },
    );

    it('folds the refusal into remove-failed rather than letting it escape, deleting nothing', async () => {
      const result = await removeWith(BLANK);

      expect(result.outcome).toBe('remove-failed');
      expect((result as { error: unknown }).error).toBeInstanceOf(DownloadClientError);
      expect(deletes).toEqual([]);
    });

    // Without this the assertion above passes just as well against "removal never reaches the client".
    it('control: a valid external id still deletes the torrent with its files', async () => {
      const result = await removeWith(VALID);

      expect(result.outcome).toBe('removed');
      expect(deletes).toHaveLength(1);
      expect(new URLSearchParams(deletes[0]!).get('hashes')).toBe(VALID);
    });
  });

  describe('DownloadService.removeExternalItem', () => {
    function service(): DownloadService {
      return new DownloadService(
        inject<Db>(createMockDb()),
        clientService(),
        inject<FastifyBaseLogger>(log),
      );
    }

    it('swallows and logs the refusal so the surrounding cancel/replace flow completes', async () => {
      await expect(
        service().removeExternalItem({ id: 5, downloadClientId: 1, externalId: BLANK }),
      ).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ id: 5, error: expect.objectContaining({ type: 'DownloadClientError' }) }),
        'Failed to remove download from client',
      );
      expect(deletes).toEqual([]);
    });

    it('control: a valid external id removes with files and logs no error', async () => {
      await service().removeExternalItem({ id: 5, downloadClientId: 1, externalId: VALID });

      expect(deletes).toHaveLength(1);
      expect(new URLSearchParams(deletes[0]!).get('deleteFiles')).toBe('true');
      expect(log.error).not.toHaveBeenCalled();
    });
  });

  describe('insertDownloadRecordOrCompensate orphan compensation', () => {
    const insertError = new Error('SQLITE_FULL');

    function runWith(externalId: string) {
      const db = createMockDb();
      db.insert.mockReturnValue(mockDbChain([], { error: insertError }));
      const ctx: InsertDownloadRecordCtx = {
        effectiveDownloadUrl: `magnet:?xt=urn:btih:${VALID}`,
        protocol: 'torrent',
        infoHash: VALID,
        clientId: 1,
        clientType: 'qbittorrent',
        externalId,
        staged: null,
      };
      return insertDownloadRecordOrCompensate(
        inject<Db>(db),
        inject<FastifyBaseLogger>(log),
        { title: 'The Way of Kings', bookId: 1, indexerId: 2, guid: 'guid-1' },
        ctx,
        () => Promise.resolve(client),
      );
    }

    it('warns that the external download is orphaned instead of deleting an unrelated torrent', async () => {
      await expect(runWith(BLANK)).rejects.toBe(insertError);

      expect(deletes).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: BLANK, clientId: 1, error: expect.objectContaining({ type: 'DownloadClientError' }) }),
        'Download insert failed AND compensation removeDownload failed — orphaned external download (operator recovery needed)',
      );
    });

    it('control: a valid external id is compensated away and warns nothing', async () => {
      await expect(runWith(VALID)).rejects.toBe(insertError);

      expect(deletes).toHaveLength(1);
      expect((log.warn as Mock)).not.toHaveBeenCalled();
    });
  });
});

/**
 * #2488 — the same seam, driven over the REAL TransmissionClient. Transmission is the adapter the
 * issue names: an OMITTED `ids` means every torrent (rpc-spec.md §3.1), so `torrent-remove` with
 * `delete-local-data` is one dropped key away from the whole session. Every case here uses the
 * real client over MSW, never an injected rejecting fake — a fake proves the caller's `catch` and
 * nothing about whether the adapter rejects ([[degrading-adapter-invisible-to-mock-suite]]).
 */
describe('#2488 a blank external id through the server call sites (Transmission)', () => {
  const server = useMswServer();
  const BASE_URL = 'http://localhost:9091';
  const RPC_URL = `${BASE_URL}/transmission/rpc`;
  const VALID = 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00';
  const BLANK = '   ';

  /** An unrelated torrent, so an adapter probing an `ids`-less request would have one to delete. */
  const unrelated = {
    hashString: '351c0c2d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b',
    name: "Someone Else's Audiobook",
    status: 6,
    percentDone: 1,
    totalSize: 1_000_000,
    downloadedEver: 1_000_000,
    uploadedEver: 2_000_000,
    uploadRatio: 2,
    peersSendingToUs: 1,
    peersGettingFromUs: 0,
    eta: 0,
    downloadDir: '/downloads',
    addedDate: 1_700_000_000,
    doneDate: 1_700_003_600,
    errorString: '',
    leftUntilDone: 0,
  };
  const grabbed = { ...unrelated, hashString: VALID, name: 'The Way of Kings' };

  let client: TransmissionClient;
  let removals: Array<{ ids: unknown; deleteLocalData: unknown }>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    client = new TransmissionClient({
      host: 'localhost', port: 9091, username: 'admin', password: 'password', useSsl: false,
    });
    removals = [];
    log = createMockLogger();

    server.use(
      http.post(RPC_URL, async ({ request }) => {
        const body = await request.json() as { method: string; arguments?: Record<string, unknown> };
        if (body.method === 'torrent-remove') {
          // The modelled server acts on exactly what `ids` named — nothing on an ineffective one.
          for (const torrent of transmissionSelects(body.arguments?.ids, [unrelated, grabbed])) {
            removals.push({ ids: torrent.hashString, deleteLocalData: body.arguments?.['delete-local-data'] });
          }
          return HttpResponse.json({ result: 'success', arguments: {} });
        }
        return HttpResponse.json({
          result: 'success',
          arguments: { torrents: transmissionSelects(body.arguments?.ids, [unrelated, grabbed]) },
        });
      }),
    );
  });

  function clientService(): DownloadClientService {
    return inject<DownloadClientService>({
      getAdapter: vi.fn().mockResolvedValue(client),
      getById: vi.fn().mockResolvedValue({ id: 1, type: 'transmission' }),
    });
  }

  function makeDownload(externalId: string, overrides: Partial<DownloadRow> = {}): DownloadRow {
    return inject<DownloadRow>({
      id: 1, bookId: 1, title: 'The Way of Kings', status: 'imported',
      externalId, downloadClientId: 1, infoHash: 'abc',
      protocol: 'torrent', downloadUrl: null, size: 100,
      seeders: 1, progress: 1, errorMessage: null, guid: null,
      outputPath: null, addedAt: new Date(), completedAt: new Date(Date.now() - 7_200_000),
      indexerId: 1, progressUpdatedAt: null, pendingCleanup: null,
      bookStatusAtGrab: 'wanted',
      ...overrides,
    });
  }

  describe('removeOrDeferTorrent', () => {
    const removeWith = (externalId: string) => removeOrDeferTorrent(
      makeDownload(externalId),
      { minSeedTime: 0, minSeedRatio: 0 },
      { downloadClientService: clientService(), log: inject<FastifyBaseLogger>(log) },
      { deferOnUnavailableRatio: false },
    );

    it('folds the refusal into remove-failed rather than letting it escape, deleting nothing', async () => {
      const result = await removeWith(BLANK);

      expect(result.outcome).toBe('remove-failed');
      expect((result as { error: unknown }).error).toBeInstanceOf(DownloadClientError);
      expect(removals).toEqual([]);
    });

    // Without this the assertion above passes just as well against "removal never reaches the client".
    it('control: a valid external id still deletes the torrent with its files', async () => {
      const result = await removeWith(VALID);

      expect(result.outcome).toBe('removed');
      expect(removals).toEqual([{ ids: VALID, deleteLocalData: true }]);
    });

    /**
     * AC7 — the ratio arm. A blank id's `null` read yields `live-state-unavailable`, which the
     * import callers turn into a deferral. This is unchanged from today (an unresolvable id
     * already produced a null ratio); the case pins it rather than adding it.
     */
    it('reports live-state-unavailable when a ratio gate has to read a blank id first', async () => {
      const result = await removeOrDeferTorrent(
        makeDownload(BLANK),
        { minSeedTime: 0, minSeedRatio: 1.0 },
        { downloadClientService: clientService(), log: inject<FastifyBaseLogger>(log) },
        { deferOnUnavailableRatio: true },
      );

      expect(result.outcome).toBe('live-state-unavailable');
      expect(removals).toEqual([]);
    });

    it('control: the same ratio gate reads a valid id and removes on a satisfied ratio', async () => {
      const result = await removeOrDeferTorrent(
        makeDownload(VALID),
        { minSeedTime: 0, minSeedRatio: 1.0 },
        { downloadClientService: clientService(), log: inject<FastifyBaseLogger>(log) },
        { deferOnUnavailableRatio: true },
      );

      expect(result.outcome).toBe('removed');
      expect(removals).toEqual([{ ids: VALID, deleteLocalData: true }]);
    });
  });

  describe('DownloadService.removeExternalItem', () => {
    function service(): DownloadService {
      return new DownloadService(
        inject<Db>(createMockDb()),
        clientService(),
        inject<FastifyBaseLogger>(log),
      );
    }

    it('swallows and logs the refusal so the surrounding cancel/replace flow completes', async () => {
      await expect(
        service().removeExternalItem({ id: 5, downloadClientId: 1, externalId: BLANK }),
      ).resolves.toBeUndefined();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ id: 5, error: expect.objectContaining({ type: 'DownloadClientError' }) }),
        'Failed to remove download from client',
      );
      expect(removals).toEqual([]);
    });

    it('control: a valid external id removes with files and logs no error', async () => {
      await service().removeExternalItem({ id: 5, downloadClientId: 1, externalId: VALID });

      expect(removals).toEqual([{ ids: VALID, deleteLocalData: true }]);
      expect(log.error).not.toHaveBeenCalled();
    });
  });

  describe('insertDownloadRecordOrCompensate orphan compensation', () => {
    const insertError = new Error('SQLITE_FULL');

    function runWith(externalId: string) {
      const db = createMockDb();
      db.insert.mockReturnValue(mockDbChain([], { error: insertError }));
      const ctx: InsertDownloadRecordCtx = {
        effectiveDownloadUrl: `magnet:?xt=urn:btih:${VALID}`,
        protocol: 'torrent',
        infoHash: VALID,
        clientId: 1,
        clientType: 'transmission',
        externalId,
        staged: null,
      };
      return insertDownloadRecordOrCompensate(
        inject<Db>(db),
        inject<FastifyBaseLogger>(log),
        { title: 'The Way of Kings', bookId: 1, indexerId: 2, guid: 'guid-1' },
        ctx,
        () => Promise.resolve(client),
      );
    }

    it('warns that the external download is orphaned instead of deleting an unrelated torrent', async () => {
      await expect(runWith(BLANK)).rejects.toBe(insertError);

      expect(removals).toEqual([]);
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ externalId: BLANK, clientId: 1, error: expect.objectContaining({ type: 'DownloadClientError' }) }),
        'Download insert failed AND compensation removeDownload failed — orphaned external download (operator recovery needed)',
      );
    });

    it('control: a valid external id is compensated away and warns nothing', async () => {
      await expect(runWith(VALID)).rejects.toBe(insertError);

      expect(removals).toEqual([{ ids: VALID, deleteLocalData: true }]);
      expect((log.warn as Mock)).not.toHaveBeenCalled();
    });
  });

  /**
   * AC7's reason reads must resolve `null` rather than throw: monitor's per-download `catch`
   * escalates a thrown read through `blacklistOnInfraError`, temporarily blacklisting a release
   * over what is really a bad stored id. A `null` takes the intended missing-item path instead.
   */
  describe('monitorDownloads', () => {
    let db: ReturnType<typeof createMockDb>;
    let updateChain: ReturnType<typeof mockDbChain>;
    let blacklistService: { create: Mock };

    beforeEach(() => {
      db = createMockDb();
      updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);
      blacklistService = { create: vi.fn().mockResolvedValue(undefined) };
    });

    /** bookId is null so handleMissingItem's retry/recovery arms stay out of this case. */
    function seedRow(externalId: string) {
      db.select.mockReturnValueOnce(mockDbChain([{
        id: 1, externalId, downloadClientId: 1,
        clientStatus: 'downloading', pipelineStage: 'idle',
        bookId: null, title: 'The Way of Kings', infoHash: 'abc123', guid: 'guid-1',
        completedAt: null, progress: 0, outputPath: null,
        // Well outside the add grace window, so a missing item fails the row rather than waiting.
        addedAt: new Date(Date.now() - 60 * 60_000),
      }]));
    }

    async function runCycle() {
      await monitorDownloads(
        inject<Db>(db),
        clientService(),
        inject<NotifierService>({ notify: vi.fn().mockResolvedValue(undefined) }),
        inject<FastifyBaseLogger>(log),
        inject<MonitorRetryDeps>({ blacklistService, retrySearchDeps: {} }),
      );
    }

    function writtenPayloads() {
      return (updateChain.set as Mock).mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    }

    it('takes the missing-item path for a blank-id row and never blacklists it as infra', async () => {
      seedRow(BLANK);

      await runCycle();

      expect(writtenPayloads()).toContainEqual(
        expect.objectContaining({ clientStatus: 'failed', errorMessage: 'Download not found in download client' }),
      );
      expect(blacklistService.create).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalledWith(expect.anything(), 'Error monitoring download');
    });

    it('control: a valid external id records progress from the same client', async () => {
      seedRow(VALID);

      await runCycle();

      // The outputPath can only come from the real client's payload, so this cannot pass against
      // a cycle that simply did nothing.
      expect(writtenPayloads()).toContainEqual(
        expect.objectContaining({
          clientStatus: 'completed',
          progress: 1,
          outputPath: '/downloads/The Way of Kings',
        }),
      );
      expect(writtenPayloads().some((p) => p.clientStatus === 'failed')).toBe(false);
    });
  });

  /**
   * AC7 — `cleanupDeferredImports` catches per row (`import.service.ts:369-380`), so one blank-id
   * row must not starve the rest of the cycle. The blank row is FIRST, so an escaping throw would
   * visibly leave the second candidate unprocessed.
   */
  describe('ImportService.cleanupDeferredImports', () => {
    // minSeedRatio must be 0: a non-zero one defers on the blank row's null ratio before
    // removeDownload is ever called, and the continuation guarantee would go unproven.
    const IMPORT_SETTINGS = { deleteAfterImport: true, minSeedTime: 0, minSeedRatio: 0 };

    function runWith(candidates: DownloadRow[]) {
      const db = createMockDb();
      db.select.mockReturnValue(mockDbChain(candidates));
      const updateChain = mockDbChain([{ id: 1 }]);
      db.update.mockReturnValue(updateChain);

      const service = new ImportService(
        inject<Db>(db),
        clientService(),
        inject<SettingsService>({ get: vi.fn().mockResolvedValue(IMPORT_SETTINGS) }),
        inject<FastifyBaseLogger>(log),
      );

      return {
        run: () => service.cleanupDeferredImports(),
        cleared: () => (updateChain.set as Mock).mock.calls
          .map((c: unknown[]) => c[0] as Record<string, unknown>)
          .filter((p) => p.pendingCleanup === null),
      };
    }

    it('logs the blank row, keeps its marker, and still processes the candidate behind it', async () => {
      const harness = runWith([
        makeDownload(BLANK, { id: 1, pendingCleanup: new Date() }),
        makeDownload(VALID, { id: 2, pendingCleanup: new Date() }),
      ]);

      await harness.run();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ downloadId: 1, error: expect.objectContaining({ type: 'DownloadClientError' }) }),
        'Failed deferred torrent removal — will retry next cycle',
      );
      // The blank row's marker survives for the next cycle; only the valid row's is cleared.
      expect(harness.cleared()).toHaveLength(1);
      expect(removals).toEqual([{ ids: VALID, deleteLocalData: true }]);
    });

    it('control: two valid rows produce two deletes, two cleared markers, and no error log', async () => {
      const harness = runWith([
        makeDownload(VALID, { id: 1, pendingCleanup: new Date() }),
        makeDownload(VALID, { id: 2, pendingCleanup: new Date() }),
      ]);

      await harness.run();

      expect(removals).toHaveLength(2);
      expect(harness.cleared()).toHaveLength(2);
      expect(log.error).not.toHaveBeenCalled();
    });
  });
});
