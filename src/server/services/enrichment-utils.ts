import { writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import type { BookService } from './book.service.js';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';
import { mimeToExt } from '../utils/mime.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';


export interface EnrichmentResult {
  enriched: boolean;
  error?: string;
}

export interface AudioEnrichmentBook {
  narrators?: Array<{ name: string }> | null;
  duration: number | null;
  coverUrl: string | null;
}

/**
 * Scan audio files in a directory and enrich the book record.
 * Tag data only fills empty fields; technical info is always written.
 * Narrator writes go through the junction table via bookService.
 */
/**
 * Apply the two duration writes to the enrichment update, honoring the zero-total skip-write
 * guard (#1846). An all-rejected scan yields totalDuration 0; writing that zero would silently
 * clobber a correct stored `audioDuration`, so it is omitted (logged at warn) and the existing
 * value stands. The fill-empty `duration` behavior is preserved (it already skips a 0 total).
 */
function applyDurationFields(
  update: Record<string, unknown>,
  totalDuration: number,
  existingDurationMinutes: number | null,
  log: FastifyBaseLogger,
  bookId: number,
  targetPath: string,
): void {
  if (totalDuration === 0) {
    log.warn({ bookId, targetPath }, 'Audio scan produced 0 total duration; omitting audioDuration to preserve existing value');
  } else {
    update.audioDuration = Math.round(totalDuration);
  }
  if (!existingDurationMinutes && totalDuration) {
    update.duration = Math.round(totalDuration / 60);
  }
}

export async function enrichBookFromAudio(
  bookId: number,
  targetPath: string,
  book: AudioEnrichmentBook,
  db: Db,
  log: FastifyBaseLogger,
  bookService?: BookService,
  ffprobePath?: string,
): Promise<EnrichmentResult> {
  try {
    const scanResult = await scanAudioDirectory(targetPath, {
      ffprobePath,
      onWarn: (msg, payload) => log.warn(payload, msg),
      onDebug: (msg, payload) => log.debug(payload, msg),
    });
    if (!scanResult) {
      log.debug({ bookId, targetPath }, 'No audio metadata extracted');
      return { enriched: false };
    }

    // Count top-level (non-recursive) audio files for UI eligibility check
    // readdir returns strings; use String() to be safe with non-string entries
    const topLevelEntries = await readdir(targetPath).catch(() => [] as string[]);
    const topLevelAudioFileCount = topLevelEntries.filter(
      (f) => AUDIO_EXTENSIONS.has(extname(String(f)).toLowerCase()),
    ).length;

    // Build update: always write technical info
    const update: Record<string, unknown> = {
      audioCodec: scanResult.codec,
      audioBitrate: scanResult.bitrate,
      audioSampleRate: scanResult.sampleRate,
      audioChannels: scanResult.channels,
      audioBitrateMode: scanResult.bitrateMode,
      audioFileFormat: scanResult.fileFormat,
      audioFileCount: scanResult.fileCount,
      topLevelAudioFileCount,
      audioTotalSize: scanResult.totalSize,
      enrichmentStatus: 'file-enriched',
      updatedAt: new Date(),
    };

    applyDurationFields(update, scanResult.totalDuration, book.duration, log, bookId, targetPath);

    // Tag data: only fill empty fields (don't overwrite user edits)
    // Narrator writes go through the junction table via bookService
    if (!book.narrators?.length && scanResult.tagNarrator && bookService) {
      const narratorNames = scanResult.tagNarrator.split(/[,;&]/).map(n => n.trim()).filter(n => n.length > 0);
      await bookService.update(bookId, { narrators: narratorNames });
    }

    // Save embedded cover art when no cover URL exists
    if (!book.coverUrl && scanResult.coverImage) {
      try {
        const ext = mimeToExt(scanResult.coverMimeType) ?? 'jpg';
        const coverPath = join(targetPath, `cover.${ext}`);
        await writeFile(coverPath, scanResult.coverImage);
        update.coverUrl = `/api/books/${bookId}/cover`;
        log.info({ bookId, coverPath }, 'Saved embedded cover art');
      } catch (coverError: unknown) {
        log.warn({ error: serializeError(coverError), bookId }, 'Failed to save embedded cover art');
      }
    }

    // Download remote cover if book has a remote coverUrl and no embedded cover was saved
    if (isRemoteCoverUrl(book.coverUrl) && !update.coverUrl) {
      downloadRemoteCover(bookId, targetPath, book.coverUrl!, db, log)
        .catch((err: unknown) => log.warn({ error: serializeError(err), bookId }, 'Fire-and-forget remote cover download failed'));
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
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    log.warn({ error: serializeError(error), bookId, targetPath }, 'Audio file enrichment failed');
    return { enriched: false, error: message };
  }
}

