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
import { toSourceBitrateKbps, logBitrateCapping } from '../utils/audio-bitrate.js';
import { Semaphore } from '../utils/semaphore.js';

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

export class MergeService {
  private inProgress = new Set<number>();
  private queue: number[] = [];
  private readonly semaphore = new Semaphore(1);

  constructor(
    private db: Db,
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
  ) {}

  private emitMergeStarted(bookId: number, bookTitle: string): void {
    this.eventHistory?.create({
      bookId,
      bookTitle,
      eventType: 'merge_started',
      source: 'manual',
    }).catch((err) => this.log.warn(err, 'Failed to record merge_started event'));

    if (this.eventBroadcaster) {
      try {
        this.eventBroadcaster.emit('merge_started', {
          book_id: bookId,
          book_title: bookTitle,
        });
      } catch (error: unknown) {
        this.log.debug(error, 'SSE emit failed for merge_started');
      }
    }
  }

  private emitMergeFailed(bookId: number, bookTitle: string, error: string): void {
    this.eventHistory?.create({
      bookId,
      bookTitle,
      eventType: 'merge_failed',
      source: 'manual',
      reason: { error },
    }).catch((err) => this.log.warn(err, 'Failed to record merge_failed event'));

    if (this.eventBroadcaster) {
      try {
        this.eventBroadcaster.emit('merge_failed', {
          book_id: bookId,
          book_title: bookTitle,
          error,
        });
      } catch (emitError: unknown) {
        this.log.debug(emitError, 'SSE emit failed for merge_failed');
      }
    }
  }

  private emitMergeProgress(bookId: number, bookTitle: string, phase: 'staging' | 'processing' | 'verifying' | 'finalizing', percentage?: number): void {
    if (!this.eventBroadcaster) return;
    try {
      this.eventBroadcaster.emit('merge_progress', {
        book_id: bookId,
        book_title: bookTitle,
        phase,
        ...(percentage !== undefined && { percentage }),
      });
    } catch (error: unknown) {
      this.log.debug(error, 'SSE emit failed for merge_progress');
    }
  }

  private emitMergeComplete(bookId: number, bookTitle: string, message: string, enrichmentWarning?: string): void {
    this.eventHistory?.create({
      bookId,
      bookTitle,
      eventType: 'merged',
      source: 'manual',
    }).catch((err) => this.log.warn(err, 'Failed to record merged event'));

    if (this.eventBroadcaster) {
      try {
        this.eventBroadcaster.emit('merge_complete', {
          book_id: bookId,
          book_title: bookTitle,
          success: true,
          message,
          ...(enrichmentWarning !== undefined && { enrichmentWarning }),
        });
      } catch (error: unknown) {
        this.log.debug(error, 'SSE emit failed');
      }
    }
  }

  private emitMergeQueued(bookId: number, bookTitle: string, position: number): void {
    if (!this.eventBroadcaster) return;
    try {
      this.eventBroadcaster.emit('merge_queued', {
        book_id: bookId,
        book_title: bookTitle,
        position,
      });
    } catch (error: unknown) {
      this.log.debug(error, 'SSE emit failed for merge_queued');
    }
  }

  private emitMergeQueueUpdated(bookId: number, bookTitle: string, position: number): void {
    if (!this.eventBroadcaster) return;
    try {
      this.eventBroadcaster.emit('merge_queue_updated', {
        book_id: bookId,
        book_title: bookTitle,
        position,
      });
    } catch (error: unknown) {
      this.log.debug(error, 'SSE emit failed for merge_queue_updated');
    }
  }

  private async emitQueuePositionUpdates(): Promise<void> {
    for (let i = 0; i < this.queue.length; i++) {
      const queuedBookId = this.queue[i];
      const book = await this.bookService.getById(queuedBookId);
      if (book) {
        this.emitMergeQueueUpdated(queuedBookId, book.title, i + 1);
      }
    }
  }

  /** Pre-enqueue validation: throws MergeError synchronously for invalid requests. */
  private async validatePreEnqueue(bookId: number): Promise<{ book: Awaited<ReturnType<BookService['getById']>>; bookPath: string }> {
    const book = await this.bookService.getById(bookId);
    if (!book) {
      throw new MergeError('Book not found', 'NOT_FOUND');
    }
    if (!book.path) {
      throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
    }
    if (book.status !== 'imported') {
      throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    }

    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) {
      throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    }

    const allEntries = await readdir(book.path);
    const topLevelAudioFiles = allEntries.filter(
      (f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()),
    );
    if (topLevelAudioFiles.length < 2) {
      throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
    }

    if (this.inProgress.has(bookId)) {
      throw new MergeError('Merge already in progress for this book', 'ALREADY_IN_PROGRESS');
    }
    if (this.queue.includes(bookId)) {
      throw new MergeError('Merge already queued for this book', 'ALREADY_QUEUED');
    }

    return { book, bookPath: book.path };
  }

  /** Public API: validate and enqueue a merge. Returns acknowledgement immediately. */
  async enqueueMerge(bookId: number): Promise<MergeAcknowledgement> {
    await this.validatePreEnqueue(bookId);

    if (this.semaphore.tryAcquire()) {
      // Slot available — start immediately, fire-and-forget
      this.inProgress.add(bookId);
      this.executeMerge(bookId)
        .catch((error: unknown) => {
          this.log.error(error, 'Merge failed for book %d', bookId);
        })
        .finally(() => {
          this.inProgress.delete(bookId);
          this.semaphore.release();
          this.processNext();
        });
      return { status: 'started', bookId };
    }

    // No slot — queue
    this.queue.push(bookId);
    const position = this.queue.length;
    const book = await this.bookService.getById(bookId);
    if (book) {
      this.emitMergeQueued(bookId, book.title, position);
    }
    return { status: 'queued', bookId, position };
  }

  /** Drain the queue: start the next queued merge if a slot is available. */
  private processNext(): void {
    if (this.queue.length === 0) return;

    const nextBookId = this.queue.shift()!;
    this.inProgress.add(nextBookId);

    // Emit position updates for remaining queued items
    this.emitQueuePositionUpdates().catch((error: unknown) => {
      this.log.debug(error, 'Failed to emit queue position updates');
    });

    // Dequeue-time revalidation + execution
    this.executeWithRevalidation(nextBookId)
      .catch((error: unknown) => {
        this.log.error(error, 'Queued merge failed for book %d', nextBookId);
      })
      .finally(() => {
        this.inProgress.delete(nextBookId);
        this.semaphore.release();
        this.processNext();
      });
  }

  /** Re-validate a queued merge before executing. On failure, emit merge_failed and skip. */
  private async executeWithRevalidation(bookId: number): Promise<void> {
    try {
      // Re-run preflight checks at dequeue time
      const book = await this.bookService.getById(bookId);
      if (!book) {
        this.emitMergeFailed(bookId, `Book ${bookId}`, 'Book not found');
        return;
      }
      if (!book.path) {
        this.emitMergeFailed(bookId, book.title, 'Book has no path — not imported yet');
        return;
      }
      if (book.status !== 'imported') {
        this.emitMergeFailed(bookId, book.title, `Book is not imported (status: ${book.status})`);
        return;
      }
      const processingSettings = await this.settingsService.get('processing');
      if (!processingSettings?.ffmpegPath?.trim()) {
        this.emitMergeFailed(bookId, book.title, 'ffmpeg is not configured');
        return;
      }
      const allEntries = await readdir(book.path);
      const topLevelAudioFiles = allEntries.filter(
        (f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()),
      );
      if (topLevelAudioFiles.length < 2) {
        this.emitMergeFailed(bookId, book.title, 'No top-level audio files to merge (requires ≥2)');
        return;
      }

      await this.executeMerge(bookId);
    } catch (error: unknown) {
      this.log.error(error, 'Dequeue-time merge execution failed for book %d', bookId);
    }
  }

  /** Execute a merge for a book that already has an acquired semaphore slot. */
  private async executeMerge(bookId: number): Promise<void> {
    const book = await this.bookService.getById(bookId);
    if (!book || !book.path) return;
    const bookPath = book.path;

    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) return;

    const allEntries = await readdir(bookPath);
    const topLevelAudioFiles = allEntries.filter(
      (f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()),
    );

    this.emitMergeStarted(bookId, book.title);

    const stagingDir = bookPath + '.merge-tmp';

    try {
      this.emitMergeProgress(bookId, book.title, 'staging');

      const stagedM4b = await this.runStaging(stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, processingSettings, bookId, book.title);

      this.emitMergeProgress(bookId, book.title, 'verifying');

      const outputPath = await this.commitMerge(stagingDir, stagedM4b, bookPath, topLevelAudioFiles, bookId);

      this.emitMergeProgress(bookId, book.title, 'finalizing');

      const enrichResult = await enrichBookFromAudio(bookId, bookPath, book, this.db, this.log, this.bookService);
      let enrichmentWarning: string | undefined;
      if (!enrichResult.enriched) {
        enrichmentWarning = 'Merge succeeded but metadata update failed — audio fields may be stale';
        this.log.warn(
          { bookId },
          'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale',
        );
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged to M4B');

      const message = `Merged ${topLevelAudioFiles.length} files into ${basename(stagedM4b)}`;
      this.emitMergeComplete(bookId, book.title, message, enrichmentWarning);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown merge error';
      this.emitMergeFailed(bookId, book.title, errorMessage);

      try {
        await rm(stagingDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      throw error;
    }
  }

  /** @deprecated Use enqueueMerge() instead. Kept for backward compatibility during migration. */
  async mergeBook(bookId: number): Promise<MergeResult> {
    const book = await this.bookService.getById(bookId);
    if (!book) {
      throw new MergeError('Book not found', 'NOT_FOUND');
    }
    if (!book.path) {
      throw new MergeError('Book has no path — not imported yet', 'NO_PATH');
    }
    const bookPath = book.path;
    if (book.status !== 'imported') {
      throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    }

    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) {
      throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    }

    const allEntries = await readdir(bookPath);
    const topLevelAudioFiles = allEntries.filter(
      (f) => AUDIO_EXTENSIONS.has(extname(f).toLowerCase()),
    );
    if (topLevelAudioFiles.length < 2) {
      throw new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES');
    }

    if (this.inProgress.has(bookId)) {
      throw new MergeError('Merge already in progress for this book', 'ALREADY_IN_PROGRESS');
    }

    this.inProgress.add(bookId);

    this.emitMergeStarted(bookId, book.title);

    const stagingDir = bookPath + '.merge-tmp';

    try {
      this.emitMergeProgress(bookId, book.title, 'staging');

      const stagedM4b = await this.runStaging(stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, processingSettings, bookId, book.title);

      this.emitMergeProgress(bookId, book.title, 'verifying');

      const outputPath = await this.commitMerge(stagingDir, stagedM4b, bookPath, topLevelAudioFiles, bookId);

      this.emitMergeProgress(bookId, book.title, 'finalizing');

      const enrichResult = await enrichBookFromAudio(bookId, bookPath, book, this.db, this.log, this.bookService);
      let enrichmentWarning: string | undefined;
      if (!enrichResult.enriched) {
        enrichmentWarning = 'Merge succeeded but metadata update failed — audio fields may be stale';
        this.log.warn(
          { bookId },
          'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale',
        );
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged to M4B');

      const message = `Merged ${topLevelAudioFiles.length} files into ${basename(stagedM4b)}`;
      this.emitMergeComplete(bookId, book.title, message, enrichmentWarning);

      return {
        bookId,
        outputFile: outputPath,
        filesReplaced: topLevelAudioFiles.length,
        message,
        enrichmentWarning,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown merge error';
      this.emitMergeFailed(bookId, book.title, errorMessage);

      try {
        await rm(stagingDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      throw error;
    } finally {
      this.inProgress.delete(bookId);
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
    });

    stderrDedup.flush();

    if (!processingResult.success) {
      throw new Error(`Audio processing failed: ${processingResult.error}`);
    }

    const scanResult = await scanAudioDirectory(stagingDir);
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
}

/** Deduplicates repeated stderr lines before logging. */
function createStderrDeduplicator(log: FastifyBaseLogger) {
  let lastLine = '';
  let count = 0;

  function flushPrevious() {
    if (count === 0) return;
    if (count === 1) {
      log.debug({ stderr: lastLine }, 'ffmpeg stderr');
    } else {
      log.debug({ stderr: lastLine, count }, `ffmpeg stderr (× ${count})`);
    }
    count = 0;
    lastLine = '';
  }

  return {
    push(line: string) {
      if (line === lastLine) {
        count++;
      } else {
        flushPrevious();
        lastLine = line;
        count = 1;
      }
    },
    flush() {
      flushPrevious();
    },
  };
}
