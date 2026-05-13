import { execFile } from 'node:child_process';
import { readdir, rename, unlink, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TagMode, RetagExcludableField } from '../../shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import { AUDIO_EXTENSIONS } from '../../core/utils/audio-constants.js';
import { collectSortedAudioFiles } from '../../core/utils/collect-audio-files.js';
import { COVER_FILE_REGEX } from '../../core/utils/cover-regex.js';
import { getErrorMessage } from '../utils/error-message.js';

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

export interface RetagPlanFileDiff {
  field: string;
  current: string | null;
  next: string | null;
}

export interface RetagPlanFile {
  file: string;
  outcome: 'will-tag' | 'skip-populated' | 'skip-unsupported';
  diff?: RetagPlanFileDiff[];
  /** True when cover-embed would run for this file; surfaces cover-only writes to the client. */
  coverPending?: boolean;
}

export interface RetagPlanCanonical {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  composer?: string;
  grouping?: string;
}

export interface RetagPlan {
  mode: TagMode;
  embedCover: boolean;
  hasCoverFile: boolean;
  isSingleFile: boolean;
  canonical: RetagPlanCanonical;
  files: RetagPlanFile[];
  warnings: string[];
}

/**
 * Read existing tags from a file to determine which fields are already populated.
 */
async function readExistingTags(filePath: string): Promise<Partial<TagMetadata>> {
  try {
    const metadata = await parseFile(filePath);
    const common = metadata.common;
    const result: Partial<TagMetadata> = {};
    if (common.artist) result.artist = common.artist;
    if (common.albumartist) result.albumArtist = common.albumartist;
    if (common.album) result.album = common.album;
    if (common.title) result.title = common.title;
    if (common.composer?.[0]) result.composer = common.composer[0];
    if (common.grouping) result.grouping = common.grouping;
    if (common.track?.no != null) result.track = common.track.no;
    return result;
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
 * In 'overwrite' mode, write all tags. Both modes return `null` when there
 * are no tags to write — callers then decide whether to short-circuit or
 * proceed (e.g. for cover-only embeds).
 */
function resolveTags(
  desired: TagMetadata,
  existing: Partial<TagMetadata>,
  mode: TagMode,
): TagMetadata | null {
  if (mode === 'overwrite') {
    return hasAnyField(desired) ? desired : null;
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
    if (desired.trackTotal != null) resolved.trackTotal = desired.trackTotal;
    hasAnyTag = true;
  }

  return hasAnyTag ? resolved : null;
}

function hasAnyField(tags: TagMetadata): boolean {
  return !!(tags.artist || tags.albumArtist || tags.album || tags.title || tags.composer || tags.grouping
    || (tags.track != null && tags.trackTotal != null));
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
    const message = getErrorMessage(error);
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
    const coverFile = entries.find(f => COVER_FILE_REGEX.test(f));
    return coverFile ? join(dirPath, coverFile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collect audio files in a directory and sort them with locale-aware numeric ordering.
 */
async function collectAudioFiles(dirPath: string): Promise<string[]> {
  return collectSortedAudioFiles(dirPath, { extensions: TAGGABLE_EXTENSIONS });
}

/**
 * Scan a directory for audio files with unsupported formats and return warning entries.
 */
async function warnUnsupportedFormats(
  dirPath: string,
  log: FastifyBaseLogger,
): Promise<{ skipped: number; warnings: string[]; entries: string[] }> {
  const entries = await readdir(dirPath);
  const warnings: string[] = [];
  const unsupported: string[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (AUDIO_EXTENSIONS.has(ext) && !TAGGABLE_EXTENSIONS.has(ext)) {
      unsupported.push(entry);
      const reason = `Unsupported format: ${ext}`;
      log.warn({ file: entry, reason }, 'Tag write skipped');
      warnings.push(`${entry}: ${reason}`);
    }
  }
  return { skipped: unsupported.length, warnings, entries: unsupported };
}

/**
 * Compute the per-file outcome a planRetag run would produce — same logic as
 * `tagFile` but without invoking ffmpeg or touching disk.
 */
async function planFile(
  filePath: string,
  desired: TagMetadata,
  mode: TagMode,
  coverPath: string | undefined,
): Promise<RetagPlanFile> {
  const fileName = basename(filePath);
  const existing = await readExistingTags(filePath);
  const resolvedTags = resolveTags(desired, existing, mode);

  const fileHasCover = coverPath !== undefined ? await fileHasCoverArt(filePath) : false;
  const coverPending = coverPath !== undefined && (mode === 'overwrite' || !fileHasCover);

  if (!resolvedTags && !coverPending) {
    return { file: fileName, outcome: 'skip-populated' };
  }

  const diff: RetagPlanFileDiff[] = [];
  if (resolvedTags) {
    for (const field of TAG_DIFF_FIELDS) {
      const next = resolvedTags[field];
      if (next === undefined) continue;
      const current = existing[field] ?? null;
      diff.push({ field, current: stringify(current), next: stringify(next) });
    }
    if (resolvedTags.track != null && resolvedTags.trackTotal != null) {
      const currentTrack = existing.track != null ? `${existing.track}` : null;
      diff.push({ field: 'track', current: currentTrack, next: `${resolvedTags.track}/${resolvedTags.trackTotal}` });
    }
  }

  return { file: fileName, outcome: 'will-tag', diff, coverPending };
}

const TAG_DIFF_FIELDS = ['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping'] as const;

function stringify(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : `${value}`;
}

function pickCanonical(tags: TagMetadata): RetagPlanCanonical {
  const result: RetagPlanCanonical = {};
  if (tags.artist) result.artist = tags.artist;
  if (tags.albumArtist) result.albumArtist = tags.albumArtist;
  if (tags.album) result.album = tags.album;
  if (tags.title) result.title = tags.title;
  if (tags.composer) result.composer = tags.composer;
  if (tags.grouping) result.grouping = tags.grouping;
  return result;
}

/**
 * Build the canonical desired-tag set for a book. The same shape is used in
 * the apply path (per-file loop) and the preview's canonical card.
 */
export function buildCanonicalTags(
  metadata: {
    title: string;
    authorName?: string | null | undefined;
    narrator?: string | null | undefined;
    seriesName?: string | null | undefined;
  },
): TagMetadata {
  return {
    album: metadata.title,
    title: metadata.title,
    ...(metadata.authorName && { artist: metadata.authorName, albumArtist: metadata.authorName }),
    ...(metadata.narrator && { composer: metadata.narrator }),
    ...(metadata.seriesName && { grouping: metadata.seriesName }),
  };
}

/**
 * Strip the user-excluded fields from a desired-tag set. The user-facing
 * `track` checkbox covers both `track` and `trackTotal` — exclude expands.
 */
export function applyExcludeFields(tags: TagMetadata, excludeFields: ReadonlySet<RetagExcludableField>): TagMetadata {
  const result: TagMetadata = {};
  if (!excludeFields.has('artist') && tags.artist !== undefined) result.artist = tags.artist;
  if (!excludeFields.has('albumArtist') && tags.albumArtist !== undefined) result.albumArtist = tags.albumArtist;
  if (!excludeFields.has('album') && tags.album !== undefined) result.album = tags.album;
  if (!excludeFields.has('title') && tags.title !== undefined) result.title = tags.title;
  if (!excludeFields.has('composer') && tags.composer !== undefined) result.composer = tags.composer;
  if (!excludeFields.has('grouping') && tags.grouping !== undefined) result.grouping = tags.grouping;
  if (!excludeFields.has('track')) {
    if (tags.track !== undefined) result.track = tags.track;
    if (tags.trackTotal !== undefined) result.trackTotal = tags.trackTotal;
  }
  return result;
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
      authorName?: string | null | undefined;
      narrator?: string | null | undefined;
      seriesName?: string | null | undefined;
      seriesPosition?: number | null | undefined;
      coverUrl?: string | null | undefined;
    },
    ffmpegPath: string,
    mode: TagMode,
    embedCover: boolean,
    excludeFields: ReadonlySet<RetagExcludableField> = new Set(),
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
    const canonicalTags = buildCanonicalTags(metadata);

    for (let i = 0; i < audioFiles.length; i++) {
      const filePath = audioFiles[i]!;
      const fullTags: TagMetadata = { ...canonicalTags };

      // Track numbers only for multi-file books
      if (!isSingleFile) {
        fullTags.track = i + 1;
        fullTags.trackTotal = audioFiles.length;
      }

      const tags = applyExcludeFields(fullTags, excludeFields);

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
   * Optional `excludeFields` lets the caller opt out of specific tag fields
   * per the preview-modal flow; defaults to empty (write everything).
   */
  async retagBook(
    bookId: number,
    excludeFields: ReadonlySet<RetagExcludableField> = new Set(),
  ): Promise<RetagResult> {
    const { book, ffmpegPath, taggingSettings } = await this.resolveRetagInputs(bookId);

    const authorStr = book.authors.length > 0 ? book.authors.map(a => a.name).join(', ') : null;
    const narratorStr = book.narrators.length > 0 ? book.narrators.map(n => n.name).join(', ') : null;

    return await this.tagBook(
      bookId,
      book.path!,
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
      excludeFields,
    );
  }

  /**
   * Pure planner — returns the per-file outcomes the apply path would
   * produce, without invoking ffmpeg or touching disk/DB. Used by
   * `GET /api/books/:id/retag/preview` so the user can review and opt out
   * of specific tag fields before committing.
   */
  async planRetag(bookId: number): Promise<RetagPlan> {
    const { book, taggingSettings } = await this.resolveRetagInputs(bookId);
    const mode = taggingSettings.mode;
    const embedCover = taggingSettings.embedCover;
    const warnings: string[] = [];

    const authorStr = book.authors.length > 0 ? book.authors.map(a => a.name).join(', ') : null;
    const narratorStr = book.narrators.length > 0 ? book.narrators.map(n => n.name).join(', ') : null;

    const canonicalTags = buildCanonicalTags({
      title: book.title,
      authorName: authorStr,
      narrator: narratorStr,
      seriesName: book.seriesName,
    });

    const audioFiles = await collectAudioFiles(book.path!);
    const unsupported = await warnUnsupportedFormats(book.path!, this.log);
    warnings.push(...unsupported.warnings);

    let coverPath: string | undefined;
    if (embedCover) {
      coverPath = await findCoverFile(book.path!);
      if (!coverPath) {
        warnings.push('Cover art embedding enabled but no cover image found in book directory');
      }
    }

    if (audioFiles.length === 0) {
      warnings.push('No taggable audio files found');
      return {
        mode,
        embedCover,
        hasCoverFile: !!coverPath,
        isSingleFile: false,
        canonical: pickCanonical(canonicalTags),
        files: [],
        warnings,
      };
    }

    const isSingleFile = audioFiles.length === 1;
    const files: RetagPlanFile[] = [];

    // Unsupported files reported by warnUnsupportedFormats — surface in the per-file table
    // alongside the taggable ones so the UI can show the full folder picture.
    const supportedFileNames = new Set(audioFiles.map(p => basename(p)));
    for (const entry of unsupported.entries) {
      if (!supportedFileNames.has(entry)) {
        files.push({ file: entry, outcome: 'skip-unsupported' });
      }
    }

    for (let i = 0; i < audioFiles.length; i++) {
      const filePath = audioFiles[i]!;
      const fullTags: TagMetadata = { ...canonicalTags };
      if (!isSingleFile) {
        fullTags.track = i + 1;
        fullTags.trackTotal = audioFiles.length;
      }
      const file = await planFile(filePath, fullTags, mode, coverPath);
      files.push(file);
    }

    return {
      mode,
      embedCover,
      hasCoverFile: !!coverPath,
      isSingleFile,
      canonical: pickCanonical(canonicalTags),
      files,
      warnings,
    };
  }

  /** Shared validation for both `retagBook` and `planRetag`. */
  private async resolveRetagInputs(bookId: number): Promise<{
    book: NonNullable<Awaited<ReturnType<NonNullable<TaggingService['bookService']>['getById']>>>;
    ffmpegPath: string;
    taggingSettings: { mode: TagMode; embedCover: boolean };
  }> {
    const [processingSettings, taggingSettings] = await Promise.all([
      this.settingsService.get('processing'),
      this.settingsService.get('tagging'),
    ]);

    const ffmpegPath = processingSettings.ffmpegPath;
    if (!ffmpegPath?.trim()) {
      throw new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not configured. Set the ffmpeg path in Settings > Post Processing.');
    }

    const book = await this.bookService!.getById(bookId);
    if (!book) {
      throw new RetagError('NOT_FOUND', `Book ${bookId} not found`);
    }
    if (!book.path) {
      throw new RetagError('NO_PATH', `Book ${bookId} has no library path — import it first`);
    }
    try {
      await stat(book.path);
    } catch {
      throw new RetagError('PATH_MISSING', `Book path does not exist on disk: ${book.path}`);
    }

    return { book, ffmpegPath, taggingSettings };
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
