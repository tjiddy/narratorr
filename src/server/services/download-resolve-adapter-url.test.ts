import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { resolveAdapterDownloadUrl, type ResolveAdapterUrlParams } from './download-resolve-adapter-url.js';
import { IndexerError } from '../../core/index.js';

function makeMockLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    silent: vi.fn(),
    level: 'info',
  } as unknown as FastifyBaseLogger;
}

function makeIndexerServiceMock(adapter: { resolveDownloadUrl?: ReturnType<typeof vi.fn> }) {
  return {
    getById: vi.fn().mockResolvedValue({ id: 1, name: 'MAM', type: 'myanonamouse', settings: {} }),
    getAdapter: vi.fn().mockResolvedValue(adapter),
  };
}

const baseParams: ResolveAdapterUrlParams = {
  downloadUrl: 'mam-torrent://12345',
  protocol: 'torrent',
  guid: '12345',
  indexerId: 1,
  title: 'Test Book',
};

describe('download-resolve-adapter-url', () => {
  let log: ReturnType<typeof makeMockLog>;

  beforeEach(() => {
    vi.resetAllMocks();
    log = makeMockLog();
  });

  it('skipped-mode-never does not emit any log', async () => {
    const adapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'data:torrent', wedgeOutcome: 'skipped-mode-never' as const }) };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    const debugMsgs = (log.debug as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1]);
    expect(debugMsgs).not.toContain('MAM wedge decision');
  });

  it('logWedgeOutcome for failed-spend includes wedgeCause in log payload', async () => {
    const adapter = {
      resolveDownloadUrl: vi.fn().mockResolvedValue({
        downloadUrl: 'data:torrent',
        wedgeOutcome: 'failed-spend' as const,
        wedgeCause: 'Network timeout after 10s',
      }),
    };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const payload = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).toMatchObject({
      indexerId: 1,
      title: 'Test Book',
      guid: '12345',
      wedgeOutcome: 'failed-spend',
      wedgeCause: 'Network timeout after 10s',
    });
  });

  it('logHookError for Required-mode failed-spend includes cause from IndexerError.cause', async () => {
    const innerCause = new Error('Transport failed: ECONNREFUSED');
    const indexerError = new IndexerError('MAM', 'MAM wedge spend failed in Required mode (failed-spend) for tid=12345', {
      wedgeOutcome: 'failed-spend',
      cause: innerCause,
    });
    const adapter = { resolveDownloadUrl: vi.fn().mockRejectedValue(indexerError) };
    const indexerService = makeIndexerServiceMock(adapter);

    await expect(resolveAdapterDownloadUrl(baseParams, log, indexerService as never)).rejects.toThrow();

    expect(log.warn).toHaveBeenCalledTimes(1);
    const payload = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).toMatchObject({
      indexerId: 1,
      title: 'Test Book',
      guid: '12345',
      wedgeOutcome: 'failed-spend',
      cause: 'Transport failed: ECONNREFUSED',
    });
  });

  it('buildLogPayload produces correct { indexerId, title, guid } shape in logWedgeOutcome', async () => {
    const adapter = {
      resolveDownloadUrl: vi.fn().mockResolvedValue({
        downloadUrl: 'data:torrent',
        wedgeOutcome: 'spent' as const,
      }),
    };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.info).toHaveBeenCalledTimes(1);
    const payload = (log.info as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).toEqual({ indexerId: 1, title: 'Test Book', guid: '12345' });
  });

  it('buildLogPayload produces correct shape in logHookError with spread fields', async () => {
    const indexerError = new IndexerError('MAM', 'Torrent fetch failed', { wedgeOutcome: 'spent' });
    const adapter = { resolveDownloadUrl: vi.fn().mockRejectedValue(indexerError) };
    const indexerService = makeIndexerServiceMock(adapter);

    await expect(resolveAdapterDownloadUrl(baseParams, log, indexerService as never)).rejects.toThrow();

    expect(log.error).toHaveBeenCalledTimes(1);
    const payload = (log.error as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(payload).toMatchObject({
      indexerId: 1,
      title: 'Test Book',
      guid: '12345',
      wedgeOutcome: 'spent',
      error: 'Torrent fetch failed',
    });
  });

  it('logWedgeOutcome for skipped-already-free includes isFreeleech and wedgeOutcome in debug payload', async () => {
    const adapter = {
      resolveDownloadUrl: vi.fn().mockResolvedValue({
        downloadUrl: 'data:torrent',
        wedgeOutcome: 'skipped-already-free' as const,
      }),
    };
    const indexerService = makeIndexerServiceMock(adapter);
    const params = { ...baseParams, isFreeleech: true };

    await resolveAdapterDownloadUrl(params, log, indexerService as never);

    const outcomeCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls.find(c => c[1] === 'MAM wedge decision');
    expect(outcomeCall).toBeTruthy();
    const payload = outcomeCall![0];
    expect(payload).toMatchObject({
      indexerId: 1,
      title: 'Test Book',
      guid: '12345',
      wedgeOutcome: 'skipped-already-free',
      isFreeleech: true,
    });
  });
});
