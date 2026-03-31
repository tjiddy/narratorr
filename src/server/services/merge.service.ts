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
      } catch (error: unknown) {
        this.log.debug(error, 'SSE emit failed');
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
    const bookPath = book.path;
    if (book.status !== 'imported') {
      throw new MergeError(`Book is not imported (status: ${book.status})`, 'NO_STATUS');
    }

    const processingSettings = await this.settingsService.get('processing');
    if (!processingSettings?.ffmpegPath?.trim()) {
      throw new MergeError('ffmpeg is not configured', 'FFMPEG_NOT_CONFIGURED');
    }

    // Identify top-level audio files (non-recursive)
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

    const stagingDir = bookPath + '.merge-tmp';

    try {
      const stagedM4b = await this.runStaging(stagingDir, { ...book, path: bookPath }, topLevelAudioFiles, processingSettings);
      const outputPath = await this.commitMerge(stagingDir, stagedM4b, bookPath, topLevelAudioFiles, bookId);

      // Step 8: Post-commit enrichment
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

      this.emitEvent(bookId, book.title);

      return {
        bookId,
        outputFile: outputPath,
        filesReplaced: topLevelAudioFiles.length,
        message: `Merged ${topLevelAudioFiles.length} files into ${basename(stagedM4b)}`,
        enrichmentWarning,
      };
    } catch (error: unknown) {
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

  /** Steps 1-5: copy to staging, process, verify. Returns the staged M4B filename. */
  private async runStaging(
    stagingDir: string,
    book: { path: string; title: string; authors?: Array<{ name: string }> | null; audioBitrate?: number | null },
    audioFiles: string[],
    processingSettings: { ffmpegPath: string; keepOriginalBitrate?: boolean; bitrate?: number },
  ): Promise<string> {
    await mkdir(stagingDir, { recursive: true });

    for (const file of audioFiles) {
      await cp(join(book.path, file), join(stagingDir, file));
    }

    const authorName = book.authors?.[0]?.name ?? '';
    const sourceBitrateKbps = toSourceBitrateKbps(book.audioBitrate);
    const targetBitrateKbps = processingSettings.keepOriginalBitrate ? undefined : processingSettings.bitrate;
    logBitrateCapping(sourceBitrateKbps, targetBitrateKbps, this.log);

    const processingResult = await processAudioFiles(stagingDir, {
      ffmpegPath: processingSettings.ffmpegPath,
      outputFormat: 'm4b',
      bitrate: targetBitrateKbps,
      sourceBitrateKbps,
      mergeBehavior: 'always',
    }, {
      author: authorName,
      title: book.title,
    });

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
