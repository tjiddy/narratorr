import { writeFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db, DbOrTx } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { bookNarrators, books, narrators } from '@db/schema.js';
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

  // Awaited, not fired and forgotten: an un-awaited download outlives whatever lock its caller
  // holds, so its file write and DB localization would land unserialized by construction.
  // The `catch` keeps the previous error isolation — the writer never throws by contract, but a
  // cover failure must not become an enrichment failure if that ever changes.
  if (isRemoteCoverUrl(book.coverUrl) && !update.coverUrl) {
    await downloadRemoteCoverWithinAdmissionLock(bookId, targetPath, book.coverUrl!, db, log)
      .catch((err: unknown) => log.warn({ error: serializeError(err), bookId }, 'Remote cover download failed'));
  }
}

/**
 * The controlling snapshot the unlocked entry substitutes for its caller's: folder, fill-empty
 * duration and cover, and the narrator provenance the tag-fill gate reads. Null when the row is
 * gone or owns no folder.
 */
async function readEnrichmentSnapshot(
  db: Db,
  bookId: number,
  narratorSource: NarratorSource | undefined,
): Promise<{ targetPath: string; book: AudioEnrichmentBook } | null> {
  const rows = await db
    .select({ path: books.path, duration: books.duration, coverUrl: books.coverUrl })
    .from(books)
    .where(eq(books.id, bookId))
    .limit(1);
  const row = rows[0];
  if (!row?.path) return null;

  const narratorRows = await db
    .select({ name: narrators.name })
    .from(bookNarrators)
    .innerJoin(narrators, eq(narrators.id, bookNarrators.narratorId))
    .where(eq(bookNarrators.bookId, bookId));

  return {
    targetPath: row.path,
    book: {
      narrators: narratorRows,
      duration: row.duration,
      coverUrl: row.coverUrl,
      ...(narratorSource !== undefined && { narratorSource }),
    },
  };
}

/**
 * Serialized entry point for callers that hold no admission lock. Like `downloadRemoteCover`, it
 * takes no folder or row snapshot: anything an unlocked caller could hand in was read before the
 * section, so a call queued behind a rename would scan the vacated folder, drop its cover there and
 * then commit that scan to the row it no longer describes (AC3). `narratorSource` is the exception —
 * it is per-import provenance carried on the job payload, not a column, so there is no row to read
 * it from.
 */
export async function enrichBookFromAudio(
  bookId: number,
  db: Db,
  log: FastifyBaseLogger,
  bookService?: BookService,
  ffprobePath?: string,
  narratorSource?: NarratorSource,
): Promise<EnrichmentResult> {
  return withBookAdmissionLock(bookId, async () => {
    const snapshot = await readEnrichmentSnapshot(db, bookId, narratorSource);
    if (!snapshot) {
      log.debug({ bookId }, 'Audio enrichment skipped — the book owns no folder now');
      return { enriched: false };
    }
    return enrichBookFromAudioWithinAdmissionLock(
      bookId, snapshot.targetPath, snapshot.book, db, log, bookService, ffprobePath,
    );
  });
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

    // An attach acquires NO cover (#2435 AC — the offered item has no authority over the
    // incumbent's art). Every other caller runs the in-lock cover protocol: #2435 fenced this
    // to #2369, and the fence has arrived — acquireCoverArt now writes and downloads inside the
    // admission section this function requires of its caller.
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

