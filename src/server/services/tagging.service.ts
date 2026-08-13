import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { TagMode, RetagExcludableField } from '@shared/schemas.js';
import type { SettingsService } from './settings.service.js';
import type { BookService } from './book.service.js';
import type { BookRefreshItem } from '../utils/enqueue-book-refresh.js';
import { AUDIO_EXTENSIONS, isHiddenName } from '@core/utils/audio-constants.js';
import { resolveMutagenPython } from '@core/utils/mutagen-resolver.js';
import { collectSortedAudioFiles } from '@core/utils/collect-audio-files.js';
import { COVER_FILE_REGEX } from '@core/utils/cover-regex.js';
import {
  buildMutagenRequest,
  coverMimeForPath,
  mutagenFormatForExtension,
  TAGGABLE_EXTENSIONS,
} from './mutagen-tag-payload.js';
import { writeTagsWithMutagen } from './mutagen-tag-writer.js';
import { withPathWriteLock } from '../utils/path-write-lock.js';
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

export interface TagMetadata {
  artist?: string; // author
  albumArtist?: string; // author
  album?: string; // book title
  title?: string; // book or part title
  composer?: string; // narrator
  grouping?: string; // series name; ABS fallback
  track?: number;
  trackTotal?: number;
  series?: string; seriesPart?: number; subtitle?: string; asin?: string;
  publisher?: string; description?: string; date?: string; genre?: string;
}

export interface TagFileResult {
  file: string;
  status: 'tagged' | 'skipped' | 'failed';
  reason?: string;
  /** Non-fatal notes from a write that still succeeded, e.g. an unembeddable cover format. */
  warnings?: string[];
  /** Observational only — never a success predicate in either direction (#2210 D2). */
  sizeBefore?: number;
  sizeAfter?: number;
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

/**
 * The ffmpeg tag writer this replaces needed `-map_chapters 0` because remuxing dropped M4B
 * chapters. mutagen patches the metadata header and never touches the chapter track, so there is
 * nothing to re-map — the workaround became unnecessary rather than merely unused (#2210 AC15).
 *
 * The same remux is why `series`, `subtitle`, `asin` and `publisher` used to vanish on M4B: the mov
 * muxer silently discards every `-metadata` key it has no atom mapping for. The per-format atom and
 * frame tables now live in `mutagen-tag-payload.ts`.
 */
export async function tagFile(
  filePath: string,
  mutagenPython: string,
  tags: TagMetadata,
  mode: TagMode,
  coverPath?: string,
): Promise<TagFileResult> {
  const ext = extname(filePath).toLowerCase();
  const fileName = basename(filePath);

  const format = mutagenFormatForExtension(ext);
  if (!format) {
    return { file: fileName, status: 'skipped', reason: `Unsupported format: ${ext}` };
  }

  const existing = mode === 'populate_missing' ? await readExistingTags(filePath) : {};
  const resolvedTags = resolveTags(tags, existing, mode);

  const shouldEmbedCover = coverPath && (mode === 'overwrite' || !await fileHasCoverArt(filePath));

  if (!resolvedTags && !shouldEmbedCover) {
    return { file: fileName, status: 'skipped', reason: 'All tags already populated' };
  }

  const { request, warnings } = buildMutagenRequest({
    filePath,
    format,
    tags: resolvedTags ?? {},
    coverPath: shouldEmbedCover ? coverPath : undefined,
  });

  // The write is in place — no second file is ever created, so #1852 AC9's hazard (a library scan
  // ingesting the born-hidden temp file before the atomic rename) cannot occur and the temp+rename
  // it guarded is gone. The lock covers the save *and* the helper's read-back verification.
  const result = await withPathWriteLock(filePath, () => writeTagsWithMutagen(mutagenPython, request));

  const sizes = {
    ...(result.sizeBefore !== undefined && { sizeBefore: result.sizeBefore }),
    ...(result.sizeAfter !== undefined && { sizeAfter: result.sizeAfter }),
  };
  if (!result.ok) {
    return { file: fileName, status: 'failed', ...(result.reason && { reason: result.reason }), ...sizes };
  }
  return { file: fileName, status: 'tagged', ...(warnings.length > 0 && { warnings }), ...sizes };
}

/**
 * Ordering only — never a capability test. Embeddability comes from `coverMimeForPath`, so an
 * extension the MIME table knows but this list omits still outranks an unembeddable one.
 */
const PREFERRED_COVER_EXTENSIONS: readonly string[] = ['.jpg', '.jpeg', '.png'];

/** Ranks a candidate on capability first, then declared preference, ascending: lower wins. */
function coverRank(name: string): [number, number] {
  const preference = PREFERRED_COVER_EXTENSIONS.indexOf(extname(name).toLowerCase());
  return [
    coverMimeForPath(name) === undefined ? 1 : 0,
    preference === -1 ? PREFERRED_COVER_EXTENSIONS.length : preference,
  ];
}

function compareCoverCandidates(a: string, b: string): number {
  const [tierA, preferenceA] = coverRank(a);
  const [tierB, preferenceB] = coverRank(b);
  // Code-unit comparison last, never localeCompare: ICU collation varies by runtime and locale,
  // which would put environment-dependent selection back where readdir order used to be.
  return tierA - tierB || preferenceA - preferenceB || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Picks the cover a book folder should embed. readdir order is undefined and a folder imported from
 * outside Narratorr can hold several covers, so first-match let a `cover.webp` shadow an embeddable
 * `cover.jpg` and the operator saw only an unsupported-format warning (#2214). The three keys —
 * capability, preference, raw filename — make the pick a total function of the entry set.
 *
 * A webp with no embeddable sibling is still returned: warn-and-write-the-rest is the intended
 * outcome there (#2210 D4), and filtering it out would report the cover as missing instead.
 */
export function pickCoverFile(entries: string[]): string | undefined {
  // Filenames are unique within a directory, so the third key never ties and the sorted order —
  // hence the pick — is a function of the entry set alone, not of the order readdir returned it in.
  return entries.filter(entry => COVER_FILE_REGEX.test(entry)).sort(compareCoverCandidates)[0];
}

async function findCoverFile(dirPath: string): Promise<string | undefined> {
  try {
    const entries = await readdir(dirPath);
    const coverFile = pickCoverFile(entries);
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
    mutagenPython: string,
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

      const fileResult = await tagFile(filePath, mutagenPython, tags, mode, coverPath);
      result[fileResult.status]++;

      for (const warning of fileResult.warnings ?? []) {
        this.log.warn({ file: fileResult.file, reason: warning }, 'Tag write warning');
        result.warnings.push(`${fileResult.file}: ${warning}`);
      }

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
    const { book, mutagenPython, taggingSettings } = await this.resolveRetagInputs(bookId);
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
      mutagenPython,
      mode,
      embedCover,
      excludeFields,
    );
  }

  /** Plan per-file outcomes without spawning the tag writer or mutating for the preview route. */
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
    mutagenPython: string;
    taggingSettings: { mode: TagMode; embedCover: boolean };
  }> {
    const [taggingSettings, mutagenPython] = await Promise.all([
      this.settingsService.get('tagging'),
      resolveMutagenPython(),
    ]);

    if (!mutagenPython) {
      throw new RetagError(
        'MUTAGEN_NOT_CONFIGURED',
        'Python with the mutagen module is not available on this system.',
      );
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

    return { book, mutagenPython, taggingSettings };
  }
}

export class RetagError extends Error {
  // FFMPEG_NOT_CONFIGURED is gone rather than merely unused: the retag path no longer touches
  // ffmpeg, so nothing could raise it. `MUTAGEN_NOT_CONFIGURED` inherits its 503 mapping.
  constructor(
    public code: 'NOT_FOUND' | 'NO_PATH' | 'PATH_MISSING' | 'MUTAGEN_NOT_CONFIGURED',
    message: string,
  ) {
    super(message);
    this.name = 'RetagError';
  }
}
