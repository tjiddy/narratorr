import { parseFile } from 'music-metadata';
import { basename, extname } from 'node:path';
import type { TagMode, RetagExcludableField } from '@shared/schemas.js';
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
  /** Includes cover-only writes. */
  coverPending?: boolean;
}

export interface RetagPlanCanonical {
  album: string;
  title: string;
  artist?: string;
  albumArtist?: string;
  composer?: string;
  grouping?: string;
  // ABS-survivable fields; seriesPart is stringified for preview.
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

// Numeric fields stay separate because their null checks must preserve zero.
export const SIMPLE_EXCLUDABLE_FIELDS = [
  'artist', 'albumArtist', 'album', 'title', 'composer', 'grouping',
  'series', 'subtitle', 'asin', 'publisher', 'description', 'date', 'genre',
] as const;
const TAG_DIFF_FIELDS = SIMPLE_EXCLUDABLE_FIELDS;

// Drop empty strings to match the apply path's truthy populate-missing check.
export async function readExistingTags(filePath: string): Promise<Partial<TagMetadata>> {
  try {
    const metadata = await parseFile(filePath);
    return {
      ...readCommonCoreTags(metadata.common),
      ...readCommonAbsTags(metadata.common),
      ...readNativeSeriesTags(metadata.native as NativeTags),
      ...readNativePublisher(metadata.native as NativeTags),
    };
  } catch {
    return {};
  }
}

type CommonTags = Awaited<ReturnType<typeof parseFile>>['common'];
type NativeTags = Record<string, { id: string; value: unknown }[]> | undefined;

function readCommonCoreTags(common: CommonTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  if (common.artist) result.artist = common.artist;
  if (common.albumartist) result.albumArtist = common.albumartist;
  if (common.album) result.album = common.album;
  if (common.title) result.title = common.title;
  if (common.composer?.[0]) result.composer = common.composer[0];
  if (common.grouping) result.grouping = common.grouping;
  if (common.track?.no != null) result.track = common.track.no;
  if (common.track?.of != null) result.trackTotal = common.track.of;
  return result;
}

function readCommonAbsTags(common: CommonTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  if (common.subtitle?.[0]) result.subtitle = common.subtitle[0];
  // publisher is deliberately absent here: music-metadata maps neither MP4's
  // `----:com.apple.iTunes:PUBLISHER` nor ID3's `TPUB` to common.publisher (TPUB becomes
  // common.label), so reading it from `common` was a silent no-op that made populate_missing
  // rewrite publisher on every pass. readNativePublisher reads the real frames instead.
  if (common.description?.[0]) result.description = common.description[0];
  if (common.genre?.[0]) result.genre = common.genre[0];
  if (common.asin) result.asin = common.asin;
  const date = common.date ?? (common.year != null ? String(common.year) : undefined);
  if (date) result.date = date;
  return result;
}

// The movement atoms are the portability channel and carry a position music-metadata truncates to
// an integer, so the lossless freeform is tried first and these only answer for foreign files.
const SERIES_NATIVE_IDS = ['mvnm', '©mvn'] as const;
const SERIES_PART_NATIVE_IDS = ['mvin', '©mvi'] as const;
const PUBLISHER_NATIVE_IDS = ['tpub'] as const;

function readNativePublisher(native: NativeTags): Partial<TagMetadata> {
  const publisher = readNativeFreeform(native, 'publisher', PUBLISHER_NATIVE_IDS);
  return publisher ? { publisher } : {};
}

// series fields have no common mapping, so inspect ID3, MP4, and bare native frames.
function readNativeSeriesTags(native: NativeTags): Partial<TagMetadata> {
  const result: Partial<TagMetadata> = {};
  const series = readNativeFreeform(native, 'series', SERIES_NATIVE_IDS);
  if (series) result.series = series;
  const seriesPart = readNativeFreeform(native, 'series-part', SERIES_PART_NATIVE_IDS);
  if (seriesPart) {
    // Number('   ') is zero; reject blank and non-numeric frames so canonical data can populate.
    const trimmed = seriesPart.trim();
    const parsed = Number(trimmed);
    if (trimmed && Number.isFinite(parsed)) result.seriesPart = parsed;
  }
  return result;
}

/**
 * Match bare, ID3 TXXX, and MP4 freeform ids; TXXX values may wrap text in an object. The
 * derived-name match is what keeps a 747-book library written by the pre-mutagen ffmpeg path
 * (`series`, `TXXX:series`, `----:com.apple.iTunes:series`) readable, so it is tried before the
 * explicit `fallbackIds` — those must already be lowercase.
 */
function readNativeFreeform(
  native: Record<string, { id: string; value: unknown }[]> | undefined,
  key: string,
  fallbackIds: readonly string[] = [],
): string | undefined {
  if (!native) return undefined;
  const keyLower = key.toLowerCase();
  const derived = findNativeTag(native, id => id === keyLower || id.endsWith(`:${keyLower}`));
  if (derived) return derived;
  for (const fallback of fallbackIds) {
    const found = findNativeTag(native, id => id === fallback);
    if (found) return found;
  }
  return undefined;
}

function findNativeTag(
  native: Record<string, { id: string; value: unknown }[]>,
  matches: (idLower: string) => boolean,
): string | undefined {
  for (const tags of Object.values(native)) {
    for (const tag of tags) {
      if (!matches(tag.id.toLowerCase())) continue;
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

// null means no metadata write; callers may still embed cover art.
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

// Shared by apply and preview so their canonical tag sets cannot drift.
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
    // M4B retains grouping; MP3 retains series.
    ...(metadata.seriesName && { grouping: metadata.seriesName, series: metadata.seriesName }),
    // Preserve series position zero.
    ...(metadata.seriesPosition != null && { seriesPart: metadata.seriesPosition }),
    ...(metadata.subtitle && { subtitle: metadata.subtitle }),
    ...(metadata.asin && { asin: metadata.asin }),
    ...(metadata.publisher && { publisher: metadata.publisher }),
    ...(metadata.description && { description: metadata.description }),
    ...(year && { date: year }),
    ...(firstGenre && { genre: firstGenre }),
  };
}

// Multi-file only: preserve an existing title in overwrite mode, otherwise use
// the basename. populate_missing relies on resolveTags to protect existing titles.
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

// Shared by apply and preview; multi-file books replace title and add track numbers.
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

// The user-facing track exclusion covers both track and trackTotal.
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
  // buildCanonicalTags sources both required fields from the non-null book title.
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
