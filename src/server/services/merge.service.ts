import { mkdir, cp, readdir, unlink, stat, rm, rename } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { AppSettings } from '../../shared/schemas/settings/registry.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { ConnectorService } from './connector.service.js';
import { enqueueBookRefresh } from '../utils/enqueue-book-refresh.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { resolveFfprobePathFromSettings } from '../../core/utils/ffprobe-path.js';
import { toSourceBitrateKbps, logBitrateCapping } from '../utils/audio-bitrate.js';
import { Semaphore } from '../utils/semaphore.js';
import type { MergePhase, MergeFailedReason } from '../../shared/schemas/sse-events.js';
import { safeEmit } from '../utils/safe-emit.js';
import { createStderrDeduplicator } from '../utils/stderr-deduplicator.js';
import { getErrorMessage } from '../utils/error-message.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';
import { serializeError } from '../utils/serialize-error.js';


/**
 * Clamp a runtime concurrency value to a safe semaphore size (>= 1, integer).
 * setMax() performs no validation, so a NaN/0/negative/fractional value read
 * from settings must be coerced here — `Math.max(1, NaN)` is `NaN`, which would
 * poison the semaphore. Unreachable via the Zod-validated path today, but the
 * clamp's whole job is defense against an unvalidated read.
 */
export function clampConcurrency(value: number | undefined): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1;
}

export interface MergeResult {
  bookId: number;
  outputFile: string;
  filesReplaced: number;
  message: string;
  enrichmentWarning?: string;
}

export class MergeError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'NO_STATUS' | 'NO_TOP_LEVEL_FILES' | 'FFMPEG_NOT_CONFIGURED' | 'ALREADY_IN_PROGRESS' | 'ALREADY_QUEUED',
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

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

  constructor(
    private db: Db,
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
    private connectorService?: ConnectorService,
  ) {}

  private emitMergeStarted(bookId: number, bookTitle: string): void {
    this.eventHistory?.create({ bookId, bookTitle, eventType: 'merge_started', source: 'manual' })
      .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record merge_started event'));
    safeEmit(this.eventBroadcaster, 'merge_started', { book_id: bookId, book_title: bookTitle }, this.log);
  }

  private emitMergeFailed(bookId: number, bookTitle: string, error: string, reason: MergeFailedReason = 'error'): void {
    this.eventHistory?.create({ bookId, bookTitle, eventType: 'merge_failed', source: 'manual', reason: { error } })
      .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record merge_failed event'));
    safeEmit(this.eventBroadcaster, 'merge_failed', { book_id: bookId, book_title: bookTitle, error, reason }, this.log);
  }

  private emitMergeProgress(bookId: number, bookTitle: string, phase: MergePhase, percentage?: number): void {
    this.currentPhase.set(bookId, phase);
    safeEmit(this.eventBroadcaster, 'merge_progress', { book_id: bookId, book_title: bookTitle, phase, ...(percentage !== undefined && { percentage }) }, this.log);
  }

  private emitMergeComplete(bookId: number, bookTitle: string, message: string, enrichmentWarning?: string): void {
    this.eventHistory?.create({ bookId, bookTitle, eventType: 'merged', source: 'manual' })
      .catch((err) => this.log.warn({ error: serializeError(err) }, 'Failed to record merged event'));
    safeEmit(this.eventBroadcaster, 'merge_complete', {
      book_id: bookId, book_title: bookTitle, success: true, message,
      ...(enrichmentWarning !== undefined && { enrichmentWarning }),
    }, this.log);
  }

  private emitQueueEvent(event: 'merge_queued' | 'merge_queue_updated', bookId: number, bookTitle: string, position: number): void {
    safeEmit(this.eventBroadcaster, event, { book_id: bookId, book_title: bookTitle, position }, this.log);
  }

  private async emitQueuePositionUpdates(): Promise<void> {
    for (let i = 0; i < this.queue.length; i++) {
      const book = await this.bookService.getById(this.queue[i]!);
      if (book) this.emitQueueEvent('merge_queue_updated', this.queue[i]!, book.title, i + 1);
    }
  }

  /**
   * Pre-enqueue validation: throws MergeError for invalid requests. Duplicate checks are
   * in enqueueMerge (synchronous). Returns the processing settings it already fetched so
   * the caller can size the semaphore without a second (rejection-prone) read.
   */
  private async validateBookForMerge(bookId: number): Promise<AppSettings['processing']> {
    const book = await this.bookService.getById(bookId);
    if (!book) throw new MergeError('Book not found', 'NOT_FOUND');
    if (!book.path) throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
    if (book.status !== 'imported') throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    const allEntries = await readdir(book.path);
    const topLevelAudioFiles = allEntries.filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
    if (topLevelAudioFiles.length < 2) throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
    return processingSettings;
  }

  /** Public API: validate and enqueue a merge. Returns acknowledgement immediately. */
  async enqueueMerge(bookId: number): Promise<MergeAcknowledgement> {
    // Synchronous duplicate check — no await gap between check and mark prevents concurrent races
    if (this.inProgress.has(bookId)) throw new MergeError('Merge already in progress for this book', 'ALREADY_IN_PROGRESS');
    if (this.queue.includes(bookId)) throw new MergeError('Merge already queued for this book', 'ALREADY_QUEUED');

    // Mark in-progress immediately to block concurrent same-book requests during async validation.
    // The settings read + setMax live INSIDE this try so a rejecting read cleans up inProgress
    // rather than stranding the book in inProgress (every later attempt would 409 until restart).
    this.inProgress.add(bookId);
    try {
      // validateBookForMerge already reads get('processing') for the ffmpeg check — reuse its
      // return value to size the semaphore, avoiding a duplicate (rejection-prone) read.
      const processing = await this.validateBookForMerge(bookId);
      // Refresh the concurrency limit before the start-vs-queue decision. setMax() does not wake
      // already-queued waiters; FIFO ordering is preserved by the enqueue-time drain below (promote
      // front-of-queue first) and the release-path drain in processNext(). Clamp defensively — a
      // NaN/0 read would poison setMax (Math.max(1, NaN) is NaN).
      this.semaphore.setMax(clampConcurrency(processing?.maxConcurrentProcessing));
    } catch (error: unknown) {
      this.inProgress.delete(bookId); // Clean up on validation / settings-read failure
      throw error;
    }

    // Start the new request immediately ONLY when nothing is queued ahead of it and a
    // slot is free. tryAcquire() is short-circuited away when the queue is non-empty so
    // the new request never grabs a freed slot ahead of older queued work.
    if (this.queue.length === 0 && this.semaphore.tryAcquire()) {
      this.executeMerge(bookId)
        .catch((error: unknown) => {
          this.log.error({ error: serializeError(error) }, 'Merge failed for book %d', bookId);
        })
        .finally(() => {
          this.inProgress.delete(bookId);
          this.processNext(); // Pass the slot or release if empty
        });
      return { status: 'started', bookId };
    }

    // No immediate slot — append the new book to the tail of the queue.
    this.inProgress.delete(bookId);
    this.queue.push(bookId);
    const position = this.queue.length;
    const book = await this.bookService.getById(bookId);
    if (book) {
      this.emitQueueEvent('merge_queued', bookId, book.title, position);
    }

    // Drain from the FRONT of the queue while slots are free (e.g. after a capacity raise).
    // Promoting front-first guarantees older queued jobs win freed slots before the newer
    // request just appended to the tail.
    this.drainQueue();

    // Re-check reality before acknowledging: drainQueue (or the getById await above) may have
    // promoted this very book if the read raised capacity by ≥2. The pre-drain `position` would
    // then be a stale lie. Report the live state — started if promoted, else the current index.
    if (!this.queue.includes(bookId)) {
      return { status: 'started', bookId };
    }
    return { status: 'queued', bookId, position: this.queue.indexOf(bookId) + 1 };
  }

  /** Promote queued jobs from the front while free slots can be acquired. */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.semaphore.tryAcquire()) {
      const nextBookId = this.queue.shift()!;
      this.startQueuedMerge(nextBookId);
    }
  }

  /**
   * Drain step after a merge finishes: release the held slot, then re-drain through the
   * capacity-checked promotion path. Both calls are synchronous (single-threaded), so there
   * is no release/re-acquire interleave window — the old slot-pass pattern existed only to
   * guard a gap that cannot occur here, and it bypassed capacity entirely (a SHRINK never
   * took effect while a backlog existed because the slot was handed forward without
   * consulting max). Releasing first lets drainQueue's tryAcquire honor the current max.
   */
  private processNext(): void {
    this.semaphore.release();
    this.drainQueue();
  }

  /** Run a queued merge that already holds a semaphore slot (acquired by drainQueue's tryAcquire). */
  private startQueuedMerge(bookId: number): void {
    this.inProgress.add(bookId);

    this.emitQueuePositionUpdates().catch((error: unknown) => {
      this.log.debug({ error: serializeError(error) }, 'Failed to emit queue position updates');
    });

    this.executeWithRevalidation(bookId)
      .catch((error: unknown) => {
        this.log.error({ error: serializeError(error) }, 'Queued merge failed for book %d', bookId);
      })
      .finally(() => {
        this.inProgress.delete(bookId);
        this.processNext(); // Pass the slot or release if empty
      });
  }

  /** Re-validate a queued merge before executing. On failure, emit merge_failed and skip. */
  private async executeWithRevalidation(bookId: number): Promise<void> {
    try {
      await this.validateDequeueTime(bookId);
      await this.executeMerge(bookId);
    } catch (error: unknown) {
      if (error instanceof MergeError) {
        const book = await this.bookService.getById(bookId);
        this.emitMergeFailed(bookId, book?.title ?? `Book ${bookId}`, error.message);
      } else {
        this.log.error({ error: serializeError(error) }, 'Dequeue-time merge execution failed for book %d', bookId);
      }
    }
  }

  /** Dequeue-time validation — same checks as pre-enqueue but throws MergeError on failure. */
  private async validateDequeueTime(bookId: number): Promise<void> {
    const book = await this.bookService.getById(bookId);
    if (!book) throw new MergeError('Book not found', 'NOT_FOUND');
    if (!book.path) throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
    if (book.status !== 'imported') throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    const allEntries = await readdir(book.path);
    const audioFiles = allEntries.filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
    if (audioFiles.length < 2) throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
  }

  /** Execute a merge for a book that already has an acquired semaphore slot. Returns MergeResult. */
  private async executeMerge(bookId: number): Promise<MergeResult> {
    const book = await this.bookService.getById(bookId);
    if (!book || !book.path) return { bookId, outputFile: '', filesReplaced: 0, message: 'Book not found' };
    const bookPath = book.path;

    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) return { bookId, outputFile: '', filesReplaced: 0, message: 'ffmpeg not configured' };

    const librarySettings = await this.settingsService.get('library');

    const controller = new AbortController();
    this.abortControllers.set(bookId, controller);

    this.emitMergeStarted(bookId, book.title);
    const stagingDir = bookPath + '.merge-tmp';

    try {
      // Converge any interrupted commit-pending marker at bookPath BEFORE any staging
      // work (#1418). A killed import can leave bookPath with an armed marker + populated
      // `.import-bak`; without recovery, the merge output lands inside an armed path and a
      // later import/boot recovery silently reverts the merge by restoring `.import-bak`.
      // Recovery runs inside the try so a failure (BackupRecoveryError / MarkerPathConflictError
      // / raw stat error) routes to the catch → merge_failed + `.merge-tmp` cleanup, before
      // any ffmpeg work. It costs no staging work on failure.
      await recoverInterruptedCommit(bookPath, librarySettings.path, this.log);

      // Read the top-level audio set AFTER recovery — recovery can restore a different
      // original set into bookPath, and this list feeds both runStaging (what gets merged)
      // and commitMerge's originals-deletion. Reading it before recovery would stage/delete
      // a stale file list.
      const allEntries = await readdir(bookPath);
      const topLevelAudioFiles = allEntries.filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));

      // Re-validate the merge minimum on the CONVERGED folder (F9): recovery can shrink a
      // previously-valid queued merge below two top-level audio files, and processAudioFiles
      // won't merge a single-file candidate even with mergeBehavior 'always'. Abort before
      // runStaging/commitMerge — the throw routes to the catch → merge_failed + cleanup.
      if (topLevelAudioFiles.length < 2) {
        throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
      }

      this.emitMergeProgress(bookId, book.title, 'staging');
      const stagedOutput = await this.runStaging(stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, processingSettings, bookId, book.title, controller.signal);

      // Check abort signal before committing (cooperative cancel during verifying)
      if (controller.signal.aborted) {
        throw new Error('Cancelled by user');
      }

      this.emitMergeProgress(bookId, book.title, 'committing');
      const outputPath = await this.commitMerge(stagingDir, stagedOutput, bookPath, topLevelAudioFiles, bookId, book);

      const ffprobePath = resolveFfprobePathFromSettings(processingSettings.ffmpegPath);
      const enrichResult = await enrichBookFromAudio(bookId, bookPath, book, this.db, this.log, this.bookService, ffprobePath);
      let enrichmentWarning: string | undefined;
      if (!enrichResult.enriched) {
        enrichmentWarning = 'Merge succeeded but metadata update failed — audio fields may be stale';
        this.log.warn({ bookId }, 'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale');
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged');
      const message = `Merged ${topLevelAudioFiles.length} files into ${basename(stagedOutput)}`;
      this.emitMergeComplete(bookId, book.title, message, enrichmentWarning);
      return { bookId, outputFile: outputPath, filesReplaced: topLevelAudioFiles.length, message, ...(enrichmentWarning !== undefined && { enrichmentWarning }) };
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const reason: MergeFailedReason = controller.signal.aborted ? 'cancelled' : 'error';
      this.emitMergeFailed(bookId, book.title, errorMessage, reason);
      try { await rm(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      throw error;
    } finally {
      this.abortControllers.delete(bookId);
      this.currentPhase.delete(bookId);
    }
  }

  /** Steps 1-5: copy to staging, process, verify. Returns the staged output filename (extension follows outputFormat). */
  private async runStaging(
    stagingDir: string,
    book: { path: string; title: string; authors?: Array<{ name: string }> | null; audioBitrate?: number | null },
    audioFiles: string[],
    processingSettings: { ffmpegPath: string; outputFormat?: 'm4b' | 'mp3'; keepOriginalBitrate?: boolean; bitrate?: number },
    bookId: number,
    bookTitle: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await mkdir(stagingDir, { recursive: true });

    for (const file of audioFiles) {
      await cp(join(book.path, file), join(stagingDir, file));
    }

    const authorName = book.authors?.[0]?.name ?? '';
    const sourceBitrateKbps = toSourceBitrateKbps(book.audioBitrate);
    const targetBitrateKbps = processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate;
    logBitrateCapping(sourceBitrateKbps, targetBitrateKbps, this.log);

    // Build stderr deduplicator for logging
    const stderrDedup = createStderrDeduplicator(this.log);

    this.emitMergeProgress(bookId, bookTitle, 'processing');

    const outputFormat = processingSettings.outputFormat ?? 'm4b';
    const processingResult = await processAudioFiles(stagingDir, {
      ffmpegPath: processingSettings.ffmpegPath,
      outputFormat,
      ...(targetBitrateKbps !== undefined && { bitrate: targetBitrateKbps }),
      ...(sourceBitrateKbps !== undefined && { sourceBitrateKbps }),
      // Manual Merge always merges by design (decision (a)): the user explicitly clicked
      // "Merge", so honoring mergeBehavior 'never'/'multi-file-only' here would make the
      // button silently do nothing. mergeBehavior is consulted only on the bulk Convert path.
      mergeBehavior: 'always',
    }, {
      author: authorName,
      title: book.title,
    }, {
      onProgress: (_phase, percentage) => {
        this.emitMergeProgress(bookId, bookTitle, 'processing', percentage);
      },
      onStderr: (line) => stderrDedup.push(line),
    }, signal);

    stderrDedup.flush();

    if (!processingResult.success) {
      throw new Error(`Audio processing failed: ${processingResult.error}`);
    }

    this.emitMergeProgress(bookId, bookTitle, 'verifying');

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

    return stagedOutput;
  }

  /** Step 7: move the staged output to book.path, update DB size, delete originals, clean staging. */
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

    // Update DB immediately after the first irreversible step (rename).
    // If this fails, the merged M4B is still valid at outputPath; originals remain untouched.
    const fileStats = await stat(outputPath);
    await this.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));

    for (const file of originalsToDelete) {
      if (file === stagedOutput) continue; // skip: this is the output file we just moved in
      try {
        await unlink(join(bookPath, file));
      } catch {
        // Best-effort: file may have already been removed
      }
    }

    // The originals are now deleted — the irreversible media-visible swap is done. Fire the
    // connector refresh HERE, before the staging `rm` below, so a throw in `rm` (the only step
    // that can fail after this point — the DB update already ran above) can't suppress it: ABS/Plex
    // still reference the now-deleted originals and need a rescan. A merge that fails at/before the
    // DB size update fires nothing (the originals are still intact at that point).
    enqueueBookRefresh(this.connectorService, this.log, 'merge', {
      bookId, title: book.title, authorName: book.authors?.[0]?.name ?? null, libraryPath: bookPath,
    });

    await rm(stagingDir, { recursive: true, force: true });

    return outputPath;
  }

  /** Cancel a queued or in-progress merge. Returns status for the route to map to HTTP codes. */
  async cancelMerge(bookId: number): Promise<CancelResult> {
    // Check queue first
    const queueIdx = this.queue.indexOf(bookId);
    if (queueIdx !== -1) {
      this.queue.splice(queueIdx, 1);
      const book = await this.bookService.getById(bookId);
      const bookTitle = book?.title ?? `Book ${bookId}`;
      this.emitMergeFailed(bookId, bookTitle, 'Cancelled by user', 'cancelled');
      this.emitQueuePositionUpdates().catch((error: unknown) => {
        this.log.debug({ error: serializeError(error) }, 'Failed to emit queue position updates after cancellation');
      });
      return { status: 'cancelled' };
    }

    // Check in-progress
    const phase = this.currentPhase.get(bookId);
    if (!phase) {
      // Also check if the controller exists (merge may be between inProgress.add and first emitMergeProgress)
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

    // Cancel the in-progress merge by aborting its controller
    const controller = this.abortControllers.get(bookId);
    if (!controller) {
      return { status: 'not-found' };
    }

    controller.abort();
    return { status: 'cancelled' };
  }
}
