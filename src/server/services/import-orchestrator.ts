import { readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { ImportService, ImportResult, ImportContext, ImportProgressCallbacks } from './import.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { ConnectorService } from './connector.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { MergeService } from './merge.service.js';
import { MergeError } from './merge.service.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import type { RetrySearchDeps } from './retry-search.js';
import {
  emitDownloadImporting, emitBookImporting, emitImportStatusSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
  embedTagsForImport, runImportPostProcessing,
  isContentFailure,
} from '../utils/import-steps.js';
import { writeOpfForImport } from '../utils/opf-writer.js';
import type { BookService } from './book.service.js';
import { blacklistAndRetrySearch } from './rejection-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';
import { fireAndForget } from '../utils/fire-and-forget.js';
import { REVERT_FALLBACK_STATUS } from '../utils/book-status.js';
import type { BookImportService } from './book-import.service.js';
import { WireOnce } from './wire-helpers.js';


export interface ImportOrchestratorWireDeps {
  bookImportService: BookImportService;
  blacklistService: BlacklistService;
  retrySearchDeps: RetrySearchDeps;
  nudgeImportWorker: () => void;
}

export class ImportOrchestrator {
  private wired = new WireOnce<ImportOrchestratorWireDeps>('ImportOrchestrator');

  constructor(
    private importService: ImportService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private notifierService?: NotifierService,
    private taggingService?: TaggingService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
    private connectorService?: ConnectorService,
    private bookService?: BookService,
    private mergeService?: MergeService,
  ) {}

  /** Wire cyclic dependencies once during composition. */
  wire(deps: ImportOrchestratorWireDeps): void {
    this.wired.set(deps);
  }

  /**
   * Wrap the core import with lifecycle emissions and best-effort side effects.
   * `job` carries the caller's own book provenance; without it a context-resolution failure has no
   * identity to report, since the download row it would have been read from is what went missing.
   */
  async importDownload(downloadId: number, callbacks?: ImportProgressCallbacks, job?: { bookId: number }): Promise<ImportResult> {
    let ctx: ImportContext;
    try {
      ctx = await this.importService.getImportContext(downloadId);
    } catch (error: unknown) {
      await this.dispatchContextFailureSideEffects(error, downloadId, job);
      throw error;
    }

    // Always emit book status; suppress duplicate download status on the approve path.
    emitBookImporting({ broadcaster: this.broadcaster, bookId: ctx.bookId, bookStatus: ctx.bookStatus, log: this.log });
    if (ctx.downloadStatus !== 'importing') {
      emitDownloadImporting({ broadcaster: this.broadcaster, downloadId: ctx.downloadId, bookId: ctx.bookId, downloadStatus: ctx.downloadStatus, log: this.log });
    }

    try {
      const result = await this.importService.importDownload(downloadId, callbacks);

      await this.dispatchSuccessSideEffects(result, ctx);

      return result;
    } catch (error: unknown) {
      // ImportService has already cleaned files and reverted the DB.
      this.dispatchFailureSideEffects(error, ctx);
      throw error;
    }
  }

  /** Enqueue eligible downloads for the serial import worker. */
  async processCompletedDownloads(): Promise<number> {
    const { bookImportService, nudgeImportWorker } = this.wired.require();

    const admittedDownloads = await this.importService.getEligibleDownloads();

    if (admittedDownloads.length === 0) return 0;

    let enqueued = 0;
    for (const download of admittedDownloads) {
      try {
        // A conflict is an expected batch race, not a failure; count only created jobs.
        const created = await enqueueAutoImport(
          bookImportService, download.id, download.bookId, nudgeImportWorker, this.log,
        );
        if (created) {
          enqueued++;
        } else {
          this.log.debug({ downloadId: download.id, bookId: download.bookId }, 'Auto import skipped — active job conflict');
        }
      } catch (error: unknown) {
        this.log.warn({ downloadId: download.id, error: serializeError(error) }, 'Failed to enqueue auto import — continuing');
      }
    }

    this.log.info({ total: admittedDownloads.length, enqueued }, 'Import batch enqueued');
    return enqueued;
  }

  private async dispatchSuccessSideEffects(result: ImportResult, ctx: ImportContext): Promise<void> {
    try {
      // The embed's ownership guard IS the bookService read, so an unwired one means running
      // unguarded — skip instead, mirroring the OPF write's `if (this.bookService)` gate below.
      if (!this.bookService) {
        this.log.warn({ bookId: ctx.bookId }, 'Tag embedding skipped during import — no book service wired');
      } else {
        const taggingSettings = await this.settingsService.get('tagging');
        await embedTagsForImport({
          taggingService: this.taggingService, taggingEnabled: taggingSettings.enabled,
          taggingMode: taggingSettings.mode, embedCover: taggingSettings.embedCover,
          bookId: ctx.bookId, targetPath: result.targetPath,
          book: {
            title: ctx.book.title, authorName: ctx.authorName, narrator: ctx.narratorStr,
            seriesName: ctx.book.seriesName, seriesPosition: ctx.book.seriesPosition,
            asin: ctx.book.asin, subtitle: ctx.book.subtitle, description: ctx.book.description,
            publisher: ctx.book.publisher, publishedDate: ctx.book.publishedDate, genres: ctx.book.genres,
            coverUrl: ctx.book.coverUrl,
          },
          bookService: this.bookService,
          log: this.log,
        });
      }
    } catch (tagError: unknown) {
      this.log.warn({ error: serializeError(tagError), bookId: ctx.bookId }, 'Tagging failed during import — continuing');
    }

    // OPF is independent of ffmpeg/tag embedding. Pass the id so the helper reloads post-enrichment metadata.
    try {
      const taggingSettings = await this.settingsService.get('tagging');
      if (this.bookService) {
        await writeOpfForImport({
          enabled: taggingSettings.writeOpf, bookService: this.bookService,
          bookId: ctx.bookId, bookFolder: result.targetPath, log: this.log,
          // Unattended: the DB may be wrong, so a diverged sidecar is preserved before replacement.
          preserve: { source: 'auto', ...(this.eventHistory && { eventHistory: this.eventHistory }) },
        });
      }
    } catch (opfError: unknown) {
      this.log.warn({ error: serializeError(opfError), bookId: ctx.bookId }, 'OPF write failed during import — continuing');
    }

    try {
      const processingForScript = await this.settingsService.get('processing');
      await runImportPostProcessing({
        postProcessingScript: processingForScript.postProcessingScript,
        postProcessingScriptTimeout: processingForScript.postProcessingScriptTimeout,
        targetPath: result.targetPath, bookTitle: ctx.bookTitle, bookAuthor: ctx.authorName,
        fileCount: result.fileCount, bookId: ctx.bookId, log: this.log,
      });
    } catch (scriptError: unknown) {
      this.log.warn({ error: serializeError(scriptError), bookId: ctx.bookId }, 'Post-processing failed during import — continuing');
    }

    // The worker, not this status transition, owns the import_complete lifecycle event.
    emitImportStatusSuccess({ broadcaster: this.broadcaster, downloadId: result.downloadId, bookId: result.bookId, log: this.log });

    notifyImportComplete({ notifierService: this.notifierService, bookTitle: ctx.bookTitle, authorName: ctx.authorName, targetPath: result.targetPath, fileCount: result.fileCount, log: this.log });

    recordImportEvent({ eventHistory: this.eventHistory, bookId: ctx.bookId, bookTitle: ctx.bookTitle, authorName: ctx.authorName, downloadId: result.downloadId, bookPath: ctx.bookPath, targetPath: result.targetPath, fileCount: result.fileCount, totalSize: result.totalSize, log: this.log });

    // Dispatch connector refresh only after commit and final-path creation; never await it.
    if (this.connectorService) {
      fireAndForget(
        this.connectorService.notifyRefresh('import', [{ bookId: ctx.bookId, title: ctx.bookTitle, authorName: ctx.authorName, libraryPath: result.targetPath }]),
        this.log,
        'Failed to enqueue connector refresh on auto-import',
      );
    }

    // Download-only auto-merge is the final awaited step; manual/library imports never enter this dispatcher.
    await this.maybeEnqueueAutoMerge(result, ctx);
  }

  /**
   * Merge enqueue failures never affect a completed import. Admission uses a live top-level audio
   * count, not the recursive source count or stale DB enrichment; enqueueMerge revalidates and deduplicates.
   */
  private async maybeEnqueueAutoMerge(result: ImportResult, ctx: ImportContext): Promise<void> {
    if (!this.mergeService) return;
    try {
      const processing = await this.settingsService.get('processing');
      if (!processing.autoMergeDownloads) return;

      const entries = await readdir(result.targetPath);
      const topLevelAudioCount = entries.filter((f) => !isHiddenName(f) && AUDIO_EXTENSIONS.has(extname(f).toLowerCase())).length;
      if (topLevelAudioCount < 2) {
        this.log.debug({ bookId: ctx.bookId, topLevelAudioCount }, 'Auto-merge skipped — fewer than 2 top-level audio files');
        return;
      }

      await this.mergeService.enqueueMerge(ctx.bookId, 'auto');
      this.log.info({ bookId: ctx.bookId, topLevelAudioCount }, 'Auto-merge enqueued for multi-file download');
    } catch (mergeError: unknown) {
      // Duplicate completion/retry while queued or running is an idempotent skip.
      if (mergeError instanceof MergeError && (mergeError.code === 'ALREADY_IN_PROGRESS' || mergeError.code === 'ALREADY_QUEUED')) {
        this.log.debug({ bookId: ctx.bookId, code: mergeError.code }, 'Auto-merge already queued/running — idempotent skip');
        return;
      }
      // Pre-enqueue rejection is skipped admission, not merge_failed; only a started merge owns that event.
      this.log.warn({ error: serializeError(mergeError), bookId: ctx.bookId }, 'Auto-merge enqueue failed — import unaffected');
    }
  }

  /**
   * Sibling of dispatchFailureSideEffects for a failure that produced no ImportContext (#2307).
   * No SSE: emitImportFailure would name a download row that no longer exists and needs a
   * revertedBookStatus only bookStatusAtGrab can supply — the worker's `import_failed` is the one
   * operator-visible event for this failure. No blacklist either; a vanished row is not bad content.
   * Nothing here may throw: the context error is the only value that leaves importDownload.
   */
  private async dispatchContextFailureSideEffects(error: unknown, downloadId: number, job?: { bookId: number }): Promise<void> {
    if (!job) return;
    const { bookId } = job;

    let bookTitle: string | null = null;
    let lookupError: unknown;
    if (this.bookService) {
      try {
        bookTitle = (await this.bookService.getById(bookId))?.title ?? null;
      } catch (titleError: unknown) {
        lookupError = titleError;
      }
    }

    // book_events.book_id is an FK and book_title is NOT NULL, so without a live book there is no
    // valid row to write — the helper's .catch would swallow the violation as a silent success.
    if (bookTitle === null) {
      this.log.error({
        downloadId, bookId, error: serializeError(error),
        ...(lookupError !== undefined && { lookupError: serializeError(lookupError) }),
      }, 'Import context resolution failed — book unavailable, no history event recorded');
      return;
    }

    this.log.error({ downloadId, bookId, bookTitle, error: serializeError(error) }, 'Import context resolution failed');

    recordImportFailedEvent({ eventHistory: this.eventHistory, bookId, bookTitle, authorName: null, downloadId: null, source: 'auto', error, log: this.log });

    notifyImportFailure({ notifierService: this.notifierService, downloadTitle: bookTitle, error, log: this.log });
  }

  private dispatchFailureSideEffects(error: unknown, ctx: ImportContext): void {
    // Emit the persisted pre-grab lifecycle, with the legacy fallback; never infer it from paths.
    emitImportFailure({ broadcaster: this.broadcaster, downloadId: ctx.downloadId, bookId: ctx.bookId, revertedBookStatus: ctx.bookStatusAtGrab ?? REVERT_FALLBACK_STATUS, log: this.log });

    notifyImportFailure({ notifierService: this.notifierService, downloadTitle: ctx.downloadTitle, error, log: this.log });

    recordImportFailedEvent({ eventHistory: this.eventHistory, bookId: ctx.bookId, bookTitle: ctx.bookTitle, authorName: ctx.authorName, downloadId: ctx.downloadId, source: 'auto', error, log: this.log });

    if (isContentFailure(error)) {
      const { blacklistService, retrySearchDeps } = this.wired.require();
      blacklistAndRetrySearch({
        identifiers: {
          ...(ctx.infoHash != null && { infoHash: ctx.infoHash }),
          ...(ctx.guid != null && { guid: ctx.guid }),
          title: ctx.downloadTitle,
          bookId: ctx.bookId,
        },
        reason: 'bad_quality',
        blacklistType: 'temporary',
        book: { id: ctx.bookId },
        blacklistService,
        retrySearchDeps,
        settingsService: this.settingsService,
        log: this.log,
      }).catch((blacklistError: unknown) => {
        this.log.warn({ error: serializeError(blacklistError), downloadId: ctx.downloadId }, 'Import failure blacklist dispatch failed');
      });
    }
  }
}
