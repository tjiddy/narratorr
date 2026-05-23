import type { FastifyBaseLogger } from 'fastify';
import type { IndexerAdapter, DownloadProtocol, ResolveDownloadContext, ResolveDownloadResult, WedgeOutcome } from '../../core/index.js';
import { IndexerError } from '../../core/index.js';
import type { IndexerService } from './indexer.service.js';

export interface ResolveAdapterUrlParams {
  downloadUrl: string;
  protocol: DownloadProtocol;
  guid?: string | undefined;
  indexerId?: number | undefined;
  isFreeleech?: boolean | undefined;
  title: string;
}

/**
 * Call the indexer adapter's grab-time hook if present. Currently only MAM
 * implements `resolveDownloadUrl` (to apply freeleech wedge logic and lazily
 * fetch the torrent bytes). Returns the URL to use for the rest of the
 * pipeline — `params.downloadUrl` unchanged when no adapter or no hook.
 */
export async function resolveAdapterDownloadUrl(
  params: ResolveAdapterUrlParams,
  log: FastifyBaseLogger,
  indexerService: IndexerService | undefined,
): Promise<string> {
  if (params.indexerId === undefined || !indexerService) return params.downloadUrl;

  const indexer = await indexerService.getById(params.indexerId);
  if (!indexer) return params.downloadUrl;
  const adapter: IndexerAdapter = await indexerService.getAdapter(indexer);
  if (!adapter.resolveDownloadUrl) return params.downloadUrl;

  const ctx: ResolveDownloadContext = {
    ...(params.guid !== undefined && { guid: params.guid }),
    downloadUrl: params.downloadUrl,
    protocol: params.protocol,
    isFreeleech: params.isFreeleech === true,
  };

  let result: ResolveDownloadResult;
  try {
    result = await adapter.resolveDownloadUrl(ctx);
  } catch (error: unknown) {
    if (error instanceof IndexerError) {
      logHookError(log, error, params);
    }
    throw error;
  }

  if (result.wedgeOutcome !== undefined) {
    logWedgeOutcome(log, result.wedgeOutcome, params);
  }
  return result.downloadUrl;
}

function logHookError(
  log: FastifyBaseLogger,
  error: IndexerError,
  params: { indexerId?: number | undefined; guid?: string | undefined; title: string },
): void {
  const carriedOutcome = error.wedgeOutcome;
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  const logPayload = {
    indexerId: params.indexerId,
    title: params.title,
    guid: params.guid,
    ...(carriedOutcome !== undefined && { wedgeOutcome: carriedOutcome }),
    ...(cause !== undefined && { cause }),
    error: error.message,
  };
  if (carriedOutcome === 'spent') {
    log.error(logPayload, 'MAM wedge spent but torrent fetch failed — wedge is lost (no refund API)');
  } else {
    log.warn(logPayload, 'Indexer resolveDownloadUrl failed');
  }
}

function logWedgeOutcome(
  log: FastifyBaseLogger,
  outcome: WedgeOutcome,
  params: { indexerId?: number | undefined; guid?: string | undefined; title: string },
): void {
  if (outcome === 'spent') {
    log.info({ indexerId: params.indexerId, guid: params.guid, title: params.title }, 'MAM freeleech wedge spent');
    return;
  }
  if (outcome === 'skipped-no-inventory' || outcome === 'skipped-fetch-failed' || outcome === 'failed-spend') {
    log.warn({ indexerId: params.indexerId, guid: params.guid, title: params.title, wedgeOutcome: outcome }, 'MAM freeleech wedge not applied');
    return;
  }
  log.debug({ indexerId: params.indexerId, guid: params.guid, title: params.title, wedgeOutcome: outcome }, 'MAM wedge decision');
}
