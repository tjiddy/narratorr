import type { FastifyBaseLogger } from 'fastify';
import type { ImportService, ImportResult, ImportContext } from './import.service.js';
import type { SettingsService } from './settings.service.js';
import type { NotifierService } from './notifier.service.js';
import type { TaggingService } from './tagging.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import {
  emitDownloadImporting, emitBookImporting, emitImportSuccess,
  emitImportFailure, notifyImportComplete, notifyImportFailure,
  recordImportEvent, recordImportFailedEvent,
  embedTagsForImport, runImportPostProcessing,
} from '../utils/import-steps.js';
import { blacklistAndRetrySearch } from '../utils/rejection-helpers.js';

/** Content-failure signatures — errors caused by bad release content, not host/environment. */
const CONTENT_FAILURE_PATTERNS = [
  'No audio files found',
  'not a supported audio format',
  'Duplicate filename',
  'Copy verification failed',
] as const;

/**
 * Classify an import error as content-caused (bad release) or environment-caused (host/config).
 * Uses a positive allowlist — only known content-failure signatures return true.
 * All unrecognized errors (including Audio processing failed) default to false (conservative).
 */
export function isContentFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message;
  return CONTENT_FAILURE_PATTERNS.some((pattern) => msg.includes(pattern));
}

export class ImportOrchestrator {
  private blacklistService?: BlacklistService;
  private retrySearchDeps?: RetrySearchDeps;

  constructor(
    private importService: ImportService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private notifierService?: NotifierService,
    private taggingService?: TaggingService,
    private eventHistory?: EventHistoryService,
    private broadcaster?: EventBroadcasterService,
  ) {}

  /** Inject blacklist dependencies after construction (setter pattern — avoids constructor reordering). */
  setBlacklistDeps(blacklistService: BlacklistService, retrySearchDeps: RetrySearchDeps): void {
    this.blacklistService = blacklistService;
    this.retrySearchDeps = retrySearchDeps;
  }

  /**
   * Import a download with full side-effect orchestration.
   * Wraps ImportService.importDownload() with pre/post side effects:
   * SSE start → core import → tagging → post-processing → SSE success → notification → event recording.
   * On failure: SSE failure → failure notification → failure event recording.
   */
  async importDownload(downloadId: number): Promise<ImportResult> {
    const ctx = await this.importService.getImportContext(downloadId);

    // Pre-import SSE — book status always, download status only if not already importing (approve-path dedupe)
    emitBookImporting({ broadcaster: this.broadcaster, bookId: ctx.bookId, bookStatus: ctx.bookStatus, log: this.log });
    if (ctx.downloadStatus !== 'importing') {
      emitDownloadImporting({ broadcaster: this.broadcaster, downloadId: ctx.downloadId, bookId: ctx.bookId, downloadStatus: ctx.downloadStatus, log: this.log });
    }

    try {
      const result = await this.importService.importDownload(downloadId);

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
   * Process all eligible downloads in a batch with per-download failure visibility.
   * Owns the batch loop so failure-path side effects can be dispatched per download.
   */
  async processCompletedDownloads(): Promise<ImportResult[]> {
    const admittedIds = await this.importService.getEligibleDownloads();

    if (admittedIds.length === 0) return [];

    const startMs = Date.now();
    const importPromises = admittedIds.map((id) =>
      this.importDownload(id)
        .then((result): ImportResult | null => result)
        .catch((_error): null => {
          this.log.warn({ downloadId: id }, 'Skipping failed import, continuing with next');
          return null;
        })
        .finally(() => { this.importService.releaseSlot(); }),
    );

    const settled = await Promise.allSettled(importPromises);
    const results: ImportResult[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled' && outcome.value) {
        results.push(outcome.value);
      }
    }

    const succeeded = results.length;
    const failed = admittedIds.length - succeeded;
    this.log.info({ total: admittedIds.length, succeeded, failed, elapsedMs: Date.now() - startMs }, 'Import batch completed');

    return results;
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
      this.log.warn({ error: tagError, bookId: ctx.bookId }, 'Tagging failed during import — continuing');
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
      this.log.warn({ error: scriptError, bookId: ctx.bookId }, 'Post-processing failed during import — continuing');
    }

    // Fire-and-forget: SSE success
    emitImportSuccess({ broadcaster: this.broadcaster, downloadId: result.downloadId, bookId: result.bookId, bookTitle: ctx.bookTitle, log: this.log });

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
    recordImportFailedEvent({ eventHistory: this.eventHistory, bookId: ctx.bookId, bookTitle: ctx.bookTitle, authorName: ctx.authorName, downloadId: ctx.downloadId, error, log: this.log });

    // #504 — Blacklist content failures and trigger re-search
    if (isContentFailure(error) && this.blacklistService) {
      blacklistAndRetrySearch({
        identifiers: {
          infoHash: ctx.infoHash ?? undefined,
          guid: ctx.guid ?? undefined,
          title: ctx.downloadTitle,
          bookId: ctx.bookId,
        },
        reason: 'bad_quality',
        blacklistType: 'temporary',
        book: { id: ctx.bookId },
        blacklistService: this.blacklistService,
        retrySearchDeps: this.retrySearchDeps,
        settingsService: this.settingsService,
        log: this.log,
      }).catch((blacklistError: unknown) => {
        this.log.warn({ error: blacklistError, downloadId: ctx.downloadId }, 'Import failure blacklist dispatch failed');
      });
    }
  }
}
