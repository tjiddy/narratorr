import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { books } from '../../../db/schema.js';
import type { BookStatus } from '../../../shared/schemas/book.js';
import type { ImportAdapter, ImportAdapterContext, ImportJob, ManualImportJobPayload } from './types.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { AppSettings } from '../../../shared/schemas/settings/registry.js';
import { copyToLibrary } from '../import-orchestration.helpers.js';
import { getAudioStats } from '../library-scan.helpers.js';
import { orchestrateBookEnrichment, buildEnrichmentBookInput, buildBackgroundAudnexusConfig, buildImportedEventPayload, extractImportMetadata } from '../enrichment-orchestration.helpers.js';
import { renameFilesWithTemplate } from '../../utils/paths.js';
import type { RenameableBook } from '../../utils/paths.js';
import { toNamingOptions } from '../../../core/utils/naming.js';
import { safeEmit } from '../../utils/safe-emit.js';
import { recordImportFailedEvent } from '../../utils/import-side-effects.js';

export class ManualImportAdapter implements ImportAdapter {
  readonly type = 'manual' as const;

  private readonly deps: ImportPipelineDeps;

  constructor(deps: ImportPipelineDeps) {
    this.deps = deps;
  }

  async process(job: ImportJob, ctx: ImportAdapterContext): Promise<void> {
    const { db, log } = ctx;
    const { eventHistory, enrichmentDeps, broadcaster } = this.deps;

    const payload: ManualImportJobPayload = JSON.parse(job.metadata);
    const mode = payload.mode; // undefined = pointer mode
    const bookId = job.bookId;

    if (bookId == null) {
      throw new Error('ManualImportAdapter requires a bookId on the job');
    }

    log.info({ bookId, title: payload.title, mode: mode ?? 'pointer' }, 'Processing manual import');

    // Verify the book still exists
    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    if (!bookRow) {
      throw new Error(`Book ${bookId} not found — may have been deleted after import was queued`);
    }

    try {
      await ctx.setPhase('analyzing');

      const extracted = extractImportMetadata(payload);

      let finalPath = payload.path;
      if (mode) {
        const librarySettings = await this.deps.settingsService.get('library');
        await ctx.setPhase('copying');
        finalPath = await copyToLibrary(payload, extracted.meta ?? null, mode, this.deps, (progress, byteCounter) => {
          ctx.emitProgress('copying', progress, byteCounter);
        });

        await this.renameIfConfigured(finalPath, bookId, bookRow, payload, ctx, librarySettings);
      }

      const stats = await getAudioStats(finalPath, log);
      log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');

      await db.update(books).set({ path: finalPath, size: stats.totalSize, updatedAt: new Date() }).where(eq(books.id, bookId));

      await ctx.setPhase('fetching_metadata');

      const [currentBook] = await db.select({ genres: books.genres }).from(books).where(eq(books.id, bookId)).limit(1);

      await orchestrateBookEnrichment(
        bookId, finalPath,
        buildEnrichmentBookInput({ ...extracted.bookInput, genres: currentBook?.genres ?? null }),
        enrichmentDeps,
        buildBackgroundAudnexusConfig(payload, extracted, currentBook?.genres ?? null),
      );

      await db.update(books).set({ status: 'imported', updatedAt: new Date() }).where(eq(books.id, bookId));
      safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing' as BookStatus, new_status: 'imported' as BookStatus }, log);

      eventHistory.create(buildImportedEventPayload(bookId, payload, extracted.narratorName, resolve(finalPath), mode))
        .catch((err: unknown) => log.warn({ err }, 'Failed to record manual import event'));
    } catch (error: unknown) {
      this.dispatchFailureSideEffects(error, bookId, payload, log);
      throw error;
    }
  }

  private dispatchFailureSideEffects(
    error: unknown, bookId: number, payload: ManualImportJobPayload, log: ImportAdapterContext['log'],
  ): void {
    const { eventHistory, broadcaster } = this.deps;
    // Failure side effects — emit SSE and record event before re-throwing (worker marks job/book as failed)
    safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing' as BookStatus, new_status: 'failed' as BookStatus }, log);
    recordImportFailedEvent({
      eventHistory,
      bookId,
      bookTitle: payload.title ?? 'Unknown',
      authorName: payload.authorName ?? null,
      narratorName: payload.metadata?.narrators?.[0] ?? null,
      downloadId: null,
      source: 'manual',
      error,
      log,
    });
  }

  private async renameIfConfigured(
    finalPath: string, bookId: number, bookRow: { title: string; seriesName: string | null; seriesPosition: number | null; publishedDate: string | null },
    payload: ManualImportJobPayload, ctx: ImportAdapterContext,
    librarySettings: AppSettings['library'],
  ): Promise<void> {
    if (!librarySettings.fileFormat?.trim()) return;

    await ctx.setPhase('renaming');
    const fullBook = await this.deps.bookService.getById(bookId);
    const renameableBook: RenameableBook = {
      title: fullBook?.title ?? bookRow.title,
      seriesName: fullBook?.seriesName ?? bookRow.seriesName,
      seriesPosition: fullBook?.seriesPosition ?? bookRow.seriesPosition,
      narrators: fullBook?.narrators?.map(n => ({ name: n.name })) ?? null,
      publishedDate: fullBook?.publishedDate ?? bookRow.publishedDate,
    };
    const namingOptions = toNamingOptions(librarySettings);
    await renameFilesWithTemplate(
      finalPath,
      librarySettings.fileFormat,
      renameableBook,
      payload.authorName ?? null,
      ctx.log,
      namingOptions,
      (current, total) => ctx.emitProgress('renaming', total > 0 ? current / total : 0, { current, total }),
    );
  }
}
