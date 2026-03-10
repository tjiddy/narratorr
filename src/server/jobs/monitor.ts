import cron from 'node-cron';
import { eq, inArray, and, ne } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import { getInProgressStatuses } from '../../shared/download-status-registry.js';
import type { DownloadClientService } from '../services';
import type { NotifierService } from '../services';
import { retrySearch, type RetrySearchDeps } from '../services/retry-search.js';
import type { BlacklistService } from '../services';

export interface MonitorRetryDeps {
  blacklistService: BlacklistService;
  retrySearchDeps: RetrySearchDeps;
}

export function startMonitorJob(
  db: Db,
  downloadClientService: DownloadClientService,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
  retryDeps?: MonitorRetryDeps,
) {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await monitorDownloads(db, downloadClientService, notifierService, log, retryDeps);
    } catch (error) {
      log.error(error, 'Monitor job error');
    }
  });

  log.info('Download monitor job started (every 30 seconds)');
}

// eslint-disable-next-line complexity -- linear download monitoring loop with per-item error handling, status recovery, and retry orchestration
export async function monitorDownloads(
  db: Db,
  downloadClientService: DownloadClientService,
  notifierService: NotifierService,
  log: FastifyBaseLogger,
  retryDeps?: MonitorRetryDeps,
) {
  // Get all active downloads
  const activeStatuses = ['downloading', 'queued', 'paused'] as const;
  const activeDownloads = await db
    .select()
    .from(downloads)
    .where(inArray(downloads.status, [...activeStatuses]));

  if (activeDownloads.length === 0) {
    log.debug('No active downloads to monitor');
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
        // Download not found in client - might have been removed manually
        log.warn({ id: download.id }, 'Download not found in client');
        await db
          .update(downloads)
          .set({
            status: 'failed',
            errorMessage: 'Download not found in download client',
          })
          .where(eq(downloads.id, download.id));

        // Attempt retry recovery if bookId present and retry deps available
        if (download.bookId && retryDeps) {
          const outcome = await handleDownloadFailure(db, download.id, download.bookId, download.infoHash, download.title, retryDeps, log, 'download_failed', 'temporary');
          if (outcome === 'retried') {
            // Old download replaced — delete the failed record
            await db.delete(downloads).where(eq(downloads.id, download.id));
          }
        } else if (download.bookId) {
          // Fallback: recover book status without retry
          await recoverBookStatus(db, download.bookId, download.id, log);
        }

        // Notify on failure
        Promise.resolve(notifierService.notify('on_failure', {
          event: 'on_failure',
          book: { title: download.title },
          error: { message: 'Download not found in download client', stage: 'download' },
        })).catch((err) => log.warn(err, 'Failed to send failure notification'));

        continue;
      }

      // Calculate progress (0-1)
      const progress = item.progress / 100;
      const isCompleted = progress >= 1;
      const newStatus = isCompleted ? 'completed' : mapDownloadStatus(item.status);

      // Log state transitions
      if (download.status !== newStatus) {
        log.info({ id: download.id, status: newStatus }, 'Download state changed');
      } else {
        log.debug({ id: download.id, progress }, 'Download progress');
      }

      // Update download status
      await db
        .update(downloads)
        .set({
          progress,
          status: newStatus,
          completedAt: isCompleted && !download.completedAt ? new Date() : download.completedAt,
        })
        .where(eq(downloads.id, download.id));

      // Handle failure transitions with retry recovery
      if (newStatus === 'failed' && download.status !== 'failed') {
        if (download.bookId && retryDeps) {
          const outcome = await handleDownloadFailure(db, download.id, download.bookId, download.infoHash, download.title, retryDeps, log, 'download_failed', 'temporary');
          if (outcome === 'retried') {
            await db.delete(downloads).where(eq(downloads.id, download.id));
          }
        } else if (download.bookId) {
          await recoverBookStatus(db, download.bookId, download.id, log);
        }
      }

      // Log completion — import job will handle copying files to library
      if (isCompleted && download.status !== 'completed') {
        log.info({ bookId: download.bookId, downloadId: download.id }, 'Download completed, queued for import');

        // Notify on download complete
        Promise.resolve(notifierService.notify('on_download_complete', {
          event: 'on_download_complete',
          book: { title: download.title },
          download: {
            path: item.savePath,
            size: item.size,
          },
        })).catch((err) => log.warn(err, 'Failed to send download complete notification'));
      }
    } catch (error) {
      log.error({ error, id: download.id }, 'Error monitoring download');

      // Infrastructure error — blacklist as temporary if infoHash and retryDeps available
      if (download.infoHash && retryDeps) {
        try {
          await retryDeps.blacklistService.create({
            infoHash: download.infoHash,
            title: download.title,
            bookId: download.bookId ?? undefined,
            reason: 'infrastructure_error',
            blacklistType: 'temporary',
          });
          log.info({ downloadId: download.id, infoHash: download.infoHash }, 'Blacklisted release as infrastructure_error (temporary)');
        } catch (err) {
          log.warn({ downloadId: download.id, err }, 'Failed to blacklist release on infrastructure error');
        }
      }
    }
  }
}

/**
 * Handle a failed download: blacklist the release (if infoHash present),
 * then attempt retry via retrySearch. Updates errorMessage on the download record.
 * Returns the retry outcome string.
 */
async function handleDownloadFailure(
  db: Db,
  downloadId: number,
  bookId: number,
  infoHash: string | null,
  title: string,
  retryDeps: MonitorRetryDeps,
  log: FastifyBaseLogger,
  reason: 'bad_quality' | 'download_failed' | 'infrastructure_error' = 'bad_quality',
  blacklistType: 'temporary' | 'permanent' = 'permanent',
): Promise<string> {
  // Blacklist the release if infoHash present
  if (infoHash) {
    try {
      await retryDeps.blacklistService.create({
        infoHash,
        title,
        bookId,
        reason,
        blacklistType,
      });
      log.info({ downloadId, infoHash, reason, blacklistType }, 'Blacklisted failed release before retry');
    } catch (err) {
      log.warn({ downloadId, err }, 'Failed to blacklist release — proceeding with retry');
    }
  } else {
    log.debug({ downloadId }, 'Skipping blacklist — no infoHash (Usenet download)');
  }

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
        await recoverBookStatus(db, bookId, downloadId, log);
        return 'exhausted';
      case 'no_candidates':
        await db.update(downloads).set({ errorMessage: 'No viable candidates' }).where(eq(downloads.id, downloadId));
        await recoverBookStatus(db, bookId, downloadId, log);
        return 'no_candidates';
      case 'retry_error':
        await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
        // Don't recover book status on retry_error — will try again next cycle
        return 'retry_error';
    }
  } catch (error) {
    log.error({ downloadId, bookId, error }, 'handleDownloadFailure unexpected error');
    await db.update(downloads).set({ errorMessage: 'Retry failed - will retry next cycle' }).where(eq(downloads.id, downloadId));
    return 'retry_error';
  }
}

/**
 * Recover book status after a download fails.
 * If other active downloads exist for the same book, don't revert.
 * Otherwise: book has path → imported, no path → wanted.
 */
async function recoverBookStatus(db: Db, bookId: number, failedDownloadId: number, log: FastifyBaseLogger): Promise<void> {
  // Recovery guard: in-progress statuses plus 'completed' (pre-import pipeline awareness)
  const activeStatuses = [...getInProgressStatuses(), 'completed' as const];

  // Check for other active downloads for the same book
  const otherActive = await db
    .select()
    .from(downloads)
    .where(and(
      eq(downloads.bookId, bookId),
      inArray(downloads.status, [...activeStatuses]),
      ne(downloads.id, failedDownloadId),
    ));

  if (otherActive.length > 0) {
    log.debug({ bookId, otherActiveCount: otherActive.length }, 'Skipping book status recovery — other active downloads exist');
    return;
  }

  // Get the book to check if it has a path (was previously imported)
  const [book] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) return;

  const newStatus = book.path ? 'imported' : 'wanted';
  await db.update(books).set({ status: newStatus, updatedAt: new Date() }).where(eq(books.id, bookId));
  log.info({ bookId, status: newStatus, hadPath: !!book.path }, 'Book status recovered after download failure');
}

function mapDownloadStatus(
  status: 'downloading' | 'seeding' | 'paused' | 'completed' | 'error'
): 'queued' | 'downloading' | 'paused' | 'completed' | 'importing' | 'imported' | 'failed' {
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
