import { resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import { books } from '@db/schema.js';
import { manualImportJobPayloadSchema, type ImportAdapter, type ImportAdapterContext, type ImportJob, type ManualImportJobPayload } from './types.js';
import type { ImportPipelineDeps } from '../import-orchestration.helpers.js';
import type { AppSettings } from '@shared/schemas/settings/registry.js';
import { copyToLibrary } from '../import-orchestration.helpers.js';
import { buildAttachNaming, type AttachNaming } from '../attach-naming.js';
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
import { writeOpfForImport } from '../../utils/opf-writer.js';

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

/**
 * #2435 AC27 — substitute the offered identity at its SOURCE.
 *
 * The adapter carries offered data in exactly two variables (`payload` and the `item` derived from
 * it) and every downstream consumer reads one of them. Rebinding both to incumbent-derived values
 * makes every consumer — named or not yet written — read the incumbent by construction, which is
 * why this is a substitution rather than a list of redirected call sites: four review rounds each
 * found another member the list was missing.
 *
 * The reviewable invariant: after hydration, no expression on the attach path reads the offered
 * payload for anything but `path`, `mode` and the marker. `metadata` is dropped outright — a
 * sidecar of unknown provenance has no authority over an existing book's bibliography, and its
 * absence is also what drops `alternateAsins` from the provider lookup (AC28).
 */
function toAttachPayload(raw: ManualImportJobPayload, book: BookWithAuthor): ManualImportJobPayload {
  const authorName = book.authors?.[0]?.name;
  const narrators = book.narrators?.map((n) => n.name) ?? [];
  return {
    path: raw.path,
    ...(raw.mode !== undefined && { mode: raw.mode }),
    attach: true,
    title: book.title,
    ...(authorName ? { authorName } : {}),
    ...(book.seriesName != null && { seriesName: book.seriesName }),
    ...(book.seriesPosition != null && { seriesPosition: book.seriesPosition }),
    ...(narrators.length > 0 && { narrators }),
    ...(book.asin != null && { asin: book.asin }),
    ...(book.coverUrl != null && { coverUrl: book.coverUrl }),
  };
}

export class ManualImportAdapter implements ImportAdapter {
  readonly type = 'manual' as const;

  private readonly deps: ImportPipelineDeps;

  constructor(deps: ImportPipelineDeps) {
    this.deps = deps;
  }

  async process(job: ImportJob, ctx: ImportAdapterContext): Promise<void> {
    const { db, log } = ctx;
    const { eventHistory, broadcaster } = this.deps;

    const offered: ManualImportJobPayload = parseManualPayload(job.id, job.metadata);
    const mode = offered.mode; // undefined = pointer mode
    const attach = offered.attach === true;
    const bookId = job.bookId;

    if (bookId == null) {
      throw new Error('ManualImportAdapter requires a bookId on the job');
    }

    log.info({ bookId, title: offered.title, mode: mode ?? 'pointer', attach }, 'Processing manual import');

    const [bookRow] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
    if (!bookRow) {
      throw new Error(`Book ${bookId} not found — may have been deleted after import was queued`);
    }

    const { payload, naming } = await this.resolveAttachContext(offered, bookId, attach);

    try {
      await ctx.setPhase('analyzing');

      const item = toImportConfirmItem(payload);
      const extracted = extractImportMetadata(item);

      // Pointer mode cannot represent sibling disc folders as one book.
      if (!mode && (await reconstructDiscGroup(item.path)).length >= 2) {
        throw new Error('Cannot import a multi-disc set in pointer (in-place) mode — re-import with copy or move so the discs flatten into one book folder');
      }

      let finalPath = payload.path;
      // Persist the edition discriminator so rescans reuse it instead of re-deriving it.
      let editionLabel: string | undefined;
      if (mode) {
        const librarySettings = await this.deps.settingsService.get('library');
        await ctx.setPhase('copying');
        const copyResult = await copyToLibrary(item, extracted.meta ?? null, mode, this.deps, (progress, byteCounter) => {
          ctx.emitProgress('copying', progress, byteCounter);
        }, naming);
        finalPath = copyResult.targetPath;
        editionLabel = copyResult.editionLabel;

        await this.renameIfConfigured(finalPath, bookId, bookRow, payload, ctx, librarySettings, editionLabel);
      }

      const stats = await getAudioStats(finalPath, log);
      log.debug({ bookId, finalPath, fileCount: stats.fileCount, totalSize: stats.totalSize }, 'Audio stats collected');

      await db.update(books).set({
        path: finalPath,
        size: stats.totalSize,
        ...(editionLabel !== undefined && { editionLabel }),
        updatedAt: new Date(),
      }).where(eq(books.id, bookId));

      await ctx.setPhase('fetching_metadata');

      await this.enrich(db, bookId, finalPath, payload, extracted, attach);

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

  /** On an attach `payload` is already incumbent-derived, so every input built here is too. */
  private async enrich(
    db: ImportAdapterContext['db'], bookId: number, finalPath: string,
    payload: ManualImportJobPayload, extracted: ReturnType<typeof extractImportMetadata>, attach: boolean,
  ): Promise<void> {
    const [currentBook] = await db
      .select({ genres: books.genres, subtitle: books.subtitle, publisher: books.publisher })
      .from(books).where(eq(books.id, bookId)).limit(1);

    await orchestrateBookEnrichment(
      bookId, finalPath,
      // Runner-computed narrator provenance lives on the job payload, not the confirm item.
      buildEnrichmentBookInput({
        ...extracted.bookInput,
        genres: currentBook?.genres ?? null,
        ...(payload.narratorSource !== undefined && { narratorSource: payload.narratorSource }),
      }),
      this.deps.enrichmentDeps,
      buildBackgroundAudnexusConfig(payload, extracted, currentBook?.genres ?? null, currentBook),
      attach ? { attach: true } : undefined,
    );
  }

  /**
   * Hydrate the incumbent BEFORE any target calculation, then substitute. Called outside the try
   * on purpose: a row deleted between enqueue and processing must fail the job having written
   * nothing at all — no files, no `books` update and no `book_events` row — exactly as the
   * missing-row throw already does today. (`book_events.book_id` is an FK, so an event for a
   * deleted book could not be written even if it were wanted.)
   */
  private async resolveAttachContext(
    offered: ManualImportJobPayload, bookId: number, attach: boolean,
  ): Promise<{ payload: ManualImportJobPayload; naming: AttachNaming | undefined }> {
    if (!attach) return { payload: offered, naming: undefined };
    // A genuinely new read: the bare row above carries no author/narrator relations, and the only
    // existing `getById` sits inside renameIfConfigured, which runs after the copy.
    const incumbent = await this.deps.bookService.getById(bookId);
    if (!incumbent) {
      throw new Error(`Book ${bookId} not found — may have been deleted after import was queued`);
    }
    return { payload: toAttachPayload(offered, incumbent), naming: buildAttachNaming(incumbent) };
  }

  private async writeOpfSidecar(bookId: number, finalPath: string, log: ImportAdapterContext['log']): Promise<void> {
    try {
      const taggingSettings = await this.deps.settingsService.get('tagging');
      await writeOpfForImport({
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
