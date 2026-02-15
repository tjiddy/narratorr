import cron from 'node-cron';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import type { FastifyBaseLogger } from 'fastify';
import { downloads } from '@narratorr/db/schema';
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

async function monitorDownloads(db: Db, downloadClientService: DownloadClientService, notifierService: NotifierService, log: FastifyBaseLogger) {
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
