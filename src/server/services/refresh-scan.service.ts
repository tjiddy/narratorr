import { stat, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '../../core/utils/audio-constants.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { getVisiblePathSize } from '../utils/import-helpers.js';
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

export async function refreshScanBook(
  bookId: number,
  bookService: BookService,
  settingsService: SettingsService,
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
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RefreshScanError('PATH_MISSING', `Book path does not exist on disk: ${book.path}`);
    }
    throw error;
  }

  const processingSettings = await settingsService.get('processing');
  const ffprobePath = resolveFfprobePathFromSettings(processingSettings?.ffmpegPath);

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
  const narratorsUpdated = !!scanResult.tagNarrator;

  // Narrator names from tags (split on delimiters)
  const narrators = scanResult.tagNarrator
    ? scanResult.tagNarrator.split(/[,;&]/).map(n => n.trim()).filter(n => n.length > 0)
    : undefined;

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
