import { eq, and, or, ne } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '@db/schema.js';
import { deriveDisplayStatus } from '@shared/download-status-registry.js';
import {
  transitionDownloadState,
  clientPolledDownloadCondition,
  inProgressDownloadCondition,
  completedDisplayDownloadCondition,
} from '../utils/download-state.js';
import type { ClientStatus } from '@shared/schemas/activity.js';
import type { DownloadClientService } from '../services';
import type { NotifierService } from '../services';
import { retrySearch, type RetrySearchDeps } from '../services/retry-search.js';
import type { BlacklistService } from '../services';
import type { EventBroadcasterService } from '../services/event-broadcaster.service.js';
import type { DownloadStatus } from '@shared/schemas/activity.js';
import { safeEmit } from '../utils/safe-emit.js';
import { revertBookStatus } from '../utils/book-status.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import type { RemotePathMappingService } from '../services/remote-path-mapping.service.js';
import type { QualityGateOrchestrator } from '../services/quality-gate-orchestrator.js';
import type { EventHistoryService } from '../services/event-history.service.js';
import { recordDownloadFailedEvent } from '../utils/download-side-effects.js';
import { applyPathMapping } from '@core/utils/path-mapping.js';
import { join } from 'node:path';
import { serializeError } from '../utils/serialize-error.js';
import { isWithinMissingItemGrace } from '../utils/download-grace.js';

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
        // The row keeps its polled status, so the next cycle re-polls and eventually fails it.
        if (isWithinMissingItemGrace(download.addedAt, Date.now())) {
          log.debug({ id: download.id, addedAt: download.addedAt }, 'Download not yet in client — within add grace window');
          continue;
        }
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
  // Guard the polled tuple so a replacement suppresses every stale failure side effect.
  const landed = await transitionDownloadState(db, download.id, {
    expected: { clientStatus: download.clientStatus, pipelineStage: download.pipelineStage },
    clientStatus: 'failed',
    errorMessage,
  });
  if (!landed) {
    log.debug({ id: download.id }, 'Missing-item handling skipped — row changed since poll (guarded)');
    return;
  }

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
  // Compare derived display state even though monitored rows should be pipeline-idle.
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
  // Guard the polled tuple so a concurrent cancel suppresses this stale write and its side effects.
  const landed = await transitionDownloadState(db, download.id, {
    expected: { clientStatus: download.clientStatus, pipelineStage: download.pipelineStage },
    clientStatus: newStatus,
    progress,
    completedAt: isCompleted && !download.completedAt ? new Date() : download.completedAt,
    ...(progressChanged ? { progressUpdatedAt: new Date() } : {}),
    ...(item.errorMessage ? { errorMessage: item.errorMessage } : {}),
    ...(resolvedOutputPath ? { outputPath: resolvedOutputPath } : {}),
  });
  if (!landed) {
    log.debug({ id: download.id }, 'Monitor update skipped — row changed since poll (guarded)');
    return;
  }

  emitProgressEvents(download, oldDisplay, progress, newStatus, item.downloadSpeed, broadcaster, log);
  await handleFailureTransition(db, download, newStatus, item.errorMessage, retryDeps, log, eventHistory, broadcaster);
  handleCompletionNotification(download, item, isCompleted, notifierService, log);

  if (isCompletionTransition && qualityGateOrchestrator) {
    fireAndForget(
      // Hand over the polled snapshot: if the row vanishes before the gate re-reads it, this is the
      // only provenance left to attribute the failure to a book.
      qualityGateOrchestrator.processOneDownload(download.id, { bookId: download.bookId, releaseTitle: download.title }),
      log,
      'Inline import after completion failed',
    );
  }
}

// Completion may replace a path captured while the download was incomplete.
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
      return fullPath;
    } catch {
      // A failed lookup makes the adapter path untrusted; do not persist it.
      log.debug({ id: download.id }, 'Remote path mapping lookup failed, skipping outputPath persistence');
      return undefined;
    }
  }
  // Without a mapping service, the adapter path is authoritative.
  return fullPath;
}

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
  // Compare display states; monitored rows are pipeline-idle.
  if (oldDisplay !== newStatus) {
    safeEmit(broadcaster, 'download_status_change', { download_id: download.id, book_id: download.bookId, old_status: oldDisplay, new_status: newStatus }, log);
  }
}

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

async function blacklistOnInfraError(
  download: DownloadRow,
  retryDeps: MonitorRetryDeps | undefined,
  log: FastifyBaseLogger,
): Promise<void> {
  if (!download.infoHash || !retryDeps) return;

  try {
    await retryDeps.blacklistService.create({
      infoHash: download.infoHash,
      // An adapter whose search results carry no hash (ABB, #2420) can only ever be matched on
      // guid, so an entry written without it silently blacklists nothing.
      guid: download.guid ?? undefined,
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

  try {
    const result = await retrySearch(bookId, retryDeps.retrySearchDeps);

    switch (result.outcome) {
      case 'retried': {
        const attempt = retryDeps.retrySearchDeps.retryBudget.hasRemaining(bookId) ? 'within budget' : 'at limit';
        log.info({ downloadId, bookId, newDownloadId: result.download.id, attempt }, 'Retry search succeeded');
        await db.update(downloads).set({ errorMessage: `Retrying` }).where(eq(downloads.id, downloadId));
        return 'retried';
      }
      case 'exhausted':
        await db.update(downloads).set({ errorMessage: 'Retries exhausted' }).where(eq(downloads.id, downloadId));
        await recoverBookStatus(db, bookId, downloadId, log, broadcaster);
        return 'exhausted';
      case 'already_active':
        // Preserve the failed row and book status; the existing blocker owns the lifecycle.
        log.info({ downloadId, bookId }, 'Retry skipped — book already has a blocking download or import');
        return 'already_active';
      case 'no_candidates':
        await db.update(downloads).set({ errorMessage: 'No viable candidates' }).where(eq(downloads.id, downloadId));
        await recoverBookStatus(db, bookId, downloadId, log, broadcaster);
        return 'no_candidates';
      case 'retry_error':
        await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
        // Preserve status so the next monitor cycle can retry.
        return 'retry_error';
    }
  } catch (error: unknown) {
    log.error({ downloadId, bookId, error: serializeError(error) }, 'handleDownloadFailure unexpected error');
    await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
    return 'retry_error';
  }
}

// Revert only when no other blocker exists, using the pre-grab snapshot rather than path inference.
async function recoverBookStatus(
  db: Db,
  bookId: number,
  failedDownloadId: number,
  log: FastifyBaseLogger,
  broadcaster?: EventBroadcasterService,
): Promise<void> {
  // Completed rows still block recovery while awaiting import.
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
