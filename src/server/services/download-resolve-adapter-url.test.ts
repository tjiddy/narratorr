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

  it('wedgeRequested=true emits a single debug "&fl sent" line and no info/warn/error', async () => {
    const adapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'data:torrent', wedgeRequested: true }) };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    const wedgeCall = (log.debug as ReturnType<typeof vi.fn>).mock.calls.find(c => c[1] === 'MAM freeleech wedge requested (&fl sent)');
    expect(wedgeCall).toBeTruthy();
    expect(wedgeCall![0]).toMatchObject({ indexerId: 1, title: 'Test Book', guid: '12345', wedgeRequested: true });
  });

  it('wedgeRequested=false emits nothing wedge-specific', async () => {
    const adapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'data:torrent', wedgeRequested: false }) };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    const debugMsgs = (log.debug as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1]);
    expect(debugMsgs).not.toContain('MAM freeleech wedge requested (&fl sent)');
  });

  it('missing wedgeRequested (non-MAM adapter) emits nothing wedge-specific', async () => {
    const adapter = { resolveDownloadUrl: vi.fn().mockResolvedValue({ downloadUrl: 'data:torrent' }) };
    const indexerService = makeIndexerServiceMock(adapter);

    await resolveAdapterDownloadUrl(baseParams, log, indexerService as never);

    expect(log.warn).not.toHaveBeenCalled();
    const debugMsgs = (log.debug as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1]);
    expect(debugMsgs).not.toContain('MAM freeleech wedge requested (&fl sent)');
  });

  it('thrown IndexerError logs a single warn "Indexer resolveDownloadUrl failed" with cause', async () => {
    const innerCause = new Error('Transport failed: ECONNREFUSED');
    const indexerError = new IndexerError('MAM', 'MAM torrent fetch failed for tid=12345', { cause: innerCause });
    const adapter = { resolveDownloadUrl: vi.fn().mockRejectedValue(indexerError) };
    const indexerService = makeIndexerServiceMock(adapter);

    await expect(resolveAdapterDownloadUrl(baseParams, log, indexerService as never)).rejects.toThrow();

    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(msg).toBe('Indexer resolveDownloadUrl failed');
    expect(payload).toMatchObject({
      indexerId: 1,
      title: 'Test Book',
      guid: '12345',
      cause: 'Transport failed: ECONNREFUSED',
      error: 'MAM torrent fetch failed for tid=12345',
    });
  });
});
