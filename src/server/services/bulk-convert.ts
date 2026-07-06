import { cp, mkdir, readdir, rename as fsRename, rm, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import type { BookService } from './book.service.js';
import type { ConnectorService } from './connector.service.js';
import { enqueueBookRefresh, type BookRefreshItem } from '../utils/enqueue-book-refresh.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { toSourceBitrateKbps, logBitrateCapping } from '../utils/audio-bitrate.js';

/** Deps for a single bulk-convert step. Extracted from `BulkOperationService` (it is at the line cap). */
export interface ConvertBookDeps {
  db: Db;
  bookService: BookService;
  log: FastifyBaseLogger;
  connectorService?: ConnectorService | undefined;
}

export interface ConvertProcessingSettings {
  ffmpegPath: string;
  outputFormat?: 'm4b' | 'mp3';
  mergeBehavior?: 'always' | 'multi-file-only' | 'never';
  bitrate?: number | null;
}

/**
 * Move converted output files to the book directory and remove originals that weren't outputs.
 * Returns `true` when an irreversible swap actually committed (≥1 output renamed in), `false` when
 * there was nothing to swap (`processAudioFiles` can report success with `outputFiles: []` when the
 * staging dir held no audio) — the caller gates the connector refresh on that so a no-mutation
 * convert does not report a media-visible change that never happened.
 */
async function swapConvertedFiles(outputFiles: string[], originalFiles: string[], bookPath: string): Promise<boolean> {
  if (outputFiles.length === 0) return false;
  const outputFileNames = new Set(outputFiles.map(f => basename(f)));
  for (const outputFile of outputFiles) {
    await fsRename(outputFile, join(bookPath, basename(outputFile)));
  }
  for (const file of originalFiles) {
    if (!outputFileNames.has(file)) {
      await unlink(join(bookPath, file)).catch(() => {});
    }
  }
  return true;
}

/**
 * Fire the post-swap `'convert'` connector refresh from the already-loaded book state (held from
 * before the irreversible swap), gated on an actual irreversible swap and a usable `libraryPath`.
 * A success-with-no-output convert (empty staging → `outputFiles: []`) mutated nothing on disk, so
 * it has no media-visible change. Building the item from pre-swap state — rather than a fresh
 * post-swap reload — means a transient reload failure can't silently drop the refresh (#1721).
 */
function enqueueConvertRefresh(
  deps: { connectorService?: ConnectorService | undefined; log: FastifyBaseLogger },
  swapped: boolean,
  item: BookRefreshItem,
): void {
  if (!swapped || !item.libraryPath) return;
  enqueueBookRefresh(deps.connectorService, deps.log, 'convert', item);
}

/**
 * Convert one book's audio to the target format: stage → process → swap-in → refresh-connector →
 * re-enrich DB audio fields. After the irreversible swap (rename-in + originals-unlink) a `'convert'`
 * connector refresh fires BEFORE the DB enrichment — that enrichment can throw after the swap, but the
 * media server already references the deleted originals and needs a rescan regardless.
 */
export async function convertBook(
  deps: ConvertBookDeps,
  bookId: number,
  bookPath: string,
  bookTitle: string,
  processingSettings: ConvertProcessingSettings,
): Promise<void> {
  const { db, bookService, log, connectorService } = deps;
  const stagingDir = bookPath + '.convert-tmp';
  const book = await bookService.getById(bookId);
  const authorName = book?.authors?.[0]?.name ?? 'Unknown Author';
  const sourceBitrateKbps = toSourceBitrateKbps(book?.audioBitrate);
  const targetBitrateKbps = processingSettings.bitrate ?? undefined;
  logBitrateCapping(sourceBitrateKbps, targetBitrateKbps, log);

  await mkdir(stagingDir, { recursive: true });
  try {
    // Copy audio files to staging
    const entries = await readdir(bookPath);
    const audioFiles = entries.filter(f => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
    for (const file of audioFiles) {
      await cp(join(bookPath, file), join(stagingDir, file));
    }

    const result = await processAudioFiles(
      stagingDir,
      {
        ffmpegPath: processingSettings.ffmpegPath,
        outputFormat: processingSettings.outputFormat ?? 'm4b',
        mergeBehavior: processingSettings.mergeBehavior ?? 'always',
        bitrate: targetBitrateKbps,
        sourceBitrateKbps,
      },
      { author: authorName, title: bookTitle },
    );

    if (!result.success) {
      throw new Error(result.error);
    }
    result.warnings?.forEach(w => log.warn({ bookId }, w));

    const swapped = await swapConvertedFiles(result.outputFiles, audioFiles, bookPath);
    enqueueConvertRefresh({ connectorService, log }, swapped, { bookId, title: bookTitle, authorName, libraryPath: bookPath });

    // Refresh DB audio fields
    const ffprobePath = resolveFfprobePathFromSettings(processingSettings.ffmpegPath);
    const enrichResult = await enrichBookFromAudio(
      bookId,
      bookPath,
      book ?? { narrators: null, duration: null, coverUrl: null },
      db,
      log,
      bookService,
      ffprobePath,
    );
    if (!enrichResult.enriched) {
      log.warn({ bookId }, 'Post-convert enrichment did not enrich — audio fields may be stale');
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}
