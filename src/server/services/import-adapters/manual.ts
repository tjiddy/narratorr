import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { books } from '@db/schema.js';
import { manualImportJobPayloadSchema, type ImportAdapter, type ImportAdapterContext, type ImportJob, type ManualImportJobPayload } from './types.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { copyToLibrary } from '../import-orchestration.helpers.js';
import type { ImportConfirmItem } from '../library-scan.service.js';
import { getAudioStats } from '../library-scan.helpers.js';
import { orchestrateBookEnrichment, buildEnrichmentBookInput, buildBackgroundAudnexusConfig, buildImportedEventPayload, extractImportMetadata } from '../enrichment-orchestration.helpers.js';
import { reconstructDiscGroup } from '../../utils/import-helpers.js';
import { renameFilesWithTemplate } from '../../utils/paths.js';
import type { RenameableBook } from '../../utils/paths.js';
import { OwnedRecordingError, type BookWithAuthor } from '../book.service.js';
import { toNamingOptions } from '@core/utils/naming.js';
import { safeEmit } from '../../utils/safe-emit.js';
import { recordImportFailedEvent } from '../../utils/import-side-effects.js';
import { transitionBookStatus } from '../../utils/book-status.js';
import { serializeError } from '../../utils/serialize-error.js';
import { fireAndForget } from '../../utils/fire-and-forget.js';
import { writeOpfForImportWithinAdmissionLock } from '../../utils/opf-writer.js';
import { withBookAdmissionLock } from '../book-admission.js';
import { beginRootCommit } from '../library-root-gate.js';
import type { BookMetadata } from '@core/metadata/index.js';

// Prefer this import's unpersisted edition label with ?? so an empty label survives.
function buildRenameableBook(
  fullBook: BookWithAuthor | null,
  bookRow: { title: string; seriesName: string | null; seriesPosition: number | null; publishedDate: string | null },
  pendingEditionLabel?: string,
): RenameableBook {
  return {
    title: fullBook?.title ?? bookRow.title,
    seriesName: fullBook?.seriesName ?? bookRow.seriesName,
    seriesPosition: fullBook?.seriesPosition ?? bookRow.seriesPosition,
    narrators: fullBook?.narrators?.map(n => ({ name: n.name })) ?? null,
    publishedDate: fullBook?.publishedDate ?? bookRow.publishedDate,
    editionLabel: pendingEditionLabel ?? fullBook?.editionLabel ?? null,
  };
}

function parseManualPayload(jobId: number, raw: string): ManualImportJobPayload {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`Invalid manual import payload for job ${jobId}: malformed JSON`, { cause: error });
  }
  const result = manualImportJobPayloadSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new Error(`Invalid manual import payload for job ${jobId}: shape mismatch`, { cause: result.error });
  }
  return result.data;
}

// Omit undefined optionals to satisfy exactOptionalPropertyTypes without widening the DTO.
function toImportConfirmItem(payload: ManualImportJobPayload): ImportConfirmItem {
  return {
    path: payload.path,
    title: payload.title,
    ...(payload.authorName !== undefined && { authorName: payload.authorName }),
    ...(payload.seriesName !== undefined && { seriesName: payload.seriesName }),
    ...(payload.narrators !== undefined && { narrators: payload.narrators }),
    ...(payload.seriesPosition !== undefined && { seriesPosition: payload.seriesPosition }),
    ...(payload.coverUrl !== undefined && { coverUrl: payload.coverUrl }),
    ...(payload.asin !== undefined && { asin: payload.asin }),
    ...(payload.metadata !== undefined && { metadata: payload.metadata }),
    ...(payload.forceImport !== undefined && { forceImport: payload.forceImport }),
  };
}

export class ManualImportAdapter implements ImportAdapter {
  readonly type = 'manual' as const;

  private readonly deps: ImportPipelineDeps;

  constructor(deps: ImportPipelineDeps) {
    this.deps = deps;
  }

  async process(job: ImportJob, ctx: ImportAdapterContext): Promise<void> {
    const payload: ManualImportJobPayload = parseManualPayload(job.id, job.metadata);
    const bookId = job.bookId;

    if (bookId == null) {
      throw new Error('ManualImportAdapter requires a bookId on the job');
    }

    return withBookAdmissionLock(bookId, () => this.processWithinAdmissionLock(bookId, payload, ctx));
  }

  /**
   * Caller must hold the admission lock for `bookId`. The row read, the library root and the copy
   * all sit inside it, so an import queued behind a rename or a delete cannot copy into — or
   * commit a `path` naming — a folder the row no longer owns.
   */
  private async processWithinAdmissionLock(
    bookId: number,
    payload: ManualImportJobPayload,
    ctx: ImportAdapterContext,
  ): Promise<void> {
    const { db, log } = ctx;
    const { eventHistory, enrichmentDeps, broadcaster } = this.deps;
    const mode = payload.mode; // undefined = pointer mode

    log.info({ bookId, title: payload.title, mode: mode ?? 'pointer' }, 'Processing manual import');

    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    if (!bookRow) {
      throw new Error(`Book ${bookId} not found — may have been deleted after import was queued`);
    }

    try {
      await ctx.setPhase('analyzing');

      const item = toImportConfirmItem(payload);
      const extracted = extractImportMetadata(item);

      // Pointer mode cannot represent sibling disc folders as one book.
      if (!mode && (await reconstructDiscGroup(item.path)).length >= 2) {
        throw new Error('Cannot import a multi-disc set in pointer (in-place) mode — re-import with copy or move so the discs flatten into one book folder');
      }

      const finalPath = mode
        ? await this.commitCopyUnderRootCommit(item, extracted.meta ?? null, mode, bookId, bookRow, payload, ctx)
        : await this.commitImportedPath(bookId, payload.path, undefined, ctx);

      await ctx.setPhase('fetching_metadata');

      const [currentBook] = await db.select({ genres: books.genres, subtitle: books.subtitle, publisher: books.publisher }).from(books).where(eq(books.id, bookId)).limit(1);

      await orchestrateBookEnrichment(
        bookId, finalPath,
        // Runner-computed narrator provenance lives on the job payload, not the confirm item.
        buildEnrichmentBookInput({
          ...extracted.bookInput,
          genres: currentBook?.genres ?? null,
          ...(payload.narratorSource !== undefined && { narratorSource: payload.narratorSource }),
        }),
        enrichmentDeps,
        buildBackgroundAudnexusConfig(payload, extracted, currentBook?.genres ?? null, currentBook),
      );

      await transitionBookStatus(db, bookId, { status: 'imported' });
      safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing', new_status: 'imported' }, log);

      eventHistory.create(buildImportedEventPayload(bookId, payload, extracted.narratorName, resolve(finalPath), mode))
        .catch((err: unknown) => log.warn({ error: serializeError(err) }, 'Failed to record manual import event'));

      // Await the canonical OPF write; unlike connector notifications it is not droppable.
      await this.writeOpfSidecar(bookId, finalPath, log);

      this.enqueueConnectorRefresh(bookId, payload, finalPath, mode, log);
    } catch (error: unknown) {
      this.dispatchFailureSideEffects(error, bookId, payload, log);
      throw error;
    }
  }

  /**
   * Copy mode derives its target from the library root, so it registers as a root-dependent commit,
   * takes the canonical root from the gate — no second settings read — and holds the registration
   * from that derivation through the `path` commit. Releasing at the end of the copy would let a
   * `library` write land between the files committing under the old root and the row committing
   * that old-root path. Pointer mode never reads the root and registers nothing.
   */
  private async commitCopyUnderRootCommit(
    item: ImportConfirmItem,
    extractedMeta: BookMetadata | null,
    mode: NonNullable<ManualImportJobPayload['mode']>,
    bookId: number,
    bookRow: { title: string; seriesName: string | null; seriesPosition: number | null; publishedDate: string | null },
    payload: ManualImportJobPayload,
    ctx: ImportAdapterContext,
  ): Promise<string> {
    const rootCommit = await beginRootCommit(this.deps.settingsService);
    try {
      await ctx.setPhase('copying');
      const copyResult = await copyToLibrary(item, extractedMeta, mode, this.deps, rootCommit.library, (progress, byteCounter) => {
        ctx.emitProgress('copying', progress, byteCounter);
      });
      await this.renameIfConfigured(
        copyResult.targetPath, bookId, bookRow, payload, ctx, rootCommit.library, copyResult.editionLabel,
      );
      return await this.commitImportedPath(bookId, copyResult.targetPath, copyResult.editionLabel, ctx);
    } finally {
      rootCommit.release();
    }
  }

  /**
   * Half of the import commit; the `imported` transition in the caller is the other half. They are
   * two statements because enrichment runs between them and a failure there must not leave the row
   * claiming `imported` — this is NOT atomic. What makes the intermediate `path=new,
   * status=importing` state unobservable is the admission lock: every other mutator of this book,
   * including the reconciler and rename, has to wait for the section to finish.
   */
  private async commitImportedPath(
    bookId: number,
    finalPath: string,
    editionLabel: string | undefined,
    ctx: ImportAdapterContext,
  ): Promise<string> {
    const stats = await getAudioStats(finalPath, ctx.log);
    ctx.log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');

    await transitionBookStatus(ctx.db, bookId, {
      path: finalPath,
      size: stats.totalSize,
      ...(editionLabel !== undefined && { editionLabel }),
    });
    return finalPath;
  }

  private async writeOpfSidecar(bookId: number, finalPath: string, log: ImportAdapterContext['log']): Promise<void> {
    try {
      const taggingSettings = await this.deps.settingsService.get('tagging');
      await writeOpfForImportWithinAdmissionLock({
        enabled: taggingSettings.writeOpf, bookService: this.deps.bookService,
        bookId, bookFolder: finalPath, log,
        // Unattended: the DB may be wrong, so a diverged sidecar is preserved before replacement.
        preserve: { source: 'manual', eventHistory: this.deps.eventHistory },
      });
    } catch (opfError: unknown) {
      log.warn({ error: serializeError(opfError), bookId }, 'OPF write failed during manual import — continuing');
    }
  }

  private enqueueConnectorRefresh(
    bookId: number, payload: ManualImportJobPayload, finalPath: string,
    mode: ManualImportJobPayload['mode'], log: ImportAdapterContext['log'],
  ): void {
    if (!this.deps.connectorService) return;
    fireAndForget(
      this.deps.connectorService.notifyRefresh(mode ? 'import' : 'adopt', [
        { bookId, title: payload.title, authorName: payload.authorName ?? null, libraryPath: finalPath },
      ]),
      log,
      'Failed to enqueue connector refresh on manual import',
    );
  }

  private dispatchFailureSideEffects(
    error: unknown, bookId: number, payload: ManualImportJobPayload, log: ImportAdapterContext['log'],
  ): void {
    const { eventHistory, broadcaster } = this.deps;
    // Forced collisions belong to the worker's refusal path; non-forced collisions remain failures.
    if (error instanceof OwnedRecordingError && payload.forceImport === true) return;
    safeEmit(broadcaster, 'book_status_change', { book_id: bookId, old_status: 'importing', new_status: 'failed' }, log);
    recordImportFailedEvent({
      eventHistory,
      bookId,
      bookTitle: payload.title ?? 'Unknown',
      authorName: payload.authorName ?? null,
      narratorName: payload.narrators?.[0] ?? payload.metadata?.narrators?.[0] ?? null,
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
    editionLabel?: string,
  ): Promise<void> {
    if (!librarySettings.fileFormat?.trim()) return;

    await ctx.setPhase('renaming');
    const fullBook = await this.deps.bookService.getById(bookId);
    const renameableBook = buildRenameableBook(fullBook, bookRow, editionLabel);
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
