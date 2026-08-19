import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { useMswServer } from '@core/__tests__/msw/server.js';
import { servesFullList } from '@core/__tests__/qb-hash-filter.js';
import { QBittorrentClient } from '@core/download-clients/qbittorrent.js';
import { DownloadClientError } from '@core/download-clients/errors.js';
import { createMockDb, createMockLogger, inject, mockDbChain } from '../__tests__/helpers.js';
import { removeOrDeferTorrent } from './torrent-removal.helpers.js';
import { insertDownloadRecordOrCompensate, type InsertDownloadRecordCtx } from './download-record.js';
import { DownloadService } from './download.service.js';
import type { DownloadClientService } from './download-client.service.js';
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
