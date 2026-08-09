import { mkdir, cp, readdir, unlink, stat, rm, rename } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import type { TaggingService } from './tagging.service.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { retagMergedOutput } from './merge-post-tag.js';
import { processAudioFiles, resolveFfmpegPath } from '@core/utils/audio-processor.js';
import type { ProcessingResult } from '@core/utils/audio-processor.js';
import { buildNamingContext, type RenameableBook } from '../utils/paths.js';
import { toNamingOptions, type NamingOptions } from '@core/utils/naming.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
import { resolveFfprobePathFromSettings } from '@core/utils/ffprobe-path.js';
import { toSourceBitrateKbps } from '../utils/audio-bitrate.js';
import { Semaphore, type SemaphoreRelease } from '../utils/semaphore.js';
import type { MergePhase, MergeFailedReason, MergeStateSnapshot } from '@shared/schemas/sse-events.js';
import { MergeStateBroadcaster } from './merge-state-broadcaster.js';
import { MergeError, validateBookForMerge, validateDequeueTime, listTopLevelAudioFiles, requireMergeMinimum } from './merge-eligibility.js';
import type { EventSource } from '@shared/schemas/event-history.js';
import { safeEmit } from '../utils/safe-emit.js';
import { createStderrDeduplicator } from '../utils/stderr-deduplicator.js';
import { getErrorMessage } from '../utils/error-message.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { serializeError } from '../utils/serialize-error.js';


/** Coerce unvalidated settings to an integer >=1; setMax accepts invalid values and Math.max(1, NaN) is NaN. */
export function clampConcurrency(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1;
}

/** Canonical event provenance for user-initiated versus unattended merges. */
export type MergeOrigin = Extract<EventSource, 'manual' | 'auto'>;

export interface MergeResult {
  bookId: number;
  outputFile: string;
  filesReplaced: number;
  message: string;
  enrichmentWarning?: string;
}

// Preserve the public import while eligibility throws from a cycle-free module.
export { MergeError } from './merge-eligibility.js';

export interface MergeAcknowledgement {
  status: 'started' | 'queued';
  bookId: number;
  position?: number;
}

export type CancelResult = { status: 'cancelled' } | { status: 'committing' } | { status: 'not-found' };

export class MergeService {
  private inProgress = new Set<number>();
  private queue: number[] = [];
  private readonly semaphore = new Semaphore(1);
  private abortControllers = new Map<number, AbortController>();
  private currentPhase = new Map<number, MergePhase>();
  // Per-book provenance follows queue/inProgress lifetime and is installed only after preflight succeeds.
  private origins = new Map<number, MergeOrigin>();
  // merge_state clears before terminal emit; the maps above clear afterward (#2129).
  private mergeState: MergeStateBroadcaster;

  constructor(
    private db: Db,
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
    private connectorService?: ConnectorService,
    // Trailing optional preserves constructors; routes/index.test.ts catches omitted composition-root wiring (#2078).
    private taggingService?: TaggingService,
  ) {
    this.mergeState = new MergeStateBroadcaster(log, eventBroadcaster);
  }

  private originFor(bookId: number): MergeOrigin {
    return this.origins.get(bookId) ?? 'manual';
  }

  /** Synchronous by contract: awaiting the SSE greeting could let stale state overwrite a newer frame (#2129). */
  getMergeStateSnapshot(): MergeStateSnapshot {
    return this.mergeState.snapshot();
  }

  /**
   * Await the start row because boot recovery discovers surviving staging only from history (#2099 D2).
   * Invoke it before SSE but await afterward, keeping live emit synchronous; terminal rows remain best-effort.
   */
  private async emitMergeStarted(bookId: number, bookTitle: string): Promise<void> {
    const recorded = this.eventHistory?.create({ bookId, bookTitle, eventType: 'merge_started', source: this.originFor(bookId) });
    safeEmit(this.eventBroadcaster, 'merge_started', { book_id: bookId, book_title: bookTitle }, this.log);
    await recorded;
  }

  private emitMergeFailed(bookId: number, bookTitle: string, error: string, reason: MergeFailedReason = 'error'): void {
    this.eventHistory?.create({ bookId, bookTitle, eventType: 'merge_failed', source: this.originFor(bookId), reason: { error } })
      .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record merge_failed event'));
    safeEmit(this.eventBroadcaster, 'merge_failed', { book_id: bookId, book_title: bookTitle, error, reason }, this.log);
  }

  /** Snapshot broadcasts are the only live progress channel; currentPhase also gates cancellation (#2142). */
  private updateMergeProgress(bookId: number, phase: MergePhase, percentage?: number): void {
    this.currentPhase.set(bookId, phase);
    this.mergeState.updateProgress(bookId, phase, percentage);
  }

  private emitMergeComplete(bookId: number, bookTitle: string, message: string, enrichmentWarning?: string): void {
    this.eventHistory?.create({ bookId, bookTitle, eventType: 'merged', source: this.originFor(bookId) })
      .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record merged event'));
    safeEmit(this.eventBroadcaster, 'merge_complete', {
      book_id: bookId, book_title: bookTitle, success: true, message,
      ...(enrichmentWarning !== undefined && { enrichmentWarning }),
    }, this.log);
  }

  async enqueueMerge(bookId: number, origin: MergeOrigin = 'manual'): Promise<MergeAcknowledgement> {
    // Keep duplicate check and mark synchronous; no await gap prevents same-book races.
    if (this.inProgress.has(bookId)) throw new MergeError('Merge already in progress for this book', 'ALREADY_IN_PROGRESS');
    if (this.queue.includes(bookId)) throw new MergeError('Merge already queued for this book', 'ALREADY_QUEUED');

    // Mark before async validation; keeping the settings read inside try prevents permanent 409s on rejection.
    this.inProgress.add(bookId);
    let bookTitle: string;
    try {
      // Reuse validation's processing read and title; another settings read can reject and another book read would suspend.
      const validated = await validateBookForMerge(this.bookService, this.settingsService, bookId);
      bookTitle = validated.title;
      // Refresh before admission; setMax does not wake waiters, so both enqueue and release paths drain FIFO.
      this.semaphore.setMax(clampConcurrency(validated.processing?.maxConcurrentProcessing));
    } catch (error: unknown) {
      this.inProgress.delete(bookId);
      throw error;
    }

    // Install provenance after preflight so a rejected enqueue cannot leak origin into a later merge.
    this.origins.set(bookId, origin);

    // Never acquire ahead of queued work. Each running merge owns exactly one release token, spent only in finally (#1984).
    const releaseSlot = this.queue.length === 0 ? this.semaphore.tryAcquire() : null;
    if (releaseSlot) {
      // Slot admission enters active(starting) in one snapshot frame (#2129).
      this.mergeState.enterActive(bookId, bookTitle);
      this.executeMerge(bookId)
        .catch((error: unknown) => {
          this.log.error({ error: serializeError(error) }, 'Merge failed for book %d', bookId);
        })
        .finally(() => {
          this.inProgress.delete(bookId);
          this.origins.delete(bookId);
          this.mergeState.clearResidue(bookId); // Backstop for exits without a terminal event.
          this.processNext(releaseSlot);
        });
      return { status: 'started', bookId };
    }

    this.inProgress.delete(bookId);
    this.queue.push(bookId);
    // Capture title without another suspension; queued state is a late joiner's only title source (#2129).
    this.mergeState.enterQueued(bookId, bookTitle);

    // A capacity raise can free slots here; drain front-first to preserve FIFO.
    this.drainQueue();

    // drainQueue may promote this book after a capacity raise; acknowledge live state, not a stale position.
    if (!this.queue.includes(bookId)) {
      return { status: 'started', bookId };
    }
    return { status: 'queued', bookId, position: this.queue.indexOf(bookId) + 1 };
  }

  private drainQueue(): void {
    for (;;) {
      if (this.queue.length === 0) return;
      const releaseSlot = this.semaphore.tryAcquire();
      if (!releaseSlot) return;
      const nextBookId = this.queue.shift()!;
      this.startQueuedMerge(nextBookId, releaseSlot);
    }
  }

  /** Release then reacquire synchronously; passing the old slot forward bypassed max and defeated capacity shrink. */
  private processNext(releaseSlot: SemaphoreRelease): void {
    releaseSlot();
    this.drainQueue();
  }

  private startQueuedMerge(bookId: number, releaseSlot: SemaphoreRelease): void {
    this.inProgress.add(bookId);

    // Promote queued→active(starting) atomically; carry the captured title and remaining FIFO positions in one frame (#2129).
    this.mergeState.enterActive(bookId, this.mergeState.titleFor(bookId));

    this.executeWithRevalidation(bookId)
      .catch((error: unknown) => {
        this.log.error({ error: serializeError(error) }, 'Queued merge failed for book %d', bookId);
      })
      .finally(() => {
        this.inProgress.delete(bookId);
        this.origins.delete(bookId);
        this.mergeState.clearResidue(bookId); // Backstop for exits without a terminal event.
        this.processNext(releaseSlot);
      });
  }

  /** Revalidation owns pre-execution terminal events; executeMerge reports before rethrow, so this layer must only log. */
  private async executeWithRevalidation(bookId: number): Promise<void> {
    try {
      await validateDequeueTime(this.bookService, bookId);
    } catch (error: unknown) {
      if (error instanceof MergeError) {
        // Use the promoted snapshot title to keep terminal sequencing await-free.
        const bookTitle = this.mergeState.titleFor(bookId);
        this.mergeState.finishTerminal(bookId, () => this.emitMergeFailed(bookId, bookTitle, error.message));
      } else {
        this.log.error({ error: serializeError(error) }, 'Dequeue-time merge revalidation failed for book %d', bookId);
      }
      return;
    }

    try {
      await this.executeMerge(bookId);
    } catch (error: unknown) {
      this.log.error({ error: serializeError(error) }, 'Dequeue-time merge execution failed for book %d', bookId);
    }
  }

  private async executeMerge(bookId: number): Promise<MergeResult> {
    const controller = new AbortController();
    this.abortControllers.set(bookId, controller);

    // Before runStaging's rm+mkdir, this deterministic path may be a crash orphan needed by boot recovery; delete only after ownership (#2099 D2).
    let stagingOwned = false;
    let stagingDir: string | undefined;

    // Assign inside try so a rejected read still emits failure and clears controller/phase state.
    let book: Awaited<ReturnType<BookService['getById']>> = null;

    try {
      book = await this.bookService.getById(bookId);
      // Throw guards through the common merge_failed path; success-shaped returns made the client chip vanish silently (#2142).
      if (!book || !book.path) throw new MergeError('Book not found', 'NOT_FOUND');
      const bookPath = book.path;

      const processingSettings = await this.settingsService.get('processing');
      const ffmpegPath = await resolveFfmpegPath();
      if (!ffmpegPath) throw new MergeError('ffmpeg is not available', 'FFMPEG_NOT_CONFIGURED');

      const librarySettings = await this.settingsService.get('library');

      // Dot-hide staging from scanners while keeping it a same-filesystem sibling for atomic rename (AC11).
      stagingDir = dotPrefixBasename(bookPath + '.merge-tmp');

      // Commit the recovery row before owning or mutating staging (#2099 D2).
      await this.emitMergeStarted(bookId, book.title);

      // Recover an armed import marker before staging, or later boot recovery can restore .import-bak over merged output (#1418).
      await recoverInterruptedCommit(bookPath, librarySettings.path, this.log);

      // Recovery can replace the source set; list afterward so staging and deletion use the same converged files.
      const topLevelAudioFiles = await listTopLevelAudioFiles(bookPath);

      // Recovery may shrink a valid queue entry below the shared merge minimum; reject before staging/commit (#2062/#2142 F9).
      requireMergeMinimum(topLevelAudioFiles);

      this.updateMergeProgress(bookId, 'staging');
      stagingOwned = true; // runStaging claims the path with rm+mkdir.
      const { stagedOutput, warnings: processingWarnings } = await this.runStaging(
        stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, { ...processingSettings, ffmpegPath },
        bookId, librarySettings.fileFormat, toNamingOptions(librarySettings), controller.signal,
      );

      // Check the abort signal before committing; cancellation during verification is cooperative.
      if (controller.signal.aborted) {
        throw new Error('Cancelled by user');
      }

      this.updateMergeProgress(bookId, 'committing');
      const outputPath = await this.commitMerge(stagingDir, stagedOutput, bookPath, topLevelAudioFiles, bookId, book);

      // Retag after commit: canonical book.path still contains unmerged parts before then, and staging lacks cover art (#2078).
      const taggingWarnings = await retagMergedOutput({
        db: this.db, settingsService: this.settingsService, log: this.log,
        taggingService: this.taggingService, connectorService: this.connectorService,
      }, bookId, outputPath);

      const ffprobePath = resolveFfprobePathFromSettings(ffmpegPath);
      const enrichResult = await enrichBookFromAudio(bookId, bookPath, book, this.db, this.log, this.bookService, ffprobePath);
      let enrichmentWarning: string | undefined;
      if (!enrichResult.enriched) {
        enrichmentWarning = 'Merge succeeded but metadata update failed — audio fields may be stale';
        this.log.warn({ bookId }, 'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale');
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged');
      // Reuse the existing message field for warnings without changing the merge_complete contract.
      const mergedSummary = `Merged ${topLevelAudioFiles.length} files into ${basename(stagedOutput)}`;
      const allWarnings = [...processingWarnings, ...taggingWarnings];
      const message = allWarnings.length > 0
        ? `${mergedSummary} (${allWarnings.join('; ')})`
        : mergedSummary;
      // Capture before the closure so TypeScript retains the non-null narrowing.
      const completedTitle = book.title;
      this.mergeState.finishTerminal(bookId, () => this.emitMergeComplete(bookId, completedTitle, message, enrichmentWarning));
      return { bookId, outputFile: outputPath, filesReplaced: topLevelAudioFiles.length, message, ...(enrichmentWarning !== undefined && { enrichmentWarning }) };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const reason: MergeFailedReason = controller.signal.aborted ? 'cancelled' : 'error';
      // A vanished row falls back to the title captured in the admission snapshot.
      const bookTitle = book?.title ?? this.mergeState.titleFor(bookId);
      this.mergeState.finishTerminal(bookId, () => this.emitMergeFailed(bookId, bookTitle, errorMessage, reason));
      // Preserve unclaimed crash residue; only this execution's staging may be removed.
      if (stagingOwned && stagingDir !== undefined) {
        try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      throw error;
    } finally {
      this.abortControllers.delete(bookId);
      this.currentPhase.delete(bookId);
    }
  }

  /** Warn on processing notices for both outcomes; deduplicated stderr is debug-only and failures can still carry adjustments. */
  private reportProcessingWarnings(bookId: number, result: ProcessingResult): string[] {
    const warnings = result.warnings ?? [];
    for (const warning of warnings) {
      this.log.warn({ bookId }, warning);
    }
    return warnings;
  }

  private async runStaging(
    stagingDir: string,
    book: RenameableBook & { path: string; authors?: Array<{ name: string }> | null; audioBitrate?: number | null },
    audioFiles: string[],
    processingSettings: { ffmpegPath: string; outputFormat?: 'm4b' | 'mp3'; keepOriginalBitrate?: boolean; bitrate?: number },
    bookId: number,
    fileFormat: string,
    namingOptions: NamingOptions,
    signal?: AbortSignal,
  ): Promise<{ stagedOutput: string; warnings: string[] }> {
    // Ownership is established; clear crash residue or it could be folded into the output (F25).
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });

    for (const file of audioFiles) {
      await cp(join(book.path, file), join(stagingDir, file));
    }

    const authorName = book.authors?.[0]?.name ?? '';
    const sourceBitrateKbps = toSourceBitrateKbps(book.audioBitrate);
    const targetBitrateKbps = processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate;

    const stderrDedup = createStderrDeduplicator(this.log);

    this.updateMergeProgress(bookId, 'processing');

    const outputFormat = processingSettings.outputFormat ?? 'm4b';
    const processingResult = await processAudioFiles(stagingDir, {
      ffmpegPath: processingSettings.ffmpegPath,
      outputFormat,
      ...(targetBitrateKbps !== undefined && { bitrate: targetBitrateKbps }),
      ...(sourceBitrateKbps !== undefined && { sourceBitrateKbps }),
    }, {
      author: authorName,
      title: book.title,
      // Legacy empty fileFormat omits template context and falls back to `${author} - ${title}`.
      ...buildNamingContext(book, authorName || null, fileFormat, namingOptions),
    }, {
      onProgress: (_phase, percentage) => {
        this.updateMergeProgress(bookId, 'processing', percentage);
      },
      onStderr: (line) => stderrDedup.push(line),
    }, signal);

    stderrDedup.flush();

    const warnings = this.reportProcessingWarnings(bookId, processingResult);

    if (!processingResult.success) {
      throw new Error(`Audio processing failed: ${processingResult.error}`);
    }

    this.updateMergeProgress(bookId, 'verifying');

    const ffprobePathVerify = resolveFfprobePathFromSettings(processingSettings.ffmpegPath);
    const scanResult = await scanAudioDirectory(stagingDir, {
      ...(ffprobePathVerify !== undefined && { ffprobePath: ffprobePathVerify }),
      onWarn: (msg, payload) => this.log.warn(payload, msg),
      onDebug: (msg, payload) => this.log.debug(payload, msg),
    });
    if (!scanResult) {
      throw new Error('Staged output failed verification — audio scan returned null');
    }

    const outputExt = outputFormat === 'mp3' ? '.mp3' : '.m4b';
    const stagingEntries = await readdir(stagingDir);
    const stagedOutput = stagingEntries.find((f) => extname(f).toLowerCase() === outputExt);
    if (!stagedOutput) {
      throw new Error('Staged output not found after processing');
    }

    return { stagedOutput, warnings };
  }

  private async commitMerge(
    stagingDir: string,
    stagedOutput: string,
    bookPath: string,
    originalsToDelete: string[],
    bookId: number,
    book: { title: string; authors?: Array<{ name: string }> | null },
  ): Promise<string> {
    const outputPath = join(bookPath, stagedOutput);
    await rename(join(stagingDir, stagedOutput), outputPath);

    // Update DB after rename but before deleting originals; a DB failure leaves both valid copies.
    const fileStats = await stat(outputPath);
    await this.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));

    for (const file of originalsToDelete) {
      if (file === stagedOutput) continue;
      try {
        await unlink(join(bookPath, file));
      } catch {
        // Best-effort; a prior cleanup may already have removed it.
      }
    }

    // Refresh after deleting originals but before staging cleanup; cleanup failure must not suppress the now-required rescan.
    enqueueBookRefresh(this.connectorService, this.log, 'merge', {
      bookId, title: book.title, authorName: book.authors?.[0]?.name ?? null, libraryPath: bookPath,
    });

    await rm(stagingDir, { recursive: true, force: true });

    return outputPath;
  }

  async cancelMerge(bookId: number): Promise<CancelResult> {
    const queueIdx = this.queue.indexOf(bookId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      // Use the enqueue snapshot title to keep terminal sequencing await-free (#2129).
      const bookTitle = this.mergeState.titleFor(bookId);
      // Finish before clearing origin so cancellation retains provenance and broadcasts updated FIFO positions.
      this.mergeState.finishTerminal(bookId, () => this.emitMergeFailed(bookId, bookTitle, 'Cancelled by user', 'cancelled'));
      this.origins.delete(bookId);
      return { status: 'cancelled' };
    }

    const phase = this.currentPhase.get(bookId);
    if (!phase) {
      // Controller exists before the first phase update, leaving a cancellation race window.
      const controller = this.abortControllers.get(bookId);
      if (controller) {
        controller.abort();
        return { status: 'cancelled' };
      }
      return { status: 'not-found' };
    }

    if (phase === 'committing') {
      return { status: 'committing' };
    }

    const controller = this.abortControllers.get(bookId);
    if (!controller) {
      return { status: 'not-found' };
    }

    controller.abort();
    return { status: 'cancelled' };
  }
}
