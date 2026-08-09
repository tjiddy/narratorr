import { execFile } from 'node:child_process';
import { readdir, rename, unlink, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { promisify } from 'node:util';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TagMode, RetagExcludableField } from '@shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import type { BookRefreshItem } from '../utils/enqueue-book-refresh.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { resolveFfmpegPath } from '@core/utils/audio-processor.js';
import { collectSortedAudioFiles } from '@core/utils/collect-audio-files.js';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
// Direct import keeps Node-only code out of the core/utils barrel consumed by Vite.
import { sanitizedEnv } from '@core/utils/sanitized-env.js';
import { COVER_FILE_REGEX } from '@core/utils/cover-regex.js';
import { getErrorMessage } from '../utils/error-message.js';
import {
  readExistingTags,
  resolveTags,
  fileHasCoverArt,
  buildCanonicalTags,
  buildTagsForFile,
  applyExcludeFields,
  planFile,
  pickCanonical,
  type RetagPlan,
  type RetagPlanFile,
} from './retag-plan.js';

export type {
  RetagPlan,
  RetagPlanFile,
  RetagPlanFileDiff,
  RetagPlanCanonical,
} from './retag-plan.js';

const execFileAsync = promisify(execFile);

const TAGGABLE_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b']);

export interface TagMetadata {
  artist?: string; // author
  albumArtist?: string; // author
  album?: string; // book title
  title?: string; // book or part title
  composer?: string; // narrator
  grouping?: string; // series name; ABS fallback
  track?: number;
  trackTotal?: number;
  // MP3 preserves these fields; M4B loses series/subtitle/ASIN/publisher, which OPF supplies to ABS.
  series?: string; seriesPart?: number; subtitle?: string; asin?: string;
  publisher?: string; description?: string; date?: string; genre?: string;
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
  /** Pre-write connector snapshot; null only without a usable library path. */
  refreshItem: BookRefreshItem | null;
}

/** String tag field → ffmpeg `-metadata` key. Numeric `seriesPart`/`track` are handled separately. */
export const STRING_METADATA_TAGS: ReadonlyArray<readonly [keyof TagMetadata, string]> = [
  ['artist', 'artist'], ['albumArtist', 'album_artist'], ['album', 'album'], ['title', 'title'],
  ['composer', 'composer'], ['grouping', 'grouping'], ['series', 'series'], ['subtitle', 'subtitle'],
  ['asin', 'asin'], ['publisher', 'publisher'], ['description', 'description'], ['date', 'date'], ['genre', 'genre'],
];

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

  // Always map one picture stream: supplied cover or optional source art; omitting the fallback strips existing covers.
  args.push('-map', '0:a');
  args.push('-map', coverPath ? '1' : '0:v?');
  args.push('-c:v', 'copy', '-disposition:v', 'attached_pic');

  args.push('-c:a', 'copy');

  // Explicit mapping prevents ffmpeg from dropping M4B chapters during re-tagging.
  args.push('-map_chapters', '0');

  // Numeric null checks preserve zero while omitting empty metadata assignments.
  for (const [field, key] of STRING_METADATA_TAGS) {
    const value = tags[field];
    if (value) args.push('-metadata', `${key}=${value}`);
  }
  if (tags.seriesPart != null) args.push('-metadata', `series-part=${tags.seriesPart}`);
  if (tags.track != null && tags.trackTotal != null) {
    args.push('-metadata', `track=${tags.track}/${tags.trackTotal}`);
  }

  args.push(outputPath);
  return args;
}

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

  const existing = mode === 'populate_missing' ? await readExistingTags(filePath) : {};
  const resolvedTags = resolveTags(tags, existing, mode);

  const shouldEmbedCover = coverPath && (mode === 'overwrite' || !await fileHasCoverArt(filePath));

  if (!resolvedTags && !shouldEmbedCover) {
    return { file: fileName, status: 'skipped', reason: 'All tags already populated' };
  }

  // Create the temp file hidden so scans cannot ingest it before the atomic rename.
  const tmpPath = dotPrefixBasename(join(dirname(filePath), `${basename(filePath, ext)}.tmp${ext}`));

  try {
    const ffmpegArgs = buildFfmpegArgs(
      filePath,
      tmpPath,
      resolvedTags ?? {},
      shouldEmbedCover ? coverPath : undefined,
    );

    await execFileAsync(ffmpegPath, ffmpegArgs, { env: sanitizedEnv() });

    const [originalStat, tmpStat] = await Promise.all([stat(filePath), stat(tmpPath)]);
    if (tmpStat.size < originalStat.size * 0.5) {
      await unlink(tmpPath).catch(() => {});
      return { file: fileName, status: 'failed', reason: 'Output file suspiciously small — possible corruption' };
    }

    // Atomically replace the original with the verified temp.
    await rename(tmpPath, filePath);

    return { file: fileName, status: 'tagged' };
  } catch (error: unknown) {
    await unlink(tmpPath).catch(() => {});
    const message = getErrorMessage(error);
    return { file: fileName, status: 'failed', reason: message };
  }
}

async function findCoverFile(dirPath: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dirPath);
    const coverFile = entries.find(f => COVER_FILE_REGEX.test(f));
    return coverFile ? join(dirPath, coverFile) : undefined;
  } catch {
    return undefined;
  }
}

async function collectAudioFiles(dirPath: string): Promise<string[]> {
  return collectSortedAudioFiles(dirPath, { extensions: TAGGABLE_EXTENSIONS });
}

async function warnUnsupportedFormats(
  dirPath: string,
  log: FastifyBaseLogger,
): Promise<{ skipped: number; warnings: string[]; entries: string[] }> {
  const entries = await readdir(dirPath);
  const warnings: string[] = [];
  const unsupported: string[] = [];
  for (const entry of entries) {
    const ext = extname(entry).toLowerCase();
    if (!isHiddenName(entry) && AUDIO_EXTENSIONS.has(ext) && !TAGGABLE_EXTENSIONS.has(ext)) {
      unsupported.push(entry);
      const reason = `Unsupported format: ${ext}`;
      log.warn({ file: entry, reason }, 'Tag write skipped');
      warnings.push(`${entry}: ${reason}`);
    }
  }
  return { skipped: unsupported.length, warnings, entries: unsupported };
}

function bookAuthorString(book: { authors: { name: string }[] }): string | null {
  return book.authors.length > 0 ? book.authors.map(a => a.name).join(', ') : null;
}

function bookNarratorString(book: { narrators: { name: string }[] }): string | null {
  return book.narrators.length > 0 ? book.narrators.map(n => n.name).join(', ') : null;
}

export class TaggingService {
  constructor(
    _db: Db,
    private settingsService: SettingsService,
    private log: FastifyBaseLogger,
    private bookService?: BookService,
  ) {}

  async tagBook(
    bookId: number,
    bookPath: string,
    metadata: {
      title: string;
      authorName?: string | null | undefined;
      narrator?: string | null | undefined;
      seriesName?: string | null | undefined;
      seriesPosition?: number | null | undefined;
      asin?: string | null | undefined; subtitle?: string | null | undefined;
      description?: string | null | undefined; publisher?: string | null | undefined;
      publishedDate?: string | null | undefined; genres?: string[] | null | undefined;
      coverUrl?: string | null | undefined;
    },
    ffmpegPath: string,
    mode: TagMode,
    embedCover: boolean,
    excludeFields: ReadonlySet<RetagExcludableField> = new Set(),
  ): Promise<RetagResult> {
    const refreshItem: BookRefreshItem | null = bookPath
      ? { bookId, title: metadata.title, authorName: metadata.authorName ?? null, libraryPath: bookPath }
      : null;
    const result: RetagResult = { bookId, tagged: 0, skipped: 0, failed: 0, warnings: [], refreshItem };

    const audioFiles = await collectAudioFiles(bookPath);

    const unsupported = await warnUnsupportedFormats(bookPath, this.log);
    result.skipped += unsupported.skipped;
    result.warnings.push(...unsupported.warnings);

    if (audioFiles.length === 0) {
      result.warnings.push('No taggable audio files found');
      return result;
    }

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
      // Multi-file overwrite preserves an existing chapter title before falling back to basename.
      const existingTags = !isSingleFile && mode === 'overwrite'
        ? await readExistingTags(filePath)
        : {};

      const fullTags = buildTagsForFile({
        canonicalTags,
        filePath,
        isSingleFile,
        index: i,
        total: audioFiles.length,
        mode,
        existingTags,
      });

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

  async retagBook(
    bookId: number,
    excludeFields: ReadonlySet<RetagExcludableField> = new Set(),
    overrides: { mode?: TagMode; embedCover?: boolean } = {},
  ): Promise<RetagResult> {
    const { book, ffmpegPath, taggingSettings } = await this.resolveRetagInputs(bookId);
    const mode = overrides.mode ?? taggingSettings.mode;
    const embedCover = overrides.embedCover ?? taggingSettings.embedCover;

    return this.tagBook(
      bookId,
      book.path!,
      {
        title: book.title,
        authorName: bookAuthorString(book),
        narrator: bookNarratorString(book),
        seriesName: book.seriesName, seriesPosition: book.seriesPosition,
        asin: book.asin, subtitle: book.subtitle, description: book.description,
        publisher: book.publisher, publishedDate: book.publishedDate, genres: book.genres,
        coverUrl: book.coverUrl,
      },
      ffmpegPath,
      mode,
      embedCover,
      excludeFields,
    );
  }

  /** Plan per-file outcomes without ffmpeg or mutation for the preview route. */
  async planRetag(
    bookId: number,
    overrides: { mode?: TagMode; embedCover?: boolean } = {},
  ): Promise<RetagPlan> {
    const { book, taggingSettings } = await this.resolveRetagInputs(bookId);
    const mode = overrides.mode ?? taggingSettings.mode;
    const embedCover = overrides.embedCover ?? taggingSettings.embedCover;
    const warnings: string[] = [];

    const canonicalTags = buildCanonicalTags({
      title: book.title,
      authorName: bookAuthorString(book),
      narrator: bookNarratorString(book),
      seriesName: book.seriesName, seriesPosition: book.seriesPosition,
      asin: book.asin, subtitle: book.subtitle, description: book.description,
      publisher: book.publisher, publishedDate: book.publishedDate, genres: book.genres,
    });

    const audioFiles = await collectAudioFiles(book.path!);
    const unsupported = await warnUnsupportedFormats(book.path!, this.log);
    warnings.push(...unsupported.warnings);

    // Probe regardless of the toggle so the modal can disable embedding when no cover exists.
    const coverPath = await findCoverFile(book.path!);
    if (embedCover && !coverPath) {
      warnings.push('Cover art embedding enabled but no cover image found in book directory');
    }
    const planCoverPath = embedCover ? coverPath : undefined;

    if (audioFiles.length === 0) {
      warnings.push('No taggable audio files found');
      return {
        mode,
        embedCover,
        hasCoverFile: !!coverPath,
        isSingleFile: false,
        canonical: pickCanonical(canonicalTags),
        // Unsupported-only folders still need per-file rows matching the apply path.
        files: unsupported.entries.map(entry => ({ file: entry, outcome: 'skip-unsupported' as const })),
        warnings,
      };
    }

    const isSingleFile = audioFiles.length === 1;
    const files = await this.buildPlanFiles({
      audioFiles,
      unsupported: unsupported.entries,
      isSingleFile,
      mode,
      canonicalTags,
      planCoverPath,
    });

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

  private async buildPlanFiles(args: {
    audioFiles: string[];
    unsupported: string[];
    isSingleFile: boolean;
    mode: TagMode;
    canonicalTags: TagMetadata;
    planCoverPath: string | undefined;
  }): Promise<RetagPlanFile[]> {
    const files: RetagPlanFile[] = [];
    const supportedFileNames = new Set(args.audioFiles.map(p => basename(p)));
    for (const entry of args.unsupported) {
      if (!supportedFileNames.has(entry)) {
        files.push({ file: entry, outcome: 'skip-unsupported' });
      }
    }

    for (let i = 0; i < args.audioFiles.length; i++) {
      const filePath = args.audioFiles[i]!;
      // Share tagBook's title decision and pass the same read into planFile to avoid a second probe.
      const existingTags = !args.isSingleFile && args.mode === 'overwrite'
        ? await readExistingTags(filePath)
        : undefined;

      const fullTags = buildTagsForFile({
        canonicalTags: args.canonicalTags,
        filePath,
        isSingleFile: args.isSingleFile,
        index: i,
        total: args.audioFiles.length,
        mode: args.mode,
        existingTags: existingTags ?? {},
      });

      files.push(await planFile(filePath, fullTags, args.mode, args.planCoverPath, existingTags));
    }
    return files;
  }

  private async resolveRetagInputs(bookId: number): Promise<{
    book: NonNullable<Awaited<ReturnType<NonNullable<TaggingService['bookService']>['getById']>>>;
    ffmpegPath: string;
    taggingSettings: { mode: TagMode; embedCover: boolean };
  }> {
    const [taggingSettings, ffmpegPath] = await Promise.all([
      this.settingsService.get('tagging'),
      resolveFfmpegPath(),
    ]);

    if (!ffmpegPath) {
      throw new RetagError('FFMPEG_NOT_CONFIGURED', 'ffmpeg is not available on this system.');
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
