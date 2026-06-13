import { eq, and, or, ne } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { deriveDisplayStatus } from '../../shared/download-status-registry.js';
import {
  transitionDownloadState,
  clientPolledDownloadCondition,
  inProgressDownloadCondition,
  completedDisplayDownloadCondition,
} from '../utils/download-state.js';
import type { ClientStatus } from '../../shared/schemas/activity.js';
import type { DownloadClientService } from '../services';
import type { NotifierService } from '../services';
import { retrySearch, type RetrySearchDeps } from '../services/retry-search.js';
import type { BlacklistService } from '../services';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { DownloadStatus } from '../../shared/schemas/activity.js';
import { safeEmit } from '../utils/safe-emit.js';
import { revertBookStatus } from '../utils/book-status.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import type { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import { recordDownloadFailedEvent } from '../utils/download-side-effects.js';
import { applyPathMapping } from '../../core/utils/path-mapping.js';
import { join } from 'node:path';
import { serializeError } from '../utils/serialize-error.js';

export interface MonitorRetryDeps {
  blacklistService: BlacklistService;
  retrySearchDeps: RetrySearchDeps;
}

export async function monitorDownloads(
  db: Db,
  downloadClientService: DownloadClientService,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
  retryDeps?: MonitorRetryDeps,
  broadcaster?: EventBroadcasterService,
  remotePathMappingService?: RemotePathMappingService,
  qualityGateOrchestrator?: QualityGateOrchestrator,
  eventHistory?: EventHistoryService,
) {
  const activeDownloads = await db
    .select()
    .from(downloads)
    .where(clientPolledDownloadCondition());

  if (activeDownloads.length === 0) {
    log.trace('No active downloads to monitor');
    return;
  }

  log.debug({ count: activeDownloads.length }, 'Monitoring active downloads');

  for (const download of activeDownloads) {
    if (!download.externalId || !download.downloadClientId) {
      log.debug({ id: download.id, hasExternalId: !!download.externalId, hasClientId: !!download.downloadClientId }, 'Skipping download: missing externalId or clientId');
      continue;
    }

    try {
      const adapter = await downloadClientService.getAdapter(download.downloadClientId);
      if (!adapter) {
        log.debug({ id: download.id, downloadClientId: download.downloadClientId }, 'Skipping download: adapter not found');
        continue;
      }

      const item = await adapter.getDownload(download.externalId);
      if (!item) {
        await handleMissingItem(db, download, notifierService, log, retryDeps, eventHistory, broadcaster);
        continue;
      }

      await processDownloadUpdate(db, download, item, notifierService, log, retryDeps, broadcaster, remotePathMappingService, qualityGateOrchestrator, eventHistory);
    } catch (error: unknown) {
      log.error({ error: serializeError(error), id: download.id }, 'Error monitoring download');
      await blacklistOnInfraError(download, retryDeps, log);
    }
  }
}

import type { DownloadRow } from '../services/types.js';

type DownloadItem = { progress: number; status: 'downloading' | 'seeding' | 'paused' | 'completed' | 'error'; savePath: string; name: string; size: number; errorMessage?: string | undefined; downloadSpeed?: number | undefined };

/** Handle a download that has been removed from the client externally. */
async function handleMissingItem(
  db: Db,
  download: DownloadRow,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
  retryDeps?: MonitorRetryDeps,
  eventHistory?: EventHistoryService,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  log.warn({ id: download.id }, 'Download not found in client');
  const errorMessage = 'Download not found in download client';
  // Client-side failure: poller writes only the `clientStatus` axis.
  await transitionDownloadState(db, download.id, { clientStatus: 'failed', errorMessage });

  recordDownloadFailedEvent({ eventHistory, downloadId: download.id, bookId: download.bookId ?? undefined, bookTitle: download.title, errorMessage, log });

  if (download.bookId && retryDeps) {
    const outcome = await handleDownloadFailure(db, download.id, download.bookId, download.infoHash, download.guid, download.title, retryDeps, log, 'download_failed', 'temporary', broadcaster);
    if (outcome === 'retried') {
      await db.delete(downloads).where(eq(downloads.id, download.id));
    }
  } else if (download.bookId) {
    await recoverBookStatus(db, download.bookId, download.id, log, broadcaster);
  }

  fireAndForget(
    notifierService.notify('on_failure', {
      event: 'on_failure',
      book: { title: download.title },
      error: { message: 'Download not found in download client', stage: 'download' },
    }),
    log,
    'Failed to send failure notification',
  );
}

/** Update progress, emit SSE events, handle status transitions. */
async function processDownloadUpdate(
  db: Db,
  download: DownloadRow,
  item: DownloadItem,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
  retryDeps?: MonitorRetryDeps,
  broadcaster?: EventBroadcasterService,
  remotePathMappingService?: RemotePathMappingService,
  qualityGateOrchestrator?: QualityGateOrchestrator,
  eventHistory?: EventHistoryService,
): Promise<void> {
  const progress = item.progress / 100;
  const newStatus = mapDownloadStatus(item.status);
  // Poller-owned rows are pipeline-idle, so the display status equals the client
  // status — but derive it explicitly so the comparison stays correct.
  const oldDisplay = deriveDisplayStatus(download.clientStatus, download.pipelineStage);

  if (download.clientStatus !== newStatus) {
    log.info({ id: download.id, status: newStatus }, 'Download state changed');
  } else {
    log.debug({ id: download.id, progress }, 'Download progress');
  }

  const isCompleted = newStatus === 'completed';
  const isCompletionTransition = isCompleted && download.clientStatus !== 'completed';
  const resolvedOutputPath = await resolveOutputPath(download, item, remotePathMappingService, log, isCompletionTransition);

  const progressChanged = progress !== download.progress;
  // Client poller writes ONLY the `clientStatus` axis (never `pipelineStage`).
  await transitionDownloadState(db, download.id, {
    clientStatus: newStatus,
    progress,
    completedAt: isCompleted && !download.completedAt ? new Date() : download.completedAt,
    ...(progressChanged ? { progressUpdatedAt: new Date() } : {}),
    ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
    ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
  });

  emitProgressEvents(download, oldDisplay, progress, newStatus, item.downloadSpeed, broadcaster, log);
  await handleFailureTransition(db, download, newStatus, item.errorMessage, retryDeps, log, eventHistory, broadcaster);
  handleCompletionNotification(download, item, isCompleted, notifierService, log);

  // Fire-and-forget quality gate + import for completed downloads (replaces handleBookStatusOnCompletion)
  if (isCompletionTransition && qualityGateOrchestrator) {
    fireAndForget(
      qualityGateOrchestrator.processOneDownload(download.id),
      log,
      'Inline import after completion failed',
    );
  }
}

/** Resolve outputPath — on first poll or on completion transition (to overwrite stale incomplete paths). */
async function resolveOutputPath(
  download: DownloadRow,
  item: DownloadItem,
  remotePathMappingService: RemotePathMappingService | undefined,
  log: FastifyBaseLogger,
  isCompletionTransition = false,
): Promise<string | undefined> {
  if (!item.savePath || !item.name) return undefined;
  if (download.outputPath && !isCompletionTransition) return undefined;

  const fullPath = join(item.savePath, item.name);
  if (remotePathMappingService && download.downloadClientId) {
    try {
      const mappings = await remotePathMappingService.getByClientId(download.downloadClientId);
      if (mappings.length > 0) {
        return applyPathMapping(fullPath, mappings);
      }
      // Zero mappings — raw path is correct (no mapping to apply)
      return fullPath;
    } catch {
      // Lookup failed — do NOT persist raw adapter path (trust model: skip persistence)
      log.debug({ id: download.id }, 'Remote path mapping lookup failed, skipping outputPath persistence');
      return undefined;
    }
  }
  // No mapping service available — raw path is correct
  return fullPath;
}

/** Emit SSE progress and status change events. Each emit is independent so a failure in one doesn't skip the rest. */
function emitProgressEvents(
  download: DownloadRow,
  oldDisplay: DownloadStatus,
  progress: number,
  newStatus: ClientStatus,
  downloadSpeed: number | undefined,
  broadcaster: EventBroadcasterService | undefined,
  log: FastifyBaseLogger,
): void {
  if (!download.bookId) return;
  safeEmit(broadcaster, 'download_progress', { download_id: download.id, book_id: download.bookId, percentage: progress, speed: downloadSpeed ?? null, eta: null }, log);
  // Both endpoints are derived display statuses. For a poller-owned (pipeline-idle)
  // row the new display equals `newStatus`; suppress the emit when unchanged.
  if (oldDisplay !== newStatus) {
    safeEmit(broadcaster, 'download_status_change', { download_id: download.id, book_id: download.bookId, old_status: oldDisplay, new_status: newStatus }, log);
  }
}

/** Handle failure status transitions with retry recovery. */
async function handleFailureTransition(
  db: Db,
  download: DownloadRow,
  newStatus: string,
  errorMessage: string | undefined,
  retryDeps: MonitorRetryDeps | undefined,
  log: FastifyBaseLogger,
  eventHistory?: EventHistoryService,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  if (newStatus !== 'failed' || download.clientStatus === 'failed') return;

  recordDownloadFailedEvent({ eventHistory, downloadId: download.id, bookId: download.bookId ?? undefined, bookTitle: download.title, errorMessage: errorMessage ?? 'Download failed', log });

  if (download.bookId && retryDeps) {
    const outcome = await handleDownloadFailure(db, download.id, download.bookId, download.infoHash, download.guid, download.title, retryDeps, log, 'download_failed', 'temporary', broadcaster);
    if (outcome === 'retried') {
      await db.delete(downloads).where(eq(downloads.id, download.id));
    }
  } else if (download.bookId) {
    await recoverBookStatus(db, download.bookId, download.id, log, broadcaster);
  }
}

/** Send notification when a download completes. */
function handleCompletionNotification(
  download: DownloadRow,
  item: DownloadItem,
  isCompleted: boolean,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
): void {
  if (!isCompleted || download.clientStatus === 'completed') return;

  log.info({ bookId: download.bookId, downloadId: download.id }, 'Download completed, queued for import');

  fireAndForget(
    notifierService.notify('on_download_complete', {
      event: 'on_download_complete',
      book: { title: download.title },
      download: { path: item.savePath, size: item.size },
    }),
    log,
    'Failed to send download complete notification',
  );
}

/** Blacklist a release on infrastructure error if retry deps are available. */
async function blacklistOnInfraError(
  download: DownloadRow,
  retryDeps: MonitorRetryDeps | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!download.infoHash || !retryDeps) return;

  try {
    await retryDeps.blacklistService.create({
      infoHash: download.infoHash,
      title: download.title,
      bookId: download.bookId ?? undefined,
      reason: 'infrastructure_error',
      blacklistType: 'temporary',
    });
    log.info({ downloadId: download.id, infoHash: download.infoHash }, 'Blacklisted release as infrastructure_error (temporary)');
  } catch (error: unknown) {
    log.warn({ downloadId: download.id, error: serializeError(error) }, 'Failed to blacklist release on infrastructure error');
  }
}

/**
 * Handle a failed download: blacklist the release (if infoHash present),
 * then attempt retry via retrySearch. Updates errorMessage on the download record.
 * Returns the retry outcome string.
 */
/** Best-effort blacklist by infoHash (torrent) or guid (usenet). */
async function blacklistRelease(
  blacklistService: BlacklistService,
  data: { downloadId: number; infoHash: string | null; guid: string | null; title: string; bookId: number; reason: 'bad_quality' | 'download_failed' | 'infrastructure_error'; blacklistType: 'temporary' | 'permanent' },
  log: FastifyBaseLogger,
): Promise<void> {
  if (!data.infoHash && !data.guid) {
    log.warn({ downloadId: data.downloadId }, 'Skipping blacklist — no infoHash or guid');
    return;
  }
  try {
    await blacklistService.create({
      infoHash: data.infoHash ?? undefined,
      guid: data.guid ?? undefined,
      title: data.title,
      bookId: data.bookId,
      reason: data.reason,
      blacklistType: data.blacklistType,
    });
    log.info({ downloadId: data.downloadId, infoHash: data.infoHash, guid: data.guid, reason: data.reason, blacklistType: data.blacklistType }, 'Blacklisted failed release before retry');
  } catch (error: unknown) {
    log.warn({ downloadId: data.downloadId, error: serializeError(error) }, 'Failed to blacklist release — proceeding with retry');
  }
}

async function handleDownloadFailure(
  db: Db,
  downloadId: number,
  bookId: number,
  infoHash: string | null,
  guid: string | null,
  title: string,
  retryDeps: MonitorRetryDeps,
  log: FastifyBaseLogger,
  reason: 'bad_quality' | 'download_failed' | 'infrastructure_error' = 'bad_quality',
  blacklistType: 'temporary' | 'permanent' = 'permanent',
  broadcaster?: EventBroadcasterService,
): Promise<string> {
  // Check redownloadFailed setting — if disabled, skip blacklist and retry
  let redownloadFailed = true;
  try {
    const importSettings = await retryDeps.retrySearchDeps.settingsService.get('import');
    redownloadFailed = importSettings.redownloadFailed;
  } catch (error: unknown) {
    log.warn({ downloadId, error: serializeError(error) }, 'Failed to read import settings — proceeding with retry');
  }

  if (!redownloadFailed) {
    await db.update(downloads).set({ errorMessage: 'Redownload disabled' }).where(eq(downloads.id, downloadId));
    await recoverBookStatus(db, bookId, downloadId, log, broadcaster);
    return 'redownload_disabled';
  }

  await blacklistRelease(retryDeps.blacklistService, { downloadId, infoHash, guid, title, bookId, reason, blacklistType }, log);

  // Attempt retry search
  try {
    const result = await retrySearch(bookId, retryDeps.retrySearchDeps);

    switch (result.outcome) {
      case 'retried': {
        const attempt = retryDeps.retrySearchDeps.retryBudget.hasRemaining(bookId) ? 'within budget' : 'at limit';
        log.info({ downloadId, bookId, newDownloadId: result.download.id, attempt }, 'Retry search succeeded');
        // errorMessage on new download will show retry progress — update old record before deletion
        await db.update(downloads).set({ errorMessage: `Retrying` }).where(eq(downloads.id, downloadId));
        return 'retried';
      }
      case 'exhausted':
        await db.update(downloads).set({ errorMessage: 'Retries exhausted' }).where(eq(downloads.id, downloadId));
        await recoverBookStatus(db, bookId, downloadId, log, broadcaster);
        return 'exhausted';
      case 'no_candidates':
        await db.update(downloads).set({ errorMessage: 'No viable candidates' }).where(eq(downloads.id, downloadId));
        await recoverBookStatus(db, bookId, downloadId, log, broadcaster);
        return 'no_candidates';
      case 'retry_error':
        await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
        // Don't recover book status on retry_error — will try again next cycle
        return 'retry_error';
    }
  } catch (error: unknown) {
    log.error({ downloadId, bookId, error: serializeError(error) }, 'handleDownloadFailure unexpected error');
    await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
    return 'retry_error';
  }
}

/**
 * Recover book status after a download fails.
 * If other active downloads exist for the same book, don't revert.
 * Otherwise restore the book's explicit pre-grab lifecycle (the failed download's
 * `bookStatusAtGrab` snapshot), never a path-inferred guess — a book that was
 * `failed`/`missing`/`searching` before the grab is restored to that exact state.
 */
async function recoverBookStatus(
  db: Db,
  bookId: number,
  failedDownloadId: number,
  log: FastifyBaseLogger,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  // Recovery guard: in-progress statuses plus 'completed' (pre-import pipeline awareness)
  const otherActive = await db
    .select()
    .from(downloads)
    .where(and(
      eq(downloads.bookId, bookId),
      or(inProgressDownloadCondition(), completedDisplayDownloadCondition()),
      ne(downloads.id, failedDownloadId),
    ));

  if (otherActive.length > 0) {
    log.debug({ bookId, otherActiveCount: otherActive.length }, 'Skipping book status recovery — other active downloads exist');
    return;
  }

  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) return;

  // Explicit prior-state from the failed download's pre-grab snapshot.
  const [failedDownload] = await db
    .select({ bookStatusAtGrab: downloads.bookStatusAtGrab })
    .from(downloads)
    .where(eq(downloads.id, failedDownloadId))
    .limit(1);

  const oldStatus = book.status;
  const newStatus = await revertBookStatus(db, book, failedDownload?.bookStatusAtGrab ?? null);
  if (oldStatus !== newStatus) {
    safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: oldStatus, new_status: newStatus }, log);
  }
  log.info({ bookId, status: newStatus }, 'Book status recovered after download failure');
}

function mapDownloadStatus(
  status: 'downloading' | 'seeding' | 'paused' | 'completed' | 'error'
): ClientStatus {
  switch (status) {
    case 'downloading':
      return 'downloading';
    case 'seeding':
    case 'completed':
      return 'completed';
    case 'paused':
      return 'paused';
    case 'error':
      return 'failed';
    default:
      return 'downloading';
  }
}
