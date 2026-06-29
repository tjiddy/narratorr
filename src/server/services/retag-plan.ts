import { parseFile } from 'music-metadata';
import { basename, extname } from 'node:path';
import type { TagMode, RetagExcludableField } from '../../shared/schemas.js';
import type { TagMetadata } from './tagging.service.js';
import { extractYear } from '../utils/import-helpers.js';

export interface RetagPlanFileDiff {
  field: RetagExcludableField;
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
  album: string;
  title: string;
  artist?: string;
  albumArtist?: string;
  composer?: string;
  grouping?: string;
  // ABS-survivable set (#1671). `seriesPart` is stringified for display.
  series?: string;
  seriesPart?: string;
  subtitle?: string;
  asin?: string;
  publisher?: string;
  description?: string;
  date?: string;
  genre?: string;
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

// String-valued tag fields handled uniformly by the truthy populate_missing gate,
// the exclude filter, and the diff builder. `seriesPart` (numeric) and `track`
// (numeric pair) are NOT here — they need `!= null` handling so a 0 survives.
const SIMPLE_EXCLUDABLE_FIELDS = [
  'artist', 'albumArtist', 'album', 'title', 'composer', 'grouping',
  'series', 'subtitle', 'asin', 'publisher', 'description', 'date', 'genre',
] as const;
const TAG_DIFF_FIELDS = SIMPLE_EXCLUDABLE_FIELDS;

/**
 * Read existing tags from a file to determine which fields are already populated.
 * Empty strings are dropped — matches the apply path's truthy filter so files
 * with `album: ""` look the same as files with no album tag at all.
 */
export async function readExistingTags(filePath: string): Promise<Partial<TagMetadata>> {
  try {
    const metadata = await parseFile(filePath);
    return {
      ...readCommonCoreTags(metadata.common),
      ...readCommonAbsTags(metadata.common),
      ...readNativeSeriesTags(metadata.native as NativeTags),
    };
  } catch {
    return {};
  }
}

type CommonTags = Awaited<ReturnType<typeof parseFile>>['common'];
type NativeTags = Record<string, { id: string; value: unknown }[]> | undefined;

/** The original Plex/track field set, read from music-metadata `common`. */
function readCommonCoreTags(common: CommonTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  if (common.artist) result.artist = common.artist;
  if (common.albumartist) result.albumArtist = common.albumartist;
  if (common.album) result.album = common.album;
  if (common.title) result.title = common.title;
  if (common.composer?.[0]) result.composer = common.composer[0];
  if (common.grouping) result.grouping = common.grouping;
  if (common.track?.no != null) result.track = common.track.no;
  return result;
}

/**
 * ABS-survivable set read from `common` (#1671). `subtitle`/`publisher`/
 * `description`/`genre` are arrays in music-metadata; `asin`/`date`/`year` scalars.
 */
function readCommonAbsTags(common: CommonTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  if (common.subtitle?.[0]) result.subtitle = common.subtitle[0];
  if (common.publisher?.[0]) result.publisher = common.publisher[0];
  if (common.description?.[0]) result.description = common.description[0];
  if (common.genre?.[0]) result.genre = common.genre[0];
  if (common.asin) result.asin = common.asin;
  const date = common.date ?? (common.year != null ? String(common.year) : undefined);
  if (date) result.date = date;
  return result;
}

/**
 * `series` / `series-part` have no `common` mapping — read them from native frames
 * (TXXX:series, MP4 `----:…:series`, bare `series`) so populate_missing is field-aware.
 */
function readNativeSeriesTags(native: NativeTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  const series = readNativeFreeform(native, 'series');
  if (series) result.series = series;
  const seriesPart = readNativeFreeform(native, 'series-part');
  if (seriesPart) {
    // `nativeTagText` drops only the exact empty string and does not trim, so a
    // whitespace-only frame stays truthy (and `Number('   ')` is a finite `0`).
    // Trim, treat a blank result as absent, and assign only a finite parse — a
    // non-numeric embedded value (`"Book 2"`) must read as absent so
    // populate_missing still writes the canonical series part.
    const trimmed = seriesPart.trim();
    const parsed = Number(trimmed);
    if (trimmed && Number.isFinite(parsed)) result.seriesPart = parsed;
  }
  return result;
}

/**
 * Read a freeform native tag value by key (case-insensitive). Matches the bare id
 * (`series`), the ID3 `TXXX:series` shape, and the MP4 `----:com.apple.iTunes:series`
 * shape. TXXX values may arrive as `{ description, text }` objects — handle both.
 */
function readNativeFreeform(
  native: Record<string, { id: string; value: unknown }[]> | undefined,
  key: string,
): string | undefined {
  if (!native) return undefined;
  const keyLower = key.toLowerCase();
  for (const tags of Object.values(native)) {
    for (const tag of tags) {
      const idLower = tag.id.toLowerCase();
      if (idLower !== keyLower && !idLower.endsWith(`:${keyLower}`)) continue;
      const value = nativeTagText(tag.value);
      if (value) return value;
    }
  }
  return undefined;
}

function nativeTagText(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number') return String(value);
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === 'string' ? text || undefined : undefined;
  }
  return undefined;
}

/**
 * Determine which tags to write based on mode.
 * In 'populate_missing' mode, only write tags that are currently empty.
 * In 'overwrite' mode, write all tags. Both modes return `null` when there
 * are no tags to write — callers then decide whether to short-circuit or
 * proceed (e.g. for cover-only embeds).
 */
export function resolveTags(
  desired: TagMetadata,
  existing: Partial<TagMetadata>,
  mode: TagMode,
): TagMetadata | null {
  if (mode === 'overwrite') {
    return hasAnyField(desired) ? desired : null;
  }

  const resolved: TagMetadata = {};
  let hasAnyTag = false;

  for (const key of SIMPLE_EXCLUDABLE_FIELDS) {
    if (desired[key] && !existing[key]) {
      resolved[key] = desired[key];
      hasAnyTag = true;
    }
  }

  // `seriesPart` is numeric — `!= null` so a desired 0 populates an absent value.
  if (desired.seriesPart != null && existing.seriesPart == null) {
    resolved.seriesPart = desired.seriesPart;
    hasAnyTag = true;
  }

  if (desired.track != null && existing.track == null) {
    resolved.track = desired.track;
    if (desired.trackTotal != null) resolved.trackTotal = desired.trackTotal;
    hasAnyTag = true;
  }

  return hasAnyTag ? resolved : null;
}

function hasAnyField(tags: TagMetadata): boolean {
  if (SIMPLE_EXCLUDABLE_FIELDS.some(field => tags[field])) return true;
  if (tags.seriesPart != null) return true;
  return tags.track != null && tags.trackTotal != null;
}

export async function fileHasCoverArt(filePath: string): Promise<boolean> {
  try {
    const metadata = await parseFile(filePath);
    return (metadata.common.picture?.length ?? 0) > 0;
  } catch {
    return false;
  }
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
    seriesPosition?: number | null | undefined;
    asin?: string | null | undefined;
    subtitle?: string | null | undefined;
    description?: string | null | undefined;
    publisher?: string | null | undefined;
    publishedDate?: string | null | undefined;
    genres?: string[] | null | undefined;
  },
): TagMetadata {
  const year = extractYear(metadata.publishedDate);
  const firstGenre = metadata.genres?.[0];
  return {
    album: metadata.title,
    title: metadata.title,
    ...(metadata.authorName && { artist: metadata.authorName, albumArtist: metadata.authorName }),
    ...(metadata.narrator && { composer: metadata.narrator }),
    // `grouping` (survives M4B) and `series` (survives MP3) both carry the series name.
    ...(metadata.seriesName && { grouping: metadata.seriesName, series: metadata.seriesName }),
    // `!= null` so series position 0 is preserved (vs. a truthy check dropping it).
    ...(metadata.seriesPosition != null && { seriesPart: metadata.seriesPosition }),
    ...(metadata.subtitle && { subtitle: metadata.subtitle }),
    ...(metadata.asin && { asin: metadata.asin }),
    ...(metadata.publisher && { publisher: metadata.publisher }),
    ...(metadata.description && { description: metadata.description }),
    ...(year && { date: year }),
    ...(firstGenre && { genre: firstGenre }),
  };
}

/**
 * For multi-file books, derive the per-file `title` so the apply path doesn't
 * clobber legitimate chapter titles with the book title (#1090).
 *
 * - `overwrite`: preserve the file's existing title when present; otherwise
 *   fall back to the file basename (extension stripped). Returns undefined
 *   when neither is available so the caller can leave title unset.
 * - `populate_missing`: return basename-derived title. `resolveTags`'s
 *   `!existing[key]` guard keeps existing titles intact; the basename value
 *   is only written for files that have no existing title tag.
 *
 * Single-file books should NOT use this helper — they keep `title = book.title`.
 */
export function derivePerFileTitle(
  filePath: string,
  mode: TagMode,
  existingTags: Partial<TagMetadata>,
): string | undefined {
  if (mode === 'overwrite' && existingTags.title) return existingTags.title;
  const ext = extname(filePath);
  const base = basename(filePath, ext);
  return base || undefined;
}

/**
 * Build the per-file desired-tag set from canonical (book-wide) tags + file
 * context. Shared between the apply path (`tagBook` per-file loop) and the
 * preview path (`planRetag` per-file loop) so the two never diverge on the
 * per-file `title` rule.
 *
 * - Single-file books: passes canonical tags through unchanged
 *   (`title = book.title`, no track).
 * - Multi-file books: assigns sequential track numbers and replaces `title`
 *   with the per-file value from `derivePerFileTitle`.
 */
export function buildTagsForFile(args: {
  canonicalTags: TagMetadata;
  filePath: string;
  isSingleFile: boolean;
  index: number;
  total: number;
  mode: TagMode;
  existingTags: Partial<TagMetadata>;
}): TagMetadata {
  if (args.isSingleFile) return { ...args.canonicalTags };

  const result: TagMetadata = {
    ...args.canonicalTags,
    track: args.index + 1,
    trackTotal: args.total,
  };

  const perFileTitle = derivePerFileTitle(args.filePath, args.mode, args.existingTags);
  if (perFileTitle !== undefined) {
    result.title = perFileTitle;
  } else {
    delete result.title;
  }
  return result;
}

/**
 * Strip the user-excluded fields from a desired-tag set. The user-facing
 * `track` checkbox covers both `track` and `trackTotal` — exclude expands.
 */
export function applyExcludeFields(tags: TagMetadata, excludeFields: ReadonlySet<RetagExcludableField>): TagMetadata {
  const result: TagMetadata = {};
  for (const field of SIMPLE_EXCLUDABLE_FIELDS) {
    const value = tags[field];
    if (value !== undefined && !excludeFields.has(field)) result[field] = value;
  }
  if (!excludeFields.has('seriesPart') && tags.seriesPart !== undefined) {
    result.seriesPart = tags.seriesPart;
  }
  if (!excludeFields.has('track')) {
    if (tags.track !== undefined) result.track = tags.track;
    if (tags.trackTotal !== undefined) result.trackTotal = tags.trackTotal;
  }
  return result;
}

/**
 * Compute the per-file outcome a planRetag run would produce — same logic as
 * `tagFile` but without invoking ffmpeg or touching disk.
 */
export async function planFile(
  filePath: string,
  desired: TagMetadata,
  mode: TagMode,
  coverPath: string | undefined,
  existingTags?: Partial<TagMetadata>,
): Promise<RetagPlanFile> {
  const fileName = basename(filePath);
  const existing = existingTags ?? await readExistingTags(filePath);
  const resolvedTags = resolveTags(desired, existing, mode);

  const fileHasCover = coverPath !== undefined ? await fileHasCoverArt(filePath) : false;
  const coverPending = coverPath !== undefined && (mode === 'overwrite' || !fileHasCover);

  if (!resolvedTags && !coverPending) {
    return { file: fileName, outcome: 'skip-populated' };
  }

  const diff = resolvedTags ? buildTagDiff(resolvedTags, existing) : [];
  return { file: fileName, outcome: 'will-tag', diff, coverPending };
}

/** Build the current→next diff rows for a will-tag file (string fields + numeric series-part/track). */
function buildTagDiff(resolved: TagMetadata, existing: Partial<TagMetadata>): RetagPlanFileDiff[] {
  const diff: RetagPlanFileDiff[] = [];
  for (const field of TAG_DIFF_FIELDS) {
    const next = resolved[field];
    if (next === undefined) continue;
    diff.push({ field, current: stringify(existing[field] ?? null), next: stringify(next) });
  }
  if (resolved.seriesPart != null) {
    const currentPart = existing.seriesPart != null ? `${existing.seriesPart}` : null;
    diff.push({ field: 'seriesPart', current: currentPart, next: `${resolved.seriesPart}` });
  }
  if (resolved.track != null && resolved.trackTotal != null) {
    const currentTrack = existing.track != null ? `${existing.track}` : null;
    diff.push({ field: 'track', current: currentTrack, next: `${resolved.track}/${resolved.trackTotal}` });
  }
  return diff;
}

function stringify(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : `${value}`;
}

export function pickCanonical(tags: TagMetadata): RetagPlanCanonical {
  // album + title are populated unconditionally by buildCanonicalTags from book.title
  // (NOT NULL in DB), so RetagPlanCanonical can require both.
  const result: RetagPlanCanonical = {
    album: tags.album ?? '',
    title: tags.title ?? '',
  };
  if (tags.artist) result.artist = tags.artist;
  if (tags.albumArtist) result.albumArtist = tags.albumArtist;
  if (tags.composer) result.composer = tags.composer;
  if (tags.grouping) result.grouping = tags.grouping;
  if (tags.series) result.series = tags.series;
  if (tags.seriesPart != null) result.seriesPart = `${tags.seriesPart}`;
  if (tags.subtitle) result.subtitle = tags.subtitle;
  if (tags.asin) result.asin = tags.asin;
  if (tags.publisher) result.publisher = tags.publisher;
  if (tags.description) result.description = tags.description;
  if (tags.date) result.date = tags.date;
  if (tags.genre) result.genre = tags.genre;
  return result;
}
