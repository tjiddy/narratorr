/**
 * Bulk import pipeline — accepts user-confirmed items and queues them for the
 * import worker. Extracted for consistency with quality-gate helpers.
 */
import { mkdir, cp, rm } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import { streamCopyWithProgress } from './streaming-copy.helpers.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { SettingsService } from './settings.service.js';
import type { SeriesRefreshService } from './series-refresh.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getAudioPathSize } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { buildBookCreatePayload, type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { ImportConfirmItem, ImportMode } from './library-scan.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ManualImportJobPayload } from './import-adapters/types.js';


const COPY_VERIFICATION_THRESHOLD = 0.99;

export interface ImportPipelineDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  bookImportService: BookImportService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  enrichmentDeps: EnrichmentDeps;
  broadcaster?: EventBroadcasterService | undefined;
  seriesRefreshService?: SeriesRefreshService | undefined;
}

// eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
export async function copyToLibrary(
  item: ImportConfirmItem,
  meta: BookMetadata | null,
  mode: ImportMode,
  deps: ImportPipelineDeps,
  onProgress?: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<string> {
  const { log, settingsService } = deps;

  const librarySettings = await settingsService.get('library');
  const namingOptions = toNamingOptions(librarySettings);
  // Provider-truth precedence: accepted provider metadata wins over raw item/tag fields.
  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) — `series[0]`
  // on Audible can be a broader universe entry rather than the real book series.
  // When `meta` is null (no provider match accepted), fall back to item-derived values.
  const metaPrimarySeries = meta?.seriesPrimary ?? meta?.series?.[0];
  const targetPath = buildTargetPath(
    librarySettings.path,
    librarySettings.folderFormat,
    {
      title: item.title,
      seriesName: metaPrimarySeries?.name ?? item.seriesName ?? undefined,
      seriesPosition: metaPrimarySeries?.position ?? (item.seriesPosition !== undefined ? item.seriesPosition : undefined),
      narrators: item.narrators?.length
        ? item.narrators.map(name => ({ name }))
        : (meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined),
      publishedDate: meta?.publishedDate,
    },
    item.authorName ?? null,
    namingOptions,
  );

  if (resolve(item.path) === resolve(targetPath)) {
    log.info({ path: targetPath, mode }, 'Source and target are the same path — skipping file operation');
    return targetPath;
  }

  const rel = relative(resolve(librarySettings.path), resolve(item.path));
  if (!rel.startsWith('..') && !isAbsolute(rel)) {
    throw new Error('Source path is inside the library root — cannot import a path already managed by the library');
  }

  await mkdir(targetPath, { recursive: true });
  log.info({ source: item.path, target: targetPath, mode }, 'Copying files to library');
  if (onProgress) {
    await streamCopyWithProgress(item.path, targetPath, onProgress);
  } else {
    await cp(item.path, targetPath, { recursive: true, errorOnExist: false });
  }

  const sourceSize = await getAudioPathSize(item.path);
  const targetSize = await getAudioPathSize(targetPath);
  log.debug({ source: item.path, sourceSize, targetSize, ratio: sourceSize > 0 ? (targetSize / sourceSize).toFixed(4) : 'N/A' }, 'Copy verification');
  if (targetSize < sourceSize * COPY_VERIFICATION_THRESHOLD) {
    throw new Error(`Copy verification failed: source ${sourceSize} bytes, target ${targetSize} bytes`);
  }

  if (mode === 'move') {
    await rm(item.path, { recursive: true });
    log.info({ source: item.path }, 'Source directory removed after move');
  }

  return targetPath;
}

/**
 * Fire-and-forget: enqueue same-series refresh after a successful import
 * placeholder when the new book has the identity needed to seed the cache
 * (book ASIN + series metadata). (F3)
 */
function enqueueImportSeriesRefresh(
  deps: ImportPipelineDeps,
  book: { id: number; asin: string | null; seriesName: string | null },
  item: ImportConfirmItem,
): void {
  if (!deps.seriesRefreshService) return;
  if (!book.asin || !book.seriesName) return;
  // Prefer canonical `seriesPrimary` over `series[0]` (#1088 / #1097) — `series[0]`
  // on Audible can be a broader universe entry rather than the real book series.
  const providerSeriesId = (item.metadata?.seriesPrimary ?? item.metadata?.series?.[0])?.asin;
  deps.seriesRefreshService.enqueueRefresh(book.asin, {
    bookId: book.id,
    seriesName: book.seriesName,
    ...(providerSeriesId !== undefined && { providerSeriesId }),
  });
}

export async function confirmImport(
  items: ImportConfirmItem[],
  deps: ImportPipelineDeps,
  mode?: ImportMode,
  nudgeWorker?: () => void,
): Promise<{ accepted: number }> {
  const { log, bookService, bookImportService, eventHistory } = deps;

  log.info({ count: items.length, mode: mode ?? 'pointer' }, 'Accepting library import');

  const accepted: Array<{ bookId: number; item: ImportConfirmItem }> = [];

  for (const item of items) {
    try {
      if (!item.forceImport) {
        const existing = await bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
        if (existing) {
          log.debug({ title: item.title }, 'Skipping duplicate during import');
          continue;
        }
      }

      log.debug(
        {
          title: item.title,
          author: item.authorName,
          hasMetadata: !!item.metadata,
          asin: item.asin || item.metadata?.asin,
        },
        'Creating import placeholder',
      );

      const book = await bookService.create(buildBookCreatePayload(item, item.metadata ?? null, 'importing'));

      // Build the persisted payload — mode omitted for pointer mode
      const payload: ManualImportJobPayload = { ...item };
      if (mode) {
        payload.mode = mode;
      }

      const enqueued = await bookImportService.enqueue({
        bookId: book.id,
        type: 'manual',
        metadata: JSON.stringify(payload),
      });

      if ('error' in enqueued) {
        // Rare: the placeholder bookId already has an active job. Skip this
        // item from `accepted` so the caller's count reflects reality.
        log.warn({ bookId: book.id, title: item.title }, 'Manual import skipped — active job already exists for book');
        continue;
      }

      eventHistory.create({
        bookId: book.id,
        ...snapshotBookForEvent(book),
        eventType: 'book_added',
        source: 'manual',
      }).catch(err => log.warn({ error: serializeError(err) }, 'Failed to record book_added event'));

      enqueueImportSeriesRefresh(deps, book, item);

      accepted.push({ bookId: book.id, item });
    } catch (error: unknown) {
      log.error({ error: serializeError(error), title: item.title }, 'Failed to create placeholder for import');
    }
  }

  log.info({ accepted: accepted.length }, 'Import jobs created, nudging worker');

  if (accepted.length > 0 && nudgeWorker) {
    nudgeWorker();
  }

  return { accepted: accepted.length };
}
