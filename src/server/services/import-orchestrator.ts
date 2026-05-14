import type { FastifyBaseLogger } from 'fastify';
import type { ImportService, ImportResult, ImportContext, ImportProgressCallbacks } from './import.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import {
  emitDownloadImporting, emitBookImporting, emitImportStatusSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
  embedTagsForImport, runImportPostProcessing,
  isContentFailure,
} from '../utils/import-steps.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';
import { serializeError } from '../utils/serialize-error.js';
import { enqueueAutoImport } from '../utils/enqueue-auto-import.js';
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
  ) {}

  /** Wire cyclic / late-bound deps after construction. Call once during composition. */
  wire(deps: ImportOrchestratorWireDeps): void {
    this.wired.set(deps);
  }

  /**
   * Import a download with full side-effect orchestration.
   * Wraps ImportService.importDownload() with pre/post side effects:
   * SSE start → core import → tagging → post-processing → SSE success → notification → event recording.
   * On failure: SSE failure → failure notification → failure event recording.
   */
  async importDownload(downloadId: number, callbacks?: ImportProgressCallbacks): Promise<ImportResult> {
    const ctx = await this.importService.getImportContext(downloadId);

    // Pre-import SSE — book status always, download status only if not already importing (approve-path dedupe)
    emitBookImporting({ broadcaster: this.broadcaster, bookId: ctx.bookId, bookStatus: ctx.bookStatus, log: this.log });
    if (ctx.downloadStatus !== 'importing') {
      emitDownloadImporting({ broadcaster: this.broadcaster, downloadId: ctx.downloadId, bookId: ctx.bookId, downloadStatus: ctx.downloadStatus, log: this.log });
    }

    try {
      const result = await this.importService.importDownload(downloadId, callbacks);

      // Success side effects
      await this.dispatchSuccessSideEffects(result, ctx);

      return result;
    } catch (error: unknown) {
      // Failure side effects — ImportService already cleaned up files + reverted DB
      this.dispatchFailureSideEffects(error, ctx);
      throw error;
    }
  }

  /**
   * Process all eligible downloads by enqueueing them as auto import jobs.
   * The serial ImportQueueWorker drains from the queue.
   */
  async processCompletedDownloads(): Promise<number> {
    const { bookImportService, nudgeImportWorker } = this.wired.require();

    const admittedDownloads = await this.importService.getEligibleDownloads();

    if (admittedDownloads.length === 0) return 0;

    let enqueued = 0;
    for (const download of admittedDownloads) {
      try {
        // enqueueAutoImport returns false on conflict — expected race outcome
        // in batch processing, not a failure. Counter only increments when
        // a row was actually created; conflict is logged at debug level inside
        // the helper, NOT warn (downgraded to avoid noise per #747).
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
    // Best-effort: tagging
    try {
      const taggingSettings = await this.settingsService.get('tagging');
      const processingSettings = await this.settingsService.get('processing');
      await embedTagsForImport({
        taggingService: this.taggingService, taggingEnabled: taggingSettings.enabled,
        ffmpegPath: processingSettings.ffmpegPath, taggingMode: taggingSettings.mode, embedCover: taggingSettings.embedCover,
        bookId: ctx.bookId, targetPath: result.targetPath,
        book: { title: ctx.book.title, authorName: ctx.authorName, narrator: ctx.narratorStr, seriesName: ctx.book.seriesName, seriesPosition: ctx.book.seriesPosition, coverUrl: ctx.book.coverUrl },
        log: this.log,
      });
    } catch (tagError: unknown) {
      this.log.warn({ error: serializeError(tagError), bookId: ctx.bookId }, 'Tagging failed during import — continuing');
    }

    // Best-effort: post-processing
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

    // Fire-and-forget: SSE download/book status transitions. Job-lifecycle
    // `import_complete` is emitted by ImportQueueWorker.processJob — see #1108.
    emitImportStatusSuccess({ broadcaster: this.broadcaster, downloadId: result.downloadId, bookId: result.bookId, log: this.log });

    // Fire-and-forget: notification
    notifyImportComplete({ notifierService: this.notifierService, bookTitle: ctx.bookTitle, authorName: ctx.authorName, targetPath: result.targetPath, fileCount: result.fileCount, log: this.log });

    // Fire-and-forget: event recording
    recordImportEvent({ eventHistory: this.eventHistory, bookId: ctx.bookId, bookTitle: ctx.bookTitle, authorName: ctx.authorName, downloadId: result.downloadId, bookPath: ctx.bookPath, targetPath: result.targetPath, fileCount: result.fileCount, totalSize: result.totalSize, log: this.log });
  }

  private dispatchFailureSideEffects(error: unknown, ctx: ImportContext): void {
    // Fire-and-forget: SSE failure — use 'wanted' as reverted status since we don't know the exact revert
    emitImportFailure({ broadcaster: this.broadcaster, downloadId: ctx.downloadId, bookId: ctx.bookId, revertedBookStatus: ctx.bookPath ? 'imported' : 'wanted', log: this.log });

    // Fire-and-forget: failure notification
    notifyImportFailure({ notifierService: this.notifierService, downloadTitle: ctx.downloadTitle, error, log: this.log });

    // Fire-and-forget: failure event recording
    recordImportFailedEvent({ eventHistory: this.eventHistory, bookId: ctx.bookId, bookTitle: ctx.bookTitle, authorName: ctx.authorName, downloadId: ctx.downloadId, source: 'auto', error, log: this.log });

    // #504 — Blacklist content failures and trigger re-search
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
