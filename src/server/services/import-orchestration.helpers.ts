/**
 * Single-book import pipeline — copies/moves audio to library, enriches metadata,
 * and creates the book record. Extracted for consistency with quality-gate helpers.
 */
import { mkdir, cp, rm, readdir, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { relative, resolve, isAbsolute, join } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books, importJobs } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getAudioPathSize } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { orchestrateBookEnrichment, buildBookCreatePayload, buildEnrichmentBookInput, buildAudnexusConfig, buildImportedEventPayload, type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { getAudioStats } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { ImportConfirmItem, ImportMode, ImportSingleResult } from './library-scan.service.js';
import { serializeError } from '../utils/serialize-error.js';
import type { ManualImportJobPayload } from './import-adapters/types.js';


const COPY_VERIFICATION_THRESHOLD = 0.99;

export interface ImportPipelineDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  enrichmentDeps: EnrichmentDeps;
  broadcaster?: EventBroadcasterService;
}

export async function importSingleBook(
  item: ImportConfirmItem,
  deps: ImportPipelineDeps,
  lookupMetadata: (title: string, authorName?: string) => Promise<BookMetadata | null>,
  metadata?: BookMetadata | null,
  mode?: ImportMode,
): Promise<ImportSingleResult> {
  const { log, bookService, eventHistory } = deps;

  const existing = await bookService.findDuplicate(item.title, item.authorName ? [{ name: item.authorName }] : undefined);
  if (existing) {
    log.debug({ title: item.title }, 'Skipping duplicate during import');
    return { imported: false, enriched: false, error: 'duplicate' };
  }

  const meta = metadata !== undefined ? metadata : await lookupMetadata(item.title, item.authorName);

  let book: Awaited<ReturnType<typeof bookService.create>>;
  try {
    book = await bookService.create(buildBookCreatePayload(item, meta, 'imported'));
  } catch (error: unknown) {
    eventHistory.create({
      bookId: null,
      bookTitle: item.title,
      authorName: item.authorName ?? null,
      narratorName: meta?.narrators?.[0] ?? null,
      downloadId: null,
      eventType: 'import_failed',
      source: 'manual',
      reason: { error: getErrorMessage(error) },
    }).catch(err => log.warn({ err }, 'Failed to record manual import failed event'));
    throw error;
  }

  eventHistory.create({
    bookId: book.id,
    ...snapshotBookForEvent(book),
    eventType: 'book_added',
    source: 'manual',
  }).catch(err => log.warn({ err }, 'Failed to record book_added event'));

  try {
    const enriched = await enrichImportedBook(item, book, meta, deps, mode);
    return { imported: true, bookId: book.id, enriched };
  } catch (error: unknown) {
    eventHistory.create({
      bookId: book.id,
      bookTitle: item.title,
      authorName: item.authorName ?? null,
      narratorName: meta?.narrators?.[0] ?? null,
      downloadId: null,
      eventType: 'import_failed',
      source: 'manual',
      reason: { error: getErrorMessage(error) },
    }).catch(err => log.warn({ err }, 'Failed to record manual import failed event'));
    throw error;
  }
}

async function enrichImportedBook(
  item: ImportConfirmItem,
  book: { id: number; narrators?: Array<{ name: string }> | null; duration?: number | null; coverUrl?: string | null; genres?: string[] | null },
  meta: BookMetadata | null,
  deps: ImportPipelineDeps,
  mode?: ImportMode,
): Promise<boolean> {
  const { db, log, eventHistory, enrichmentDeps } = deps;

  let finalPath = item.path;
  if (mode) {
    finalPath = await copyToLibrary(item, meta, mode, deps);
  }

  const stats = await getAudioStats(finalPath, log);
  await db.update(books).set({ path: finalPath, size: stats.totalSize, updatedAt: new Date() }).where(eq(books.id, book.id));

  const { audioEnriched } = await orchestrateBookEnrichment(
    book.id, finalPath, buildEnrichmentBookInput(book), enrichmentDeps, buildAudnexusConfig(item, meta, book),
  );

  eventHistory.create(buildImportedEventPayload(book.id, item, meta?.narrators?.[0] ?? null, resolve(finalPath), mode))
    .catch(err => log.warn({ err }, 'Failed to record manual import event'));

  log.info({ bookId: book.id, title: item.title, enriched: audioEnriched, mode: mode ?? 'pointer' }, 'Single book imported');
  return audioEnriched;
}

/**
 * Stream-based recursive copy with progress reporting.
 * Walks the source directory, copies each file via streams, and invokes
 * onProgress with (progress: 0..1, byteCounter: { current, total }).
 */
export async function streamCopyWithProgress(
  srcDir: string,
  destDir: string,
  onProgress: (progress: number, byteCounter: { current: number; total: number }) => void,
): Promise<void> {
  // Collect all files and compute total size
  const files: { relativePath: string; size: number }[] = [];
  await collectFiles(srcDir, '', files);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  let bytesCopied = 0;

  for (const file of files) {
    const srcPath = join(srcDir, file.relativePath);
    const destPath = join(destDir, file.relativePath);
    await mkdir(join(destPath, '..'), { recursive: true });

    // Track bytes per-chunk for live progress within large files
    const tracker = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytesCopied += chunk.length;
        const progress = totalSize > 0 ? bytesCopied / totalSize : 1;
        onProgress(progress, { current: bytesCopied, total: totalSize });
        callback(null, chunk);
      },
    });

    await pipeline(
      createReadStream(srcPath),
      tracker,
      createWriteStream(destPath),
    );
  }
}

async function collectFiles(dir: string, prefix: string, out: { relativePath: string; size: number }[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, relativePath, out);
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      out.push({ relativePath, size: info.size });
    }
  }
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
  const targetPath = buildTargetPath(
    librarySettings.path,
    librarySettings.folderFormat,
    {
      title: item.title,
      seriesName: item.seriesName || meta?.series?.[0]?.name,
      seriesPosition: meta?.series?.[0]?.position,
      narrators: meta?.narrators?.length ? meta.narrators.map(n => ({ name: n })) : undefined,
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

export async function confirmImport(
  items: ImportConfirmItem[],
  deps: ImportPipelineDeps,
  mode?: ImportMode,
  nudgeWorker?: () => void,
): Promise<{ accepted: number }> {
  const { db, log, bookService, eventHistory } = deps;

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

      await db.insert(importJobs).values({
        bookId: book.id,
        type: 'manual',
        status: 'pending',
        phase: 'queued',
        metadata: JSON.stringify(payload),
      });

      eventHistory.create({
        bookId: book.id,
        ...snapshotBookForEvent(book),
        eventType: 'book_added',
        source: 'manual',
      }).catch(err => log.warn({ err }, 'Failed to record book_added event'));

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
