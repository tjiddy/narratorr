import { parseFile } from 'music-metadata';
import { basename, extname } from 'node:path';
import type { TagMode, RetagExcludableField } from '../../shared/schemas.js';
import type { TagMetadata } from './tagging.service.js';

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

const SIMPLE_EXCLUDABLE_FIELDS = ['artist', 'albumArtist', 'album', 'title', 'composer', 'grouping'] as const;
const TAG_DIFF_FIELDS = SIMPLE_EXCLUDABLE_FIELDS;

/**
 * Read existing tags from a file to determine which fields are already populated.
 * Empty strings are dropped — matches the apply path's truthy filter so files
 * with `album: ""` look the same as files with no album tag at all.
 */
export async function readExistingTags(filePath: string): Promise<Partial<TagMetadata>> {
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
  return result;
}
