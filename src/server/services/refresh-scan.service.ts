import { stat, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { tokenizeNarrators } from '@core/utils/similarity.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import { getVisiblePathSize } from '../utils/import-helpers.js';
import { isDefinitiveAbsence } from '../utils/fs-errno.js';
import { readOpfMetadata } from '../utils/opf-reader.js';
import type { OpfMetadata } from '../utils/opf-reader.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';

export interface RefreshScanResult {
  bookId: number;
  codec: string;
  bitrate: number;
  fileCount: number;
  durationMinutes: number;
  narratorsUpdated: boolean;
}

export class RefreshScanError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'NO_PATH' | 'PATH_MISSING' | 'NO_AUDIO_FILES',
    message: string,
  ) {
    super(message);
    this.name = 'RefreshScanError';
  }
}

/**
 * The "Refresh from files" narrator ladder (#2161): **OPF sidecar → embedded tags → preserve what
 * is stored.**
 *
 * Before this existed, refresh derived narrators from `tagNarrator` unconditionally, so an operator
 * who corrected a narrator — and had that correction exported to `metadata.opf` since #1668 —
 * reverted to whatever the audio tags said the moment they hit refresh. That is the exact
 * regression #2158 closed on the import surface.
 *
 * This is not a second precedence *rule*: the order is the same OPF-first ladder
 * `import-opf-overlay.ts` documents, and the sidecar comes from the one shared `readOpfMetadata`.
 * Only the inputs are refresh-specific — `applyOpfOverlay` chooses between an OPF array and a staged
 * import item and has no notion of a tag string or of preserving stored names, so it is not
 * reusable here.
 *
 * Why `narratorSource` (the import runner's provenance signal) is not the mechanism: it is
 * runner-computed and rides the job payload only, never a column. By the time a refresh runs it no
 * longer exists, so re-reading the sidecar is the only durable provenance this surface has.
 *
 * `undefined` means **no source supplied a replacement**. The caller must then omit `narrators` from
 * the update payload entirely rather than send `[]` — `BookService.update` silently ignores an empty
 * array, so relying on that guard would leave the payload and `narratorsUpdated` disagreeing about
 * what was written.
 */
export function selectRefreshNarrators(
  opf: OpfMetadata | null,
  tagNarrator: string | undefined,
): string[] | undefined {
  // Verbatim, never re-split on `/[,;&]/`. `normalizeArray` has already trimmed, dropped empties and
  // deduplicated, and the import overlay assigns these as-is — splitting would shred a duo credited
  // under one name ("Rosalyn Landor & Simon Vance") and diverge from the import surface.
  if (opf?.narrators.length) return opf.narrators;

  // Tag derivation is unchanged: split on delimiters, trim, drop empties.
  const fromTags = tagNarrator ? tokenizeNarrators(tagNarrator) : [];
  return fromTags.length > 0 ? fromTags : undefined;
}

export async function refreshScanBook(
  bookId: number,
  bookService: BookService,
  _settingsService: SettingsService,
  log: FastifyBaseLogger,
): Promise<RefreshScanResult> {
  const book = await bookService.getById(bookId);
  if (!book) {
    throw new RefreshScanError('NOT_FOUND', `Book ${bookId} not found`);
  }

  if (!book.path) {
    throw new RefreshScanError('NO_PATH', `Book ${bookId} has no library path — import it first`);
  }

  try {
    await stat(book.path);
  } catch (error: unknown) {
    // `isDefinitiveAbsence` is the shared discriminator for "the filesystem looked
    // and found nothing" (src/server/utils/fs-errno.ts, #1955). It covers ENOTDIR as
    // well as ENOENT — a book whose library path became a regular file, or whose
    // parent did, statted ENOTDIR and used to escape as a raw errno instead of the
    // intended PATH_MISSING. Everything else (EACCES on a re-mounting share, ESTALE,
    // EIO) is undetermined and must still rethrow rather than claim the path is gone.
    if (isDefinitiveAbsence(error)) {
      throw new RefreshScanError('PATH_MISSING', `Book path does not exist on disk: ${book.path}`);
    }
    throw error;
  }

  const ffprobePath = resolveFfprobePathFromSettings(await resolveFfmpegPath());

  const scanResult = await scanAudioDirectory(book.path, {
    skipCover: true,
    ...(ffprobePath !== undefined && { ffprobePath }),
    onWarn: (msg, payload) => log.warn(payload, msg),
    onDebug: (msg, payload) => log.debug(payload, msg),
  });
  if (!scanResult) {
    throw new RefreshScanError('NO_AUDIO_FILES', 'No audio files found in book directory');
  }

  // Count top-level (non-recursive) audio files — exclude born-hidden transients (`.002.tmp.mp3`)
  const topLevelEntries = await readdir(book.path);
  const topLevelAudioFileCount = topLevelEntries.filter(
    (f) => !isHiddenName(String(f)) && AUDIO_EXTENSIONS.has(extname(String(f)).toLowerCase()),
  ).length;

  // Total directory size (all visible files, not just audio) — the visibility-aware walk skips
  // leading-dot files and dot-dir subtrees so a mid-op `.merge-tmp/` never inflates stored `size`.
  const directorySize = await getVisiblePathSize(book.path);

  const durationMinutes = Math.round(scanResult.totalDuration / 60);

  // The shared, absent-on-failure reader: absent, unreadable, oversized, malformed, or carrying no
  // usable field all yield `null` and never throw, so there is no local try/catch and a missing
  // sidecar is never a RefreshScanError. A single-file pointer path (`Doctor Sleep.m4b`) returns
  // `null` from the reader's own guard — narratorr never writes a sidecar for one — and the ladder
  // treats that like any other `null`, with no pointer-specific branch here.
  const opf = await readOpfMetadata(book.path, log);
  const narrators = selectRefreshNarrators(opf, scanResult.tagNarrator);
  // True iff a source actually supplied a replacement — not merely that a tag field was present.
  const narratorsUpdated = narrators !== undefined;

  // Skip-write guard: an all-rejected scan yields totalDuration 0 (every file's duration was
  // omitted as implausible). Writing that zero would silently clobber a correct provider/prior
  // duration and poison the baseline future quality-gate durationDelta comparisons run against,
  // so preserve the stored duration/audioDuration in that case. Other fields refresh as today.
  const durationFields =
    scanResult.totalDuration === 0
      ? {}
      : { audioDuration: Math.round(scanResult.totalDuration), duration: durationMinutes };
  if (scanResult.totalDuration === 0) {
    log.warn({ bookId }, 'Refresh scan produced 0 total duration; preserving existing duration/audioDuration');
  }

  // bookService.update() wraps narrator sync + book row update in a single transaction
  await bookService.update(bookId, {
    audioCodec: scanResult.codec,
    audioBitrate: scanResult.bitrate,
    audioSampleRate: scanResult.sampleRate,
    audioChannels: scanResult.channels,
    audioBitrateMode: scanResult.bitrateMode,
    audioFileFormat: scanResult.fileFormat,
    audioFileCount: scanResult.fileCount,
    topLevelAudioFileCount,
    audioTotalSize: scanResult.totalSize,
    size: directorySize,
    enrichmentStatus: 'file-enriched',
    ...durationFields,
    ...(narrators !== undefined ? { narrators } : {}),
  });

  log.info(
    { bookId, codec: scanResult.codec, bitrate: scanResult.bitrate, fileCount: scanResult.fileCount, durationMinutes },
    'Refresh scan complete',
  );

  return {
    bookId,
    codec: scanResult.codec,
    bitrate: scanResult.bitrate,
    fileCount: scanResult.fileCount,
    durationMinutes,
    narratorsUpdated,
  };
}
