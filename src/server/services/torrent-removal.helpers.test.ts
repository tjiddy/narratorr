import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
  rm: vi.fn(),
}));

import { stat, rm } from 'node:fs/promises';
import { removeOrDeferTorrent, deleteDownloadOutputPath } from './torrent-removal.helpers.js';
import type { DownloadClientService } from './download-client.service.js';
import type { DownloadRow } from './types.js';
import { inject, createMockLogger } from '../__tests__/helpers.js';

const mockAdapter = {
  getDownload: vi.fn().mockResolvedValue({ ratio: 0.2 }),
  removeDownload: vi.fn().mockResolvedValue(undefined),
};

function createClientService(overrides?: Partial<DownloadClientService>): DownloadClientService {
  return inject<DownloadClientService>({
    getAdapter: vi.fn().mockResolvedValue(mockAdapter),
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'qBit', type: 'qbittorrent', enabled: true }),
    ...overrides,
  });
}

function makeDownload(overrides?: Partial<DownloadRow>): DownloadRow {
  return {
    id: 1, bookId: 1, title: 'Test', status: 'imported',
    externalId: 'ext-1', downloadClientId: 1, infoHash: 'abc',
    protocol: 'torrent', downloadUrl: null, size: 100,
    seeders: 1, progress: 1, errorMessage: null, guid: null,
    outputPath: null, addedAt: new Date(), completedAt: new Date(Date.now() - 7200_000),
    indexerId: 1, progressUpdatedAt: null, pendingCleanup: null,
    bookStatusAtGrab: 'wanted',
    ...overrides,
  } as DownloadRow;
}

function createDeps(clientService?: DownloadClientService) {
  const log = createMockLogger();
  return {
    deps: { downloadClientService: clientService ?? createClientService(), log: inject<FastifyBaseLogger>(log) },
    log,
  };
}

describe('removeOrDeferTorrent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.getDownload.mockResolvedValue({ ratio: 0.2 });
    mockAdapter.removeDownload.mockResolvedValue(undefined);
  });

  it('ratio gating OFF → does not fetch live ratio, defers on seed time only', async () => {
    const clientService = createClientService();
    const { deps } = createDeps(clientService);
    // minSeedTime 120 min, completed 1h ago → seed time not met → deferred
    const download = makeDownload({ completedAt: new Date(Date.now() - 3600_000) });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 120, minSeedRatio: 0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('deferred');
    expect(mockAdapter.getDownload).not.toHaveBeenCalled();
    expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
  });

  it('ratio gating OFF + seed time met → removes without fetching ratio', async () => {
    const { deps } = createDeps();
    const download = makeDownload({ completedAt: new Date(Date.now() - 7200_000) });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 60, minSeedRatio: 0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('removed');
    expect(mockAdapter.getDownload).not.toHaveBeenCalled();
    expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
  });

  it('ratio gating ON + ratio not met → deferred, does not call removeDownload', async () => {
    mockAdapter.getDownload.mockResolvedValue({ ratio: 0.5 });
    const { deps } = createDeps();
    const download = makeDownload();

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: false });

    expect(result).toEqual({ outcome: 'deferred', currentRatio: 0.5 });
    expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
  });

  it('ratio gating ON + ratio met → removed via removeDownload(externalId, true)', async () => {
    mockAdapter.getDownload.mockResolvedValue({ ratio: 1.5 });
    const { deps } = createDeps();
    const download = makeDownload();

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('removed');
    expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
  });

  it('ratio gating ON + live state unavailable + deferOnUnavailableRatio true → live-state-unavailable (import policy)', async () => {
    mockAdapter.getDownload.mockResolvedValue(null);
    const { deps } = createDeps();
    const download = makeDownload();

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: true });

    expect(result.outcome).toBe('live-state-unavailable');
    expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
  });

  it('ratio gating ON + adapter null + deferOnUnavailableRatio true → live-state-unavailable', async () => {
    const clientService = createClientService({ getAdapter: vi.fn().mockResolvedValue(null) });
    const { deps } = createDeps(clientService);
    const download = makeDownload();

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: true });

    expect(result.outcome).toBe('live-state-unavailable');
  });

  it('ratio gating ON + live state unavailable + deferOnUnavailableRatio false → folds to ratio 0, defers a torrent (QGO/deferred policy)', async () => {
    mockAdapter.getDownload.mockResolvedValue(null);
    const { deps } = createDeps();
    const download = makeDownload();

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: false });

    // 0 < minSeedRatio → deferred for a torrent
    expect(result).toEqual({ outcome: 'deferred', currentRatio: 0 });
    expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
  });

  it('usenet (non-torrent) + ratio unavailable + deferOnUnavailableRatio false → proceeds to removal (ratio ignored)', async () => {
    mockAdapter.getDownload.mockResolvedValue(null);
    const { deps } = createDeps();
    const download = makeDownload({ protocol: 'usenet' });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 60, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('removed');
    expect(mockAdapter.removeDownload).toHaveBeenCalledWith('ext-1', true);
  });

  it('removeDownload throws → remove-failed carrying the error', async () => {
    const err = new Error('client offline');
    mockAdapter.removeDownload.mockRejectedValue(err);
    const { deps } = createDeps();
    const download = makeDownload({ completedAt: new Date(Date.now() - 7200_000) });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 0 }, deps, { deferOnUnavailableRatio: false });

    expect(result).toEqual({ outcome: 'remove-failed', error: err });
  });

  it('proceed path with no adapter → no-adapter (no removeDownload call)', async () => {
    const clientService = createClientService({ getAdapter: vi.fn().mockResolvedValue(null) });
    const { deps } = createDeps(clientService);
    const download = makeDownload({ completedAt: new Date(Date.now() - 7200_000) });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('no-adapter');
    expect(mockAdapter.removeDownload).not.toHaveBeenCalled();
  });

  it('proceed path with missing externalId → no-adapter, getAdapter not consulted', async () => {
    const clientService = createClientService();
    const { deps } = createDeps(clientService);
    const download = makeDownload({ externalId: null, completedAt: new Date(Date.now() - 7200_000) });

    const result = await removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 0 }, deps, { deferOnUnavailableRatio: false });

    expect(result.outcome).toBe('no-adapter');
    expect(clientService.getAdapter).not.toHaveBeenCalled();
  });

  it('getDownload throwing during ratio fetch propagates (caller try/catch handles it)', async () => {
    mockAdapter.getDownload.mockRejectedValue(new Error('connection refused'));
    const { deps } = createDeps();
    const download = makeDownload();

    await expect(removeOrDeferTorrent(download, { minSeedTime: 0, minSeedRatio: 1.0 }, deps, { deferOnUnavailableRatio: true })).rejects.toThrow('connection refused');
  });
});

describe('deleteDownloadOutputPath', () => {
  let log: FastifyBaseLogger;

  beforeEach(() => {
    vi.clearAllMocks();
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  it('outputPath null → returns true, no rm call', async () => {
    const result = await deleteDownloadOutputPath(makeDownload({ outputPath: null }), log);

    expect(result).toBe(true);
    expect(stat).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it('path exists → rm called once with recursive+force, returns true', async () => {
    (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
    (rm as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const result = await deleteDownloadOutputPath(makeDownload({ outputPath: '/downloads/book' }), log);

    expect(result).toBe(true);
    expect(rm).toHaveBeenCalledTimes(1);
    expect(rm).toHaveBeenCalledWith('/downloads/book', { recursive: true, force: true });
  });

  it('stat rejects with ENOENT → early-out, no rm, returns true', async () => {
    (stat as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    const result = await deleteDownloadOutputPath(makeDownload({ outputPath: '/downloads/gone' }), log);

    expect(result).toBe(true);
    expect(rm).not.toHaveBeenCalled();
  });

  it('stat rejects with non-ENOENT error → no rm, returns false', async () => {
    (stat as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));

    const result = await deleteDownloadOutputPath(makeDownload({ outputPath: '/downloads/locked' }), log);

    expect(result).toBe(false);
    expect(rm).not.toHaveBeenCalled();
  });

  it('rm rejects → returns false', async () => {
    (stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isDirectory: () => true });
    (rm as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('EACCES'));

    const result = await deleteDownloadOutputPath(makeDownload({ outputPath: '/downloads/book' }), log);

    expect(result).toBe(false);
    expect(rm).toHaveBeenCalledTimes(1);
  });
});
