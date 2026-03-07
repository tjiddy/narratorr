import cron from 'node-cron';
import { eq, inArray, and, ne } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '../../db/schema.js';
import type { DownloadClientService } from '../services';
import type { NotifierService } from '../services';

export function startMonitorJob(db: Db, downloadClientService: DownloadClientService, notifierService: NotifierService, log: FastifyBaseLogger) {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await monitorDownloads(db, downloadClientService, notifierService, log);
    } catch (error) {
      log.error(error, 'Monitor job error');
    }
  });

  log.info('Download monitor job started (every 30 seconds)');
}

// eslint-disable-next-line complexity -- linear download monitoring loop with per-item error handling and status recovery
export async function monitorDownloads(db: Db, downloadClientService: DownloadClientService, notifierService: NotifierService, log: FastifyBaseLogger) {
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

        // Recover book status
        if (download.bookId) {
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

      // Recover book status when download transitions to failed
      if (newStatus === 'failed' && download.status !== 'failed' && download.bookId) {
        await recoverBookStatus(db, download.bookId, download.id, log);
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
    }
  }
}

/**
 * Recover book status after a download fails.
 * If other active downloads exist for the same book, don't revert.
 * Otherwise: book has path → imported, no path → wanted.
 */
async function recoverBookStatus(db: Db, bookId: number, failedDownloadId: number, log: FastifyBaseLogger): Promise<void> {
  const activeStatuses = ['downloading', 'queued', 'paused', 'completed'] as const;

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
