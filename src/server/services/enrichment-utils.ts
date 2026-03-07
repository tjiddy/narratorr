import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';

type BookRow = typeof books.$inferSelect;

export interface EnrichmentResult {
  enriched: boolean;
  error?: string;
}

/**
 * Scan audio files in a directory and enrich the book record.
 * Tag data only fills empty fields; technical info is always written.
 */
export async function enrichBookFromAudio(
  bookId: number,
  targetPath: string,
  book: Pick<BookRow, 'narrator' | 'duration' | 'coverUrl'>,
  db: Db,
  log: FastifyBaseLogger,
): Promise<EnrichmentResult> {
  try {
    const scanResult = await scanAudioDirectory(targetPath);
    if (!scanResult) {
      log.debug({ bookId, targetPath }, 'No audio metadata extracted');
      return { enriched: false };
    }

    // Build update: always write technical info
    const update: Record<string, unknown> = {
      audioCodec: scanResult.codec,
      audioBitrate: scanResult.bitrate,
      audioSampleRate: scanResult.sampleRate,
      audioChannels: scanResult.channels,
      audioBitrateMode: scanResult.bitrateMode,
      audioFileFormat: scanResult.fileFormat,
      audioFileCount: scanResult.fileCount,
      audioTotalSize: scanResult.totalSize,
      audioDuration: Math.round(scanResult.totalDuration),
      enrichmentStatus: 'file-enriched',
      updatedAt: new Date(),
    };

    // Tag data: only fill empty fields (don't overwrite user edits)
    if (!book.narrator && scanResult.tagNarrator) {
      update.narrator = scanResult.tagNarrator;
    }
    if (!book.duration && scanResult.totalDuration) {
      update.duration = Math.round(scanResult.totalDuration / 60);
    }

    // Save embedded cover art when no cover URL exists
    if (!book.coverUrl && scanResult.coverImage) {
      try {
        const ext = mimeToExt(scanResult.coverMimeType);
        const coverPath = join(targetPath, `cover.${ext}`);
        await writeFile(coverPath, scanResult.coverImage);
        update.coverUrl = `/api/books/${bookId}/cover`;
        log.info({ bookId, coverPath }, 'Saved embedded cover art');
      } catch (coverError) {
        log.warn({ error: coverError, bookId }, 'Failed to save embedded cover art');
      }
    }

    await db.update(books).set(update).where(eq(books.id, bookId));

    log.info(
      {
        bookId,
        codec: scanResult.codec,
        bitrate: scanResult.bitrate,
        duration: Math.round(scanResult.totalDuration),
        fileCount: scanResult.fileCount,
      },
      'Audio file enrichment complete',
    );
    return { enriched: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.warn({ error, bookId, targetPath }, 'Audio file enrichment failed');
    return { enriched: false, error: message };
  }
}

/** Map MIME type to file extension for cover art. */
function mimeToExt(mime?: string): string {
  if (mime?.includes('png')) return 'png';
  if (mime?.includes('webp')) return 'webp';
  return 'jpg';
}
