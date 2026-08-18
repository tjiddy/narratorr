import { writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, bookNarrators } from '@db/schema.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { tokenizeNarrators } from '@core/utils/similarity.js';
import type { BookService } from './book.service.js';
import { downloadRemoteCover, isRemoteCoverUrl } from './cover-download.js';
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

export interface AudioEnrichmentOptions {
  /** #2435: the job targets an EXISTING book. Bibliographic writes become compare-and-set against
   * the live row and no cover is acquired. Omitted preserves today's behaviour for every caller. */
  attach?: boolean;
}

/** Auto-matched provider narrators arrive nonempty, so protect curated provenance rather than emptiness. */
function tagNarratorFillAllowed(book: AudioEnrichmentBook): boolean {
  if (book.narratorSource === undefined) return !book.narrators?.length;
  return book.narratorSource !== 'curated';
}

/** Live, in-transaction narrator emptiness. The one home for "does this row have narrators yet?" —
 * a pre-fetched snapshot may miss an audio-tag write or an operator edit made during a long copy. */
export async function rowHasNarrators(tx: DbOrTx, bookId: number): Promise<boolean> {
  const rows = await tx
    .select({ narratorId: bookNarrators.narratorId })
    .from(bookNarrators)
    .where(eq(bookNarrators.bookId, bookId))
    .limit(1);
  return rows.length > 0;
}

/**
 * #2435 AC28 — on an attach, audio-tag narrators fill the incumbent's list if and only if that list
 * is EMPTY, read live at the moment of the write.
 *
 * `narratorSource` is deliberately not a factor: it is per-import provenance describing where the
 * OFFERED item's narrators came from, and on an attach the offered item has no authority over the
 * incumbent at all. `tagNarratorFillAllowed` would authorise replacement for any non-curated
 * source regardless of how full the list is, which is exactly the write this rule forbids.
 */
async function attachNarratorFill(
  db: Db, bookId: number, narratorNames: string[], bookService: BookService,
): Promise<void> {
  await db.transaction(async (tx) => {
    if (await rowHasNarrators(tx, bookId)) return;
    await bookService.update(bookId, { narrators: narratorNames }, { tx });
  });
}

/** A zero total means every scan was rejected; omit duration writes instead of clobbering storage.
 * `audioDuration` is a technical statistic describing the file just placed, so it always updates;
 * only the bibliographic `duration` is subject to the fill-don't-replace rule below. */
function applyDurationFields(
  update: Record<string, unknown>,
  totalDuration: number,
  log: FastifyBaseLogger,
  bookId: number,
  targetPath: string,
): void {
  if (totalDuration === 0) {
    log.warn({ bookId, targetPath }, 'Audio scan produced 0 total duration; omitting audioDuration to preserve existing value');
  } else {
    update.audioDuration = Math.round(totalDuration);
  }
}

/**
 * #2435 AC28 — the bibliographic `duration` write is a compare-and-set: the emptiness test is a
 * condition of the UPDATE itself, so there is no read-then-write window for an operator edit
 * landing mid-import to fall into. Behaviour-neutral for a newly created book, whose row is empty
 * at both moments.
 */
async function fillDurationIfEmpty(
  db: Db, bookId: number, totalDuration: number, existingDurationMinutes: number | null,
): Promise<void> {
  if (!totalDuration || existingDurationMinutes) return;
  await db
    .update(books)
    .set({ duration: Math.round(totalDuration / 60), updatedAt: new Date() })
    .where(and(eq(books.id, bookId), or(isNull(books.duration), eq(books.duration, 0))));
}

type AudioScan = NonNullable<Awaited<ReturnType<typeof scanAudioDirectory>>>;

/** Narrators write through the junction table. An attach keys on the incumbent's own list, read
 * live; every other caller keeps the provenance rule. */
async function applyTagNarrators(
  db: Db, bookId: number, tagNarrator: string | null | undefined, book: AudioEnrichmentBook,
  bookService: BookService | undefined, opts: AudioEnrichmentOptions | undefined,
): Promise<void> {
  if (!tagNarrator || !bookService) return;
  const narratorNames = tokenizeNarrators(tagNarrator);
  if (opts?.attach) {
    await attachNarratorFill(db, bookId, narratorNames, bookService);
    return;
  }
  if (tagNarratorFillAllowed(book)) {
    await bookService.update(bookId, { narrators: narratorNames });
  }
}

/** Embedded-art extraction plus remote localization; mutates `update` with the resulting coverUrl. */
async function acquireCoverArt(
  update: Record<string, unknown>, bookId: number, targetPath: string, scanResult: AudioScan,
  book: AudioEnrichmentBook, db: Db, log: FastifyBaseLogger,
): Promise<void> {
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

  if (isRemoteCoverUrl(book.coverUrl) && !update.coverUrl) {
    downloadRemoteCover(bookId, targetPath, book.coverUrl!, db, log)
      .catch((err: unknown) => log.warn({ error: serializeError(err), bookId }, 'Fire-and-forget remote cover download failed'));
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
  opts?: AudioEnrichmentOptions,
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

    applyDurationFields(update, scanResult.totalDuration, log, bookId, targetPath);

    await applyTagNarrators(db, bookId, scanResult.tagNarrator, book, bookService, opts);

    // An attach acquires NO cover: covers commit on the filesystem, where three writers target the
    // same canonical `cover.<ext>`, so a row guard is the wrong altitude and the safe protocol is
    // cross-cutting work fenced to #2369. Not acquiring beats acquiring unsafely.
    if (!opts?.attach) {
      await acquireCoverArt(update, bookId, targetPath, scanResult, book, db, log);
    }

    await db.update(books).set(update).where(eq(books.id, bookId));
    await fillDurationIfEmpty(db, bookId, scanResult.totalDuration, book.duration);

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

