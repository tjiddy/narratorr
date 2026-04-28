import { mkdir, cp, readdir, unlink, stat, rm, rename } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
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
import { serializeError } from '../utils/serialize-error.js';


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
      const book = await this.bookService.getById(this.queue[i]);
      if (book) this.emitQueueEvent('merge_queue_updated', this.queue[i], book.title, i + 1);
    }
  }

  /** Pre-enqueue validation: throws MergeError for invalid requests. Duplicate checks are in enqueueMerge (synchronous). */
  private async validateBookForMerge(bookId: number): Promise<void> {
    const book = await this.bookService.getById(bookId);
    if (!book) throw new MergeError('Book not found', 'NOT_FOUND');
    if (!book.path) throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
    if (book.status !== 'imported') throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    const allEntries = await readdir(book.path);
    const topLevelAudioFiles = allEntries.filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));
    if (topLevelAudioFiles.length < 2) throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
  }

  /** Public API: validate and enqueue a merge. Returns acknowledgement immediately. */
  async enqueueMerge(bookId: number): Promise<MergeAcknowledgement> {
    // Synchronous duplicate check — no await gap between check and mark prevents concurrent races
    if (this.inProgress.has(bookId)) throw new MergeError('Merge already in progress for this book', 'ALREADY_IN_PROGRESS');
    if (this.queue.includes(bookId)) throw new MergeError('Merge already queued for this book', 'ALREADY_QUEUED');

    // Mark in-progress immediately to block concurrent same-book requests during async validation
    this.inProgress.add(bookId);
    try {
      await this.validateBookForMerge(bookId);
    } catch (error: unknown) {
      this.inProgress.delete(bookId); // Clean up on validation failure
      throw error;
    }

    if (this.semaphore.tryAcquire()) {
      // Slot available — start immediately, fire-and-forget
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

    // No slot — move from inProgress to queue
    this.inProgress.delete(bookId);
    this.queue.push(bookId);
    const position = this.queue.length;
    const book = await this.bookService.getById(bookId);
    if (book) {
      this.emitQueueEvent('merge_queued', bookId, book.title, position);
    }
    return { status: 'queued', bookId, position };
  }

  /** Drain the queue: pass the semaphore slot to the next queued merge, or release if empty. */
  private processNext(): void {
    if (this.queue.length === 0) {
      this.semaphore.release(); // No more work — release the slot
      return;
    }

    // Keep the semaphore slot — pass it directly to the next job (no release + re-acquire gap)
    const nextBookId = this.queue.shift()!;
    this.inProgress.add(nextBookId);

    this.emitQueuePositionUpdates().catch((error: unknown) => {
      this.log.debug({ error: serializeError(error) }, 'Failed to emit queue position updates');
    });

    this.executeWithRevalidation(nextBookId)
      .catch((error: unknown) => {
        this.log.error({ error: serializeError(error) }, 'Queued merge failed for book %d', nextBookId);
      })
      .finally(() => {
        this.inProgress.delete(nextBookId);
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

    const allEntries = await readdir(bookPath);
    const topLevelAudioFiles = allEntries.filter((f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()));

    const controller = new AbortController();
    this.abortControllers.set(bookId, controller);

    this.emitMergeStarted(bookId, book.title);
    const stagingDir = bookPath + '.merge-tmp';

    try {
      this.emitMergeProgress(bookId, book.title, 'staging');
      const stagedM4b = await this.runStaging(stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, processingSettings, bookId, book.title, controller.signal);

      // Check abort signal before committing (cooperative cancel during verifying)
      if (controller.signal.aborted) {
        throw new Error('Cancelled by user');
      }

      this.emitMergeProgress(bookId, book.title, 'committing');
      const outputPath = await this.commitMerge(stagingDir, stagedM4b, bookPath, topLevelAudioFiles, bookId);

      const ffprobePath = resolveFfprobePathFromSettings(processingSettings.ffmpegPath);
      const enrichResult = await enrichBookFromAudio(bookId, bookPath, book, this.db, this.log, this.bookService, ffprobePath);
      let enrichmentWarning: string | undefined;
      if (!enrichResult.enriched) {
        enrichmentWarning = 'Merge succeeded but metadata update failed — audio fields may be stale';
        this.log.warn({ bookId }, 'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale');
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged to M4B');
      const message = `Merged ${topLevelAudioFiles.length} files into ${basename(stagedM4b)}`;
      this.emitMergeComplete(bookId, book.title, message, enrichmentWarning);
      return { bookId, outputFile: outputPath, filesReplaced: topLevelAudioFiles.length, message, enrichmentWarning };
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

  /** Steps 1-5: copy to staging, process, verify. Returns the staged M4B filename. */
  private async runStaging(
    stagingDir: string,
    book: { path: string; title: string; authors?: Array<{ name: string }> | null; audioBitrate?: number | null },
    audioFiles: string[],
    processingSettings: { ffmpegPath: string; keepOriginalBitrate?: boolean; bitrate?: number },
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

    const processingResult = await processAudioFiles(stagingDir, {
      ffmpegPath: processingSettings.ffmpegPath,
      outputFormat: 'm4b',
      bitrate: targetBitrateKbps,
      sourceBitrateKbps,
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
      ffprobePath: ffprobePathVerify,
      onWarn: (msg, payload) => this.log.warn(payload, msg),
      onDebug: (msg, payload) => this.log.debug(payload, msg),
    });
    if (!scanResult) {
      throw new Error('Staged M4B failed verification — audio scan returned null');
    }

    const stagingEntries = await readdir(stagingDir);
    const stagedM4b = stagingEntries.find((f) => extname(f).toLowerCase() === '.m4b');
    if (!stagedM4b) {
      throw new Error('Staged M4B not found after processing');
    }

    return stagedM4b;
  }

  /** Step 7: move M4B to book.path, update DB size, delete originals, clean staging. */
  private async commitMerge(
    stagingDir: string,
    stagedM4b: string,
    bookPath: string,
    originalsToDelete: string[],
    bookId: number,
  ): Promise<string> {
    const outputPath = join(bookPath, stagedM4b);
    await rename(join(stagingDir, stagedM4b), outputPath);

    // Update DB immediately after the first irreversible step (rename).
    // If this fails, the merged M4B is still valid at outputPath; originals remain untouched.
    const fileStats = await stat(outputPath);
    await this.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));

    for (const file of originalsToDelete) {
      if (file === stagedM4b) continue; // skip: this is the output file we just moved in
      try {
        await unlink(join(bookPath, file));
      } catch {
        // Best-effort: file may have already been removed
      }
    }

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
