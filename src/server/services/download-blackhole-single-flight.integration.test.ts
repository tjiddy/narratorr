import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { DownloadService } from './download.service.js';
import { DownloadOrchestrator } from './download-orchestrator.js';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { DownloadClientService } from './download-client.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { FastifyBaseLogger } from 'fastify';

// Exercise real service/orchestrator seams; broken coalescing doubles adapter add and DB insert.

const MAGNET = 'magnet:?xt=urn:btih:aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d&dn=BH';

const winnerRow = {
  id: 1, publicId: 'dl_bh', bookId: 5, indexerId: null, downloadClientId: 1,
  title: 'BH Release', protocol: 'torrent' as const, infoHash: 'aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d',
  downloadUrl: MAGNET, size: null, seeders: null,
  clientStatus: 'completed' as const, pipelineStage: 'idle' as const, progress: 1,
  externalId: null, errorMessage: null, guid: null, outputPath: null,
  bookStatusAtGrab: 'wanted' as const, addedAt: new Date(), completedAt: new Date(),
  progressUpdatedAt: null, pendingCleanup: null,
};

describe('Blackhole single-flight real-seam counts (#1857 F24/AC5)', () => {
  let db: ReturnType<typeof createMockDb>;
  let addDownload: Mock;
  let orch: DownloadOrchestrator;

  beforeEach(() => {
    db = createMockDb();
    // Insert returns the winner id for grab's re-read.
    db.insert.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    // Select order for ONE coalesced workflow run + two getById re-reads:
    //  1 workflow gather rows, 2 gather jobs, 3 book-status capture,
    //  4 dup-check gather rows, 5 dup-check gather jobs, 6+ getById.
    db.select
      .mockReturnValueOnce(mockDbChain([]))                         // 1
      .mockReturnValueOnce(mockDbChain([]))                         // 2
      .mockReturnValueOnce(mockDbChain([{ status: 'wanted' }]))     // 3
      .mockReturnValueOnce(mockDbChain([]))                         // 4
      .mockReturnValueOnce(mockDbChain([]))                         // 5
      .mockReturnValue(mockDbChain([{ download: winnerRow, book: null, indexer: null }])); // getById

    // Client-add seam — a Blackhole handoff returns null; counted.
    addDownload = vi.fn().mockResolvedValue(null);
    const adapter = { addDownload, removeDownload: vi.fn().mockResolvedValue(undefined) };
    const downloadClientService = inject<DownloadClientService>({
      getFirstEnabledForProtocol: vi.fn().mockResolvedValue({ id: 1, name: 'Blackhole', type: 'blackhole', settings: {} }),
      getAdapter: vi.fn().mockResolvedValue(adapter),
    });

    const log = inject<FastifyBaseLogger>(createMockLogger());
    const service = new DownloadService(db as unknown as Db, downloadClientService, log);
    const broadcaster = inject<EventBroadcasterService>({ emit: vi.fn() });
    orch = new DownloadOrchestrator(service, db as unknown as Db, log, undefined, undefined, broadcaster, undefined);
  });

  it('two identical concurrent confirmed replaces coalesce to exactly ONE client-add and ONE inserted winner row', async () => {
    const params = { downloadUrl: MAGNET, title: 'BH Release', bookId: 5, replace: true, guid: 'bh-guid' };

    const [d1, d2] = await Promise.all([orch.grabInternal(params), orch.grabInternal(params)]);

    expect(d1.id).toBe(1);
    expect(d2.id).toBe(1);
    expect(d1.externalId).toBeNull(); // Blackhole handoff (terminal)

    expect(addDownload).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
