import { mkdir, cp, rm } from 'node:fs/promises';
import { relative, resolve, isAbsolute } from 'node:path';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import { books } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { BookMetadata } from '../../core/metadata/index.js';
import { buildTargetPath, getAudioPathSize } from '../utils/import-helpers.js';
import { toNamingOptions } from '../../core/utils/naming.js';
import { orchestrateBookEnrichment, buildBookCreatePayload, buildEnrichmentBookInput, buildAudnexusConfig, buildImportedEventPayload, extractImportMetadata, buildBackgroundAudnexusConfig, type EnrichmentDeps } from './enrichment-orchestration.helpers.js';
import { getAudioStats } from './library-scan.helpers.js';
import type { EventHistoryService } from './event-history.service.js';
import { getErrorMessage } from '../utils/error-message.js';
import { snapshotBookForEvent } from '../utils/event-helpers.js';
import type { ImportConfirmItem, ImportMode, ImportSingleResult } from './library-scan.service.js';

const COPY_VERIFICATION_THRESHOLD = 0.99;

export interface ImportPipelineDeps {
  db: Db;
  log: FastifyBaseLogger;
  bookService: BookService;
  settingsService: SettingsService;
  eventHistory: EventHistoryService;
  enrichmentDeps: EnrichmentDeps;
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
      reason: { error: getErrorMessage(error, 'Import failed') },
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
      reason: { error: getErrorMessage(error, 'Import failed') },
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
    finalPath = await copyToLibrary(item, book as Parameters<typeof copyToLibrary>[1], meta, mode, deps);
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

// eslint-disable-next-line complexity -- copy/move pipeline with verification and retry logic
async function copyToLibrary(
  item: ImportConfirmItem,
  _book: { id: number; title: string; seriesName?: string | null; seriesPosition?: number | null; publishedDate?: string | null },
  meta: BookMetadata | null,
  mode: ImportMode,
  deps: ImportPipelineDeps,
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
  await cp(item.path, targetPath, { recursive: true, errorOnExist: false });

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
): Promise<{ accepted: number }> {
  const { log, bookService, eventHistory } = deps;

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

      eventHistory.create({
        bookId: book.id,
        ...snapshotBookForEvent(book),
        eventType: 'book_added',
        source: 'manual',
      }).catch(err => log.warn({ err }, 'Failed to record book_added event'));

      accepted.push({ bookId: book.id, item });
    } catch (error: unknown) {
      log.error({ error, title: item.title }, 'Failed to create placeholder for import');
    }
  }

  log.info({ accepted: accepted.length }, 'Import placeholders created, starting background processing');

  processImportsInBackground(accepted, deps, mode).catch(error => {
    log.error({ error }, 'Background import processing failed');
  });

  return { accepted: accepted.length };
}

async function processImportsInBackground(
  items: Array<{ bookId: number; item: ImportConfirmItem }>,
  deps: ImportPipelineDeps,
  mode?: ImportMode,
): Promise<void> {
  const { db, log, eventHistory } = deps;

  for (const { bookId, item } of items) {
    try {
      await processOneImport(bookId, item, deps, mode);
      log.info({ bookId, title: item.title }, 'Book import completed');
    } catch (error: unknown) {
      log.error({ error, bookId, title: item.title }, 'Book import failed');
      await db.update(books).set({
        status: 'missing',
        updatedAt: new Date(),
      }).where(eq(books.id, bookId));
      eventHistory.create({
        bookId,
        bookTitle: item.title,
        authorName: item.authorName ?? null,
        narratorName: item.metadata?.narrators?.[0] ?? null,
        downloadId: null,
        eventType: 'import_failed',
        source: 'manual',
        reason: { error: getErrorMessage(error, 'Import failed') },
      }).catch(err => log.warn({ err }, 'Failed to record import failed event'));
    }
  }
}

async function processOneImport(bookId: number, item: ImportConfirmItem, deps: ImportPipelineDeps, mode?: ImportMode): Promise<void> {
  const { db, log, eventHistory, enrichmentDeps } = deps;

  log.debug({ bookId, title: item.title, mode: mode ?? 'pointer' }, 'Processing import');

  const extracted = extractImportMetadata(item);

  let finalPath = item.path;
  if (mode) {
    const bookRecord = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    if (bookRecord.length > 0) {
      finalPath = await copyToLibrary(item, bookRecord[0], extracted.meta ?? null, mode, deps);
    }
  }

  const stats = await getAudioStats(finalPath, log);
  log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');
  await db.update(books).set({ path: finalPath, size: stats.totalSize, updatedAt: new Date() }).where(eq(books.id, bookId));

  const [currentBook] = await db.select({ genres: books.genres }).from(books).where(eq(books.id, bookId)).limit(1);

  log.debug({ bookId }, 'Starting audio enrichment');
  await orchestrateBookEnrichment(
    bookId, finalPath,
    buildEnrichmentBookInput({ ...extracted.bookInput, genres: currentBook?.genres ?? null }),
    enrichmentDeps,
    buildBackgroundAudnexusConfig(item, extracted, currentBook?.genres ?? null),
  );

  await db.update(books).set({ status: 'imported', updatedAt: new Date() }).where(eq(books.id, bookId));

  eventHistory.create(buildImportedEventPayload(bookId, item, extracted.narratorName, resolve(finalPath), mode))
    .catch(err => log.warn({ err }, 'Failed to record manual import event'));
}
