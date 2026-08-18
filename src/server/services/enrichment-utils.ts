import { writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '@db/schema.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { tokenizeNarrators } from '@core/utils/similarity.js';
import type { BookService } from './book.service.js';
import { downloadRemoteCoverWithinAdmissionLock, isRemoteCoverUrl } from './cover-download.js';
import { withBookAdmissionLock } from './book-admission.js';
import { mimeToExt } from '../utils/mime.js';
import { getErrorMessage } from '../utils/error-message.js';
import { serializeError } from '../utils/serialize-error.js';
import type { NarratorSource } from './import-adapters/types.js';


export interface EnrichmentResult {
  enriched: boolean;
  error?: string;
}

export interface AudioEnrichmentBook {
  narrators?: Array<{ name: string }> | null;
  duration: number | null;
  coverUrl: string | null;
  /** Per-import provenance. Absent preserves legacy behavior: fill only when narrators are empty. */
  narratorSource?: NarratorSource | undefined;
}

/** Auto-matched provider narrators arrive nonempty, so protect curated provenance rather than emptiness. */
function tagNarratorFillAllowed(book: AudioEnrichmentBook): boolean {
  if (book.narratorSource === undefined) return !book.narrators?.length;
  return book.narratorSource !== 'curated';
}

/** A zero total means every scan was rejected; omit duration writes instead of clobbering storage. */
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

/** Serialized entry point for callers that hold no admission lock. */
export async function enrichBookFromAudio(
  bookId: number,
  targetPath: string,
  book: AudioEnrichmentBook,
  db: Db,
  log: FastifyBaseLogger,
  bookService?: BookService,
  ffprobePath?: string,
): Promise<EnrichmentResult> {
  return withBookAdmissionLock(bookId, () =>
    enrichBookFromAudioWithinAdmissionLock(bookId, targetPath, book, db, log, bookService, ffprobePath));
}

/**
 * Caller must hold the admission lock for `bookId`.
 *
 * The scan, the embedded cover-art extraction, the narrator writeback and the scalar row update are
 * one operation: they all target `targetPath` and the same row, and splitting them would let a
 * rename land between the cover write and the row update.
 */
export async function enrichBookFromAudioWithinAdmissionLock(
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

    // UI eligibility depends on the nonrecursive visible-audio count.
    const topLevelEntries = await readdir(targetPath).catch(() => [] as string[]);
    const topLevelAudioFileCount = topLevelEntries.filter(
      (f) => !isHiddenName(String(f)) && AUDIO_EXTENSIONS.has(extname(String(f)).toLowerCase()),
    ).length;

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

    // Narrators write through the junction table and respect provenance.
    if (tagNarratorFillAllowed(book) && scanResult.tagNarrator && bookService) {
      const narratorNames = tokenizeNarrators(scanResult.tagNarrator);
      await bookService.update(bookId, { narrators: narratorNames });
    }

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

    // Awaited, not fired and forgotten: an un-awaited download outlives whatever lock its caller
    // holds, so its file write and DB localization would land unserialized by construction.
    // The `catch` keeps the previous error isolation — the writer never throws by contract, but a
    // cover failure must not become an enrichment failure if that ever changes.
    if (isRemoteCoverUrl(book.coverUrl) && !update.coverUrl) {
      await downloadRemoteCoverWithinAdmissionLock(bookId, targetPath, book.coverUrl!, db, log)
        .catch((err: unknown) => log.warn({ error: serializeError(err), bookId }, 'Remote cover download failed'));
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

