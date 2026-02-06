import cron from 'node-cron';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '@narratorr/db';
import { downloads, books } from '@narratorr/db/schema';
import type { DownloadClientService } from '../services';

export function startMonitorJob(db: Db, downloadClientService: DownloadClientService) {
  // Run every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await monitorDownloads(db, downloadClientService);
    } catch (error) {
      console.error('Monitor job error:', error);
    }
  });

  console.log('Download monitor job started (every 30 seconds)');
}

async function monitorDownloads(db: Db, downloadClientService: DownloadClientService) {
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
    if (!download.infoHash || !download.downloadClientId) {
      continue;
    }

    try {
      const adapter = await downloadClientService.getAdapter(download.downloadClientId);
      if (!adapter) {
        continue;
      }

      const torrent = await adapter.getTorrent(download.infoHash);
      if (!torrent) {
        // Torrent not found in client - might have been removed manually
        await db
          .update(downloads)
          .set({
            status: 'failed',
            errorMessage: 'Torrent not found in download client',
          })
          .where(eq(downloads.id, download.id));
        continue;
      }

      // Calculate progress (0-1)
      const progress = torrent.progress / 100;
      const isCompleted = progress >= 1;

      // Update download status
      await db
        .update(downloads)
        .set({
          progress,
          status: isCompleted ? 'completed' : mapTorrentStatus(torrent.status),
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
      }
    } catch (error) {
      console.error(`Error monitoring download ${download.id}:`, error);
    }
  }
}

function mapTorrentStatus(
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
