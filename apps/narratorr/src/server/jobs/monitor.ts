import cron from 'node-cron';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { downloads, books } from '@narratorr/db/schema';
import type { DownloadClientService } from '../services';

export function startMonitorJob(db: Db, downloadClientService: DownloadClientService, log: FastifyBaseLogger) {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await monitorDownloads(db, downloadClientService, log);
    } catch (error) {
      log.error(error, 'Monitor job error');
    }
  });

  log.info('Download monitor job started (every 30 seconds)');
}

async function monitorDownloads(db: Db, downloadClientService: DownloadClientService, log: FastifyBaseLogger) {
  // Get all active downloads
  const activeStatuses = ['downloading', 'queued', 'paused'] as const;
  const activeDownloads = await db
    .select()
    .from(downloads)
    .where(inArray(downloads.status, [...activeStatuses]));

  if (activeDownloads.length === 0) {
    return;
  }

  for (const download of activeDownloads) {
    if (!download.externalId || !download.downloadClientId) {
      continue;
    }

    try {
      const adapter = await downloadClientService.getAdapter(download.downloadClientId);
      if (!adapter) {
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

      // Update book status if linked and completed
      if (isCompleted && download.bookId) {
        await db
          .update(books)
          .set({ status: 'imported', updatedAt: new Date() })
          .where(eq(books.id, download.bookId));

        // Mark download as imported
        await db
          .update(downloads)
          .set({ status: 'imported' })
          .where(eq(downloads.id, download.id));

        log.info({ bookId: download.bookId, downloadId: download.id }, 'Book status updated from monitor');
      }
    } catch (error) {
      log.error({ error, id: download.id }, 'Error monitoring download');
    }
  }
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
