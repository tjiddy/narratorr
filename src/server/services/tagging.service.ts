import { execFile } from 'node:child_process';
import { readdir, rename, unlink, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TagMode } from '../../shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';

const execFileAsync = promisify(execFile);

/** Extensions we can write tags to via ffmpeg */
const TAGGABLE_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b']);

export interface TagMetadata {
  artist?: string;       // author
  albumArtist?: string;  // author
  album?: string;        // book title
  title?: string;        // book title (for single-file) or chapter/part
  composer?: string;     // narrator
  grouping?: string;     // series name
  track?: number;        // track number (multi-file only)
  trackTotal?: number;   // total tracks
}

export interface TagFileResult {
  file: string;
  status: 'tagged' | 'skipped' | 'failed';
  reason?: string;
}

export interface RetagResult {
  bookId: number;
  tagged: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

/**
 * Read existing tags from a file to determine which fields are already populated.
 */
async function readExistingTags(filePath: string): Promise<Partial<TagMetadata>> {
  try {
    const metadata = await parseFile(filePath);
    const common = metadata.common;
    return {
      artist: common.artist || undefined,
      albumArtist: common.albumartist || undefined,
      album: common.album || undefined,
      title: common.title || undefined,
      composer: common.composer?.[0] || undefined,
      grouping: common.grouping || undefined,
      track: common.track?.no ?? undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Build ffmpeg args for writing metadata tags to an audio file.
 * Uses temp file + verify + rename strategy to prevent corruption.
 */
export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  tags: TagMetadata,
  coverPath?: string,
): string[] {
  const args = ['-y', '-i', inputPath];

  if (coverPath) {
    args.push('-i', coverPath);
  }

  // Map inputs
  args.push('-map', '0:a');
  if (coverPath) {
    args.push('-map', '1');
    args.push('-c:v', 'copy');
    args.push('-disposition:v', 'attached_pic');
  }

  // Copy audio codec (no re-encode)
  args.push('-c:a', 'copy');

  // Write metadata tags
  if (tags.artist) args.push('-metadata', `artist=${tags.artist}`);
  if (tags.albumArtist) args.push('-metadata', `album_artist=${tags.albumArtist}`);
  if (tags.album) args.push('-metadata', `album=${tags.album}`);
  if (tags.title) args.push('-metadata', `title=${tags.title}`);
  if (tags.composer) args.push('-metadata', `composer=${tags.composer}`);
  if (tags.grouping) args.push('-metadata', `grouping=${tags.grouping}`);
  if (tags.track != null && tags.trackTotal != null) {
    args.push('-metadata', `track=${tags.track}/${tags.trackTotal}`);
  }

  args.push(outputPath);
  return args;
}

/**
 * Determine which tags to write based on mode.
 * In 'populate_missing' mode, only write tags that are currently empty.
 * In 'overwrite' mode, write all tags.
 */
function resolveTags(
  desired: TagMetadata,
  existing: Partial<TagMetadata>,
  mode: TagMode,
): TagMetadata | null {
  if (mode === 'overwrite') {
    // In overwrite, write everything we have
    return desired;
  }

  // populate_missing: only write fields that are currently empty
  const resolved: TagMetadata = {};
  let hasAnyTag = false;

  for (const key of ['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping'] as const) {
    if (desired[key] && !existing[key]) {
      resolved[key] = desired[key];
      hasAnyTag = true;
    }
  }

  if (desired.track != null && existing.track == null) {
    resolved.track = desired.track;
    resolved.trackTotal = desired.trackTotal;
    hasAnyTag = true;
  }

  return hasAnyTag ? resolved : null;
}

/**
 * Tag a single audio file using ffmpeg.
 * Returns the result status for this file.
 */
export async function tagFile(
  filePath: string,
  ffmpegPath: string,
  tags: TagMetadata,
  mode: TagMode,
  coverPath?: string,
): Promise<TagFileResult> {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath);

  if (!TAGGABLE_EXTENSIONS.has(ext)) {
    return { file: fileName, status: 'skipped', reason: `Unsupported format: ${ext}` };
  }

  // Read existing tags for populate_missing mode
  const existing = mode === 'populate_missing' ? await readExistingTags(filePath) : {};
  const resolvedTags = resolveTags(tags, existing, mode);

  // Check if cover embedding is needed when in populate_missing mode
  const shouldEmbedCover = coverPath && (mode === 'overwrite' || !await fileHasCoverArt(filePath));

  if (!resolvedTags && !shouldEmbedCover) {
    return { file: fileName, status: 'skipped', reason: 'All tags already populated' };
  }

  const dir = dirname(filePath);
  const tmpPath = join(dir, `${basename(filePath, ext)}.tmp${ext}`);

  try {
    const ffmpegArgs = buildFfmpegArgs(
      filePath,
      tmpPath,
      resolvedTags ?? {},
      shouldEmbedCover ? coverPath : undefined,
    );

    await execFileAsync(ffmpegPath, ffmpegArgs);

    // Verify temp file exists and has reasonable size
    const [originalStat, tmpStat] = await Promise.all([stat(filePath), stat(tmpPath)]);
    if (tmpStat.size < originalStat.size * 0.5) {
      await unlink(tmpPath).catch(() => {});
      return { file: fileName, status: 'failed', reason: 'Output file suspiciously small — possible corruption' };
    }

    // Atomically replace original with temp (rename overwrites destination on POSIX)
    await rename(tmpPath, filePath);

    return { file: fileName, status: 'tagged' };
  } catch (error: unknown) {
    // Clean up temp file on failure
    await unlink(tmpPath).catch(() => {});
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { file: fileName, status: 'failed', reason: message };
  }
}

async function fileHasCoverArt(filePath: string): Promise<boolean> {
  try {
    const metadata = await parseFile(filePath);
    return (metadata.common.picture?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * Find a cover image file in a directory.
 */
async function findCoverFile(dirPath: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dirPath);
    const coverFile = entries.find(f => /^cover\.(jpg|jpeg|png|webp)$/i.test(f));
    return coverFile ? join(dirPath, coverFile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect audio files in a directory and sort them with locale-aware numeric ordering.
 */
async function collectAudioFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath);
  const audioFiles = entries
    .filter(f => TAGGABLE_EXTENSIONS.has(extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return audioFiles.map(f => join(dirPath, f));
}

/**
 * Scan a directory for audio files with unsupported formats and return warning entries.
 */
async function warnUnsupportedFormats(
  dirPath: string,
  log: FastifyBaseLogger,
): Promise<{ skipped: number; warnings: string[] }> {
  const entries = await readdir(dirPath);
  const warnings: string[] = [];
  let skipped = 0;
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && !TAGGABLE_EXTENSIONS.has(ext)) {
      skipped++;
      const reason = `Unsupported format: ${ext}`;
      log.warn({ file: entry, reason }, 'Tag write skipped');
      warnings.push(`${entry}: ${reason}`);
    }
  }
  return { skipped, warnings };
}

export class TaggingService {
  constructor(
    _db: Db,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private bookService?: BookService,
  ) {}

  /**
   * Tag audio files in a book's directory using metadata from the database.
   * Called during import and manual re-tag.
   */
  async tagBook(
    bookId: number,
    bookPath: string,
    metadata: {
      title: string;
      authorName?: string | null;
      narrator?: string | null;
      seriesName?: string | null;
      seriesPosition?: number | null;
      coverUrl?: string | null;
    },
    ffmpegPath: string,
    mode: TagMode,
    embedCover: boolean,
  ): Promise<RetagResult> {
    const result: RetagResult = { bookId, tagged: 0, skipped: 0, failed: 0, warnings: [] };

    const audioFiles = await collectAudioFiles(bookPath);

    // Warn about unsupported audio formats in the directory
    const unsupported = await warnUnsupportedFormats(bookPath, this.log);
    result.skipped += unsupported.skipped;
    result.warnings.push(...unsupported.warnings);

    if (audioFiles.length === 0) {
      result.warnings.push('No taggable audio files found');
      return result;
    }

    // Find cover image for embedding
    let coverPath: string | undefined;
    if (embedCover) {
      coverPath = await findCoverFile(bookPath);
      if (!coverPath) {
        result.warnings.push('Cover art embedding enabled but no cover image found in book directory');
      }
    }

    const isSingleFile = audioFiles.length === 1;

    for (let i = 0; i < audioFiles.length; i++) {
      const filePath = audioFiles[i];
      const tags: TagMetadata = {
        artist: metadata.authorName || undefined,
        albumArtist: metadata.authorName || undefined,
        album: metadata.title,
        title: metadata.title,
        composer: metadata.narrator || undefined,
        grouping: metadata.seriesName || undefined,
      };

      // Track numbers only for multi-file books
      if (!isSingleFile) {
        tags.track = i + 1;
        tags.trackTotal = audioFiles.length;
      }

      const fileResult = await tagFile(filePath, ffmpegPath, tags, mode, coverPath);
      result[fileResult.status]++;

      if (fileResult.status === 'failed') {
        this.log.warn({ file: fileResult.file, reason: fileResult.reason }, 'Tag write failed');
        result.warnings.push(`${fileResult.file}: ${fileResult.reason}`);
      } else if (fileResult.status === 'skipped' && fileResult.reason !== 'All tags already populated') {
        this.log.warn({ file: fileResult.file, reason: fileResult.reason }, 'Tag write skipped');
        result.warnings.push(`${fileResult.file}: ${fileResult.reason}`);
      }
    }

    this.log.info(
      { bookId, tagged: result.tagged, skipped: result.skipped, failed: result.failed },
      'Tag embedding completed',
    );

    return result;
  }

  /**
   * Re-tag files for an existing book. Called from the book detail page.
   */
  async retagBook(bookId: number): Promise<RetagResult> {
    // Get processing settings for ffmpeg path
    const [processingSettings, taggingSettings] = await Promise.all([
      this.settingsService.get('processing'),
      this.settingsService.get('tagging'),
    ]);

    const ffmpegPath = processingSettings.ffmpegPath;
    if (!ffmpegPath?.trim()) {
      throw new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not configured. Set the ffmpeg path in Settings > Post Processing.');
    }

    // Get book with author and narrators via bookService (single source of truth)
    const book = await this.bookService!.getById(bookId);

    if (!book) {
      throw new RetagError('NOT_FOUND', `Book ${bookId} not found`);
    }

    if (!book.path) {
      throw new RetagError('NO_PATH', `Book ${bookId} has no library path — import it first`);
    }

    // Verify the path exists on disk
    try {
      await stat(book.path);
    } catch {
      throw new RetagError('PATH_MISSING', `Book path does not exist on disk: ${book.path}`);
    }

    const authorStr = book.authors.length > 0 ? book.authors.map(a => a.name).join(', ') : null;
    const narratorStr = book.narrators.length > 0 ? book.narrators.map(n => n.name).join(', ') : null;

    return this.tagBook(
      bookId,
      book.path,
      {
        title: book.title,
        authorName: authorStr,
        narrator: narratorStr,
        seriesName: book.seriesName,
        seriesPosition: book.seriesPosition,
        coverUrl: book.coverUrl,
      },
      ffmpegPath,
      taggingSettings.mode,
      taggingSettings.embedCover,
    );
  }
}

export class RetagError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'NO_PATH' | 'PATH_MISSING' | 'FFMPEG_NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'RetagError';
  }
}
