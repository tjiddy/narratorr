import { stat, readdir } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Stats } from 'node:fs';
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
 * Narrator precedence is OPF→tags→stored. Re-read OPF because import provenance is not persisted.
 * undefined means no replacement and must omit narrators; BookService ignores [], which would make
 * narratorsUpdated disagree with the write.
 */
export function selectRefreshNarrators(
  opf: OpfMetadata | null,
  tagNarrator: string | undefined,
): string[] | undefined {
  // OPF arrays are already normalized; re-splitting would shred a duo credited under one name.
  if (opf?.narrators.length) return opf.narrators;

  const fromTags = tagNarrator ? tokenizeNarrators(tagNarrator) : [];
  return fromTags.length > 0 ? fromTags : undefined;
}

/** One root stat answers both existence and file-root classification. */
async function statRoot(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error: unknown) {
    // ENOENT/ENOTDIR prove absence; EACCES, ESTALE, EIO, and other uncertain errors must propagate.
    if (isDefinitiveAbsence(error)) {
      throw new RefreshScanError('PATH_MISSING', `Book path does not exist on disk: ${path}`);
    }
    throw error;
  }
}

/** Keep pointer-file classification aligned with audio scanning and size walking; input is a basename. */
function isVisibleAudioName(name: string): boolean {
  return !isHiddenName(name) && AUDIO_EXTENSIONS.has(extname(name).toLowerCase());
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

  const rootStat = await statRoot(book.path);

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

  // Root kind comes from stat, never extension: pointer files count directly, while directories
  // named *.m4b are read. Let non-file readdir errors propagate instead of persisting zero.
  let topLevelAudioFileCount: number;
  if (rootStat.isFile()) {
    topLevelAudioFileCount = isVisibleAudioName(basename(book.path)) ? 1 : 0;
  } else {
    const topLevelEntries = await readdir(book.path);
    topLevelAudioFileCount = topLevelEntries.filter((f) => isVisibleAudioName(String(f))).length;
  }

  // Count all visible bytes, excluding dotfiles/subtrees such as mid-operation .merge-tmp.
  const directorySize = await getVisiblePathSize(book.path);

  const durationMinutes = Math.round(scanResult.totalDuration / 60);

  // The shared reader maps absent/unreadable/invalid OPF to null; pointer files have no sidecar.
  const opf = await readOpfMetadata(book.path, log);
  const narrators = selectRefreshNarrators(opf, scanResult.tagNarrator);
  // True only when OPF or usable tags supplied a replacement.
  const narratorsUpdated = narrators !== undefined;

  // An all-rejected scan reports zero; preserve prior duration or future quality deltas use a poisoned baseline.
  const durationFields =
    scanResult.totalDuration === 0
      ? {}
      : { audioDuration: Math.round(scanResult.totalDuration), duration: durationMinutes };
  if (scanResult.totalDuration === 0) {
    log.warn({ bookId }, 'Refresh scan produced 0 total duration; preserving existing duration/audioDuration');
  }

  // BookService updates narrator links and the row in one transaction.
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
