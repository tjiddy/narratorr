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

function buildLogPayload(params: { indexerId?: number | undefined; guid?: string | undefined; title: string }) {
  return { indexerId: params.indexerId, title: params.title, guid: params.guid };
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
  log.debug({ ...buildLogPayload(params), hasIndexerService: !!indexerService }, 'resolveAdapterDownloadUrl: entry');

  if (params.indexerId === undefined || !indexerService) {
    log.debug({ indexerId: params.indexerId, hasIndexerService: !!indexerService }, 'resolveAdapterDownloadUrl: short-circuit — no indexerId or indexerService');
    return params.downloadUrl;
  }

  const indexer = await indexerService.getById(params.indexerId);
  if (!indexer) {
    log.debug({ indexerId: params.indexerId }, 'resolveAdapterDownloadUrl: short-circuit — indexer not found by id');
    return params.downloadUrl;
  }

  const adapter: IndexerAdapter = await indexerService.getAdapter(indexer);
  log.debug({ indexerId: params.indexerId, adapterType: adapter.type, hasResolveHook: !!adapter.resolveDownloadUrl }, 'resolveAdapterDownloadUrl: adapter resolved');

  if (!adapter.resolveDownloadUrl) {
    log.debug({ indexerId: params.indexerId, adapterType: adapter.type }, 'resolveAdapterDownloadUrl: short-circuit — adapter has no resolveDownloadUrl hook');
    return params.downloadUrl;
  }

  const ctx: ResolveDownloadContext = {
    ...(params.guid !== undefined && { guid: params.guid }),
    downloadUrl: params.downloadUrl,
    protocol: params.protocol,
    isFreeleech: params.isFreeleech ?? false,
  };
  log.debug({ ...buildLogPayload(params), isFreeleech: ctx.isFreeleech, protocol: ctx.protocol }, 'resolveAdapterDownloadUrl: calling adapter.resolveDownloadUrl');

  let result: ResolveDownloadResult;
  try {
    result = await adapter.resolveDownloadUrl(ctx);
  } catch (error: unknown) {
    log.debug({ ...buildLogPayload(params), errorType: error instanceof Error ? error.constructor.name : typeof error }, 'resolveAdapterDownloadUrl: adapter threw');
    if (error instanceof IndexerError) {
      logHookError(log, error, params);
    }
    throw error;
  }

  log.debug({ ...buildLogPayload(params), wedgeOutcome: result.wedgeOutcome, hasDownloadUrl: !!result.downloadUrl }, 'resolveAdapterDownloadUrl: adapter returned');

  if (result.wedgeOutcome !== undefined) {
    logWedgeOutcome(log, result.wedgeOutcome, result.wedgeCause, params);
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
    ...buildLogPayload(params),
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
  wedgeCause: string | undefined,
  params: { indexerId?: number | undefined; guid?: string | undefined; title: string; isFreeleech?: boolean | undefined },
): void {
  if (outcome === 'skipped-mode-never') return;

  if (outcome === 'spent') {
    log.info(buildLogPayload(params), 'MAM freeleech wedge spent');
    return;
  }
  if (outcome === 'skipped-no-inventory' || outcome === 'skipped-fetch-failed' || outcome === 'failed-spend') {
    log.warn({
      ...buildLogPayload(params),
      wedgeOutcome: outcome,
      ...(wedgeCause !== undefined && { wedgeCause }),
    }, 'MAM freeleech wedge not applied');
    return;
  }
  log.debug({ ...buildLogPayload(params), wedgeOutcome: outcome, isFreeleech: params.isFreeleech ?? false }, 'MAM wedge decision');
}
