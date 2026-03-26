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

export interface MergeResult {
  bookId: number;
  outputFile: string;
  filesReplaced: number;
  message: string;
}

export class MergeError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NO_PATH' | 'NO_STATUS' | 'NO_TOP_LEVEL_FILES' | 'FFMPEG_NOT_CONFIGURED' | 'ALREADY_IN_PROGRESS',
  ) {
    super(message);
    this.name = 'MergeError';
  }
}

export class MergeService {
  private inProgress = new Set<number>();

  constructor(
    private db: Db,
    private bookService: BookService,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private eventHistory?: EventHistoryService,
    private eventBroadcaster?: EventBroadcasterService,
  ) {}

  private emitEvent(bookId: number, bookTitle: string): void {
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
        });
      } catch (e) {
        this.log.debug(e, 'SSE emit failed');
      }
    }
  }

  async mergeBook(bookId: number): Promise<MergeResult> {
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

    // Identify top-level audio files (non-recursive)
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

    this.inProgress.add(bookId);

    const stagingDir = book.path + '.merge-tmp';

    try {
      // Step 1: Create staging dir
      await mkdir(stagingDir, { recursive: true });

      // Step 2: Copy top-level audio files to staging (originals remain in book.path)
      for (const file of topLevelAudioFiles) {
        await cp(join(book.path, file), join(stagingDir, file));
      }

      // Step 3: Run processAudioFiles on staging dir
      const authorName = book.authors?.[0]?.name ?? '';
      const processingResult = await processAudioFiles(stagingDir, {
        ffmpegPath: processingSettings.ffmpegPath,
        outputFormat: 'm4b',
        bitrate: processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate,
        mergeBehavior: 'always',
      }, {
        author: authorName,
        title: book.title,
      });

      if (!processingResult.success) {
        throw new Error(`Audio processing failed: ${processingResult.error}`);
      }

      // Step 5: Pre-commit verification (read-only)
      const scanResult = await scanAudioDirectory(stagingDir);
      if (!scanResult) {
        throw new Error('Staged M4B failed verification — audio scan returned null');
      }

      // Find the staged M4B
      const stagingEntries = await readdir(stagingDir);
      const stagedM4b = stagingEntries.find((f) => extname(f).toLowerCase() === '.m4b');
      if (!stagedM4b) {
        throw new Error('Staged M4B not found after processing');
      }

      // Step 7: Commit — move M4B to book.path, delete originals, clean staging
      const outputPath = join(book.path, stagedM4b);
      await rename(join(stagingDir, stagedM4b), outputPath);

      // Delete original source files from book.path
      for (const file of topLevelAudioFiles) {
        try {
          await unlink(join(book.path, file));
        } catch {
          // Best-effort: file may have already been removed
        }
      }

      // Remove now-empty staging dir
      await rm(stagingDir, { recursive: true, force: true });

      // Update size on disk after commit
      const fileStats = await stat(outputPath);
      await this.db.update(books).set({ size: fileStats.size, updatedAt: new Date() }).where(eq(books.id, bookId));

      // Step 8: Post-commit enrichment
      const enrichResult = await enrichBookFromAudio(bookId, book.path, book, this.db, this.log, this.bookService);
      if (!enrichResult.enriched) {
        this.log.warn(
          { bookId },
          'Post-merge enrichment did not enrich — merge succeeded on disk, but DB audio fields may be stale',
        );
      }

      this.log.info({ bookId, outputPath, filesReplaced: topLevelAudioFiles.length }, 'Book merged to M4B');

      this.emitEvent(bookId, book.title);

      return {
        bookId,
        outputFile: outputPath,
        filesReplaced: topLevelAudioFiles.length,
        message: `Merged ${topLevelAudioFiles.length} files into ${basename(stagedM4b)}`,
      };
    } catch (error) {
      // Clean up staging dir on any failure (before commit the originals are untouched)
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
}
