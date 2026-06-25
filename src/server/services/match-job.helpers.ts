import { basename } from 'node:path';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import { diceCoefficient, normalizeNarrator, narratorsFuzzyMatch, scoreResult, tokenizeNarrators } from '../../core/utils/similarity.js';
import { cleanTagTitle, extractYear, hasTagSeriesMarker, isPureVolumeMarker } from '../utils/folder-parsing.js';
import type { Confidence, MatchCandidate, MatchResult } from './match-job.service.js';

const DURATION_THRESHOLD_STRICT = 0.05;
const DURATION_THRESHOLD_RELAXED = 0.15;
const COMBINED_SCORE_GATE = 0.95;

export interface DurationConfidenceResult {
  confidence: Confidence;
  reason?: string;
}

/** Format minutes as hours with 1 decimal place. */
function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(1);
}

/**
 * Single source of truth for "does the scanned runtime independently corroborate
 * this candidate?". Returns true only when both the scanned duration and the
 * candidate's metadata duration are present and positive AND the relative
 * distance is within tolerance. The strict 5% band relaxes to 15% once the
 * combined similarity score clears `COMBINED_SCORE_GATE` (a strong textual match
 * earns a wider runtime tolerance).
 *
 * Guard hygiene (#1266): both the falsy and `<= 0` checks are load-bearing — a
 * bare `!scannedDuration` or `meta.duration > 0` alone misbehaves on the
 * `0`/`undefined` boundaries.
 */
export function isDurationVerified(
  meta: BookMetadata,
  scannedDuration: number | undefined,
  score: number,
): boolean {
  if (!scannedDuration || scannedDuration <= 0) return false;
  if (!meta.duration || meta.duration <= 0) return false;
  const distance = Math.abs(meta.duration - scannedDuration) / scannedDuration;
  const threshold = score >= COMBINED_SCORE_GATE ? DURATION_THRESHOLD_RELAXED : DURATION_THRESHOLD_STRICT;
  return distance <= threshold;
}

/**
 * Determines confidence from duration data without overriding the similarity-ranked winner.
 * The bestMatch stays as the top similarity-ranked result; duration only affects confidence level.
 * The high-vs-medium decision is delegated to `isDurationVerified` so the
 * strict/relaxed-threshold logic lives in exactly one place (#1266).
 */
export function resolveConfidenceFromDuration(
  scored: { meta: BookMetadata; score: number }[],
  duration: number | undefined,
): DurationConfidenceResult {
  if (!duration || duration <= 0) {
    return { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate' };
  }
  const topResult = scored[0]!;
  if (topResult.meta.duration && topResult.meta.duration > 0) {
    if (isDurationVerified(topResult.meta, duration, topResult.score)) return { confidence: 'high' };
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatHours(duration)}hrs vs expected ${formatHours(topResult.meta.duration)}hrs`,
    };
  }
  return { confidence: 'medium', reason: 'Best match missing duration — cannot verify' };
}

export interface TagQuery {
  title: string;
  author: string;
  year?: string;
}

/**
 * Strip a trailing parenthetical suffix from a tag-derived author string.
 * Tagger tools commonly auto-append markers like `(audio)` or `(Read by ...)`
 * that break Audible's structured `author=` exact-match search. Only the
 * rightmost trailing paren is stripped — embedded parens (e.g. `Robert (Bob) Smith`)
 * are usually meaningful aliases and stay intact. Unlike `cleanTagTitle`, this
 * is unconditional: edition metadata is essentially never meaningful on the
 * author side, so no `isEditionParen` gate.
 */
export function cleanTagAuthor(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/**
 * Build a tag-derived search query from the AudioScanResult, applying
 * cleanTagTitle to tagTitle and cleanTagAuthor to tagAuthor. Returns null when
 * the scan lacks usable tags (missing title or author after cleaning) — caller
 * falls through to Pass 2. `year` is carried through (when present in tags)
 * for use by the rankResultsCleaned tiebreaker; missing tagYear is fine —
 * tiebreaker no-ops.
 */
export function deriveTagQuery(audioResult: AudioScanResult | null): TagQuery | null {
  if (!audioResult) return null;
  const rawTitle = audioResult.tagTitle?.trim();
  const rawAuthor = audioResult.tagAuthor?.trim();
  if (!rawTitle || !rawAuthor) return null;
  const cleanedAuthor = cleanTagAuthor(rawAuthor);
  if (!cleanedAuthor) return null;
  const searchTitle = resolveTagSearchTitle(rawTitle, audioResult.tagAlbum);
  if (!searchTitle) return null;
  const tagYear = audioResult.tagYear?.trim();
  return { title: searchTitle, author: cleanedAuthor, ...(tagYear ? { year: tagYear } : {}) };
}

/** Normalize a title for the album-vs-prefix difference check: lowercase, trim, collapse internal whitespace. */
function normalizeForTitleCompare(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Resolve the tag-pass search title, redirecting generic/series-name title tags
 * to the album when the real title lives there (#1650). Operates on the RAW
 * `tagTitle` before `cleanTagTitle` strips the `, Book N` marker — the
 * bare-vs-prefix distinction needs the original suffix. Uses only `tagTitle` +
 * `tagAlbum` (no folder data, no signature change):
 *
 * - **Bare placeholder** (`Book 1`, `Series, Book 1`): no usable title in the
 *   tag → use the cleaned album when present, else `null` (caller falls through
 *   to Pass 2's filename-derived search).
 * - **Series-prefix + differing album** (`Shattered Sea, Book 1` / album
 *   `Half a King`): the `, Book N` marker means the cleaned prefix is a series
 *   name, so prefer the cleaned album when it differs (normalized) from the
 *   prefix.
 * - **Legitimate `, Book N` title** (`The Hobbit, Book 1` with album
 *   `The Hobbit` or no album): keep the cleaned title. The rule keys on the
 *   album difference, not the title shape, because `The Hobbit, Book 1` and
 *   `Shattered Sea, Book 1` are indistinguishable by grammar alone.
 */
function resolveTagSearchTitle(rawTitle: string, rawAlbum: string | undefined): string | null {
  const cleanedTitle = cleanTagTitle(rawTitle).trim();
  const cleanedAlbum = rawAlbum?.trim() ? cleanTagTitle(rawAlbum).trim() : '';
  const usableAlbum = cleanedAlbum.length > 0;

  if (isPureVolumeMarker(rawTitle)) {
    return usableAlbum ? cleanedAlbum : null;
  }

  const albumDiffers = usableAlbum && normalizeForTitleCompare(cleanedAlbum) !== normalizeForTitleCompare(cleanedTitle);
  if (hasTagSeriesMarker(rawTitle) && albumDiffers) {
    return cleanedAlbum;
  }

  return cleanedTitle || null;
}

const TAG_TITLE_WEIGHT = 0.6;
const TAG_AUTHOR_WEIGHT = 0.4;

/**
 * Multi-form title score for a tag-derived input against a book-metadata
 * candidate. Composes 1-6 candidate strings from `result.title` and the
 * canonical primary-series ref (`seriesPrimary`, falling back to `series[0]`)
 * and returns the max dice across them.
 *
 * Two distinct concerns, both load-bearing:
 *
 * 1. Symmetric cleaning (#1011) — `cleanTagTitle` runs on `result.title` AND
 *    the primary-series name so publisher decoration like "(Full Audiobook)"
 *    or "[Bonus]" doesn't poison dice. The input is already cleaned upstream
 *    by `deriveTagQuery`, so cleaning the result side restores symmetry.
 *
 * 2. Multi-form composition — Audible's canonical title is short; series
 *    annotation lives in the structured `series[]` field, not the title
 *    string. Tag titles inline series. Cleaning alone produces dice ≈ 0.4
 *    on Eric-shape inputs because the two sides carry different content.
 *    Composing `title + ': ' + series.name` (and the dash/order/position
 *    variants) lets the input match its semantic equivalent, so an
 *    Eric-shape (`title="Eric"`, `series=[{name:"Discworld"}]`,
 *    input="Eric: Discworld") scores 1.0.
 *
 * Canonical-series source (#1088 / #1097): `seriesPrimary` is the Audnexus-
 * derived canonical ref. When present it is preferred over `series[0]`, which
 * on Audible can be a broader universe/meta-series (e.g. Cosmere) rather than
 * the real book series (Stormlight Archive). Fallback to `series[0]` only
 * when `seriesPrimary` is absent (Audible-only candidates).
 *
 * Empty-array guard: `Math.max(...[])` returns `-Infinity`. Without the guard,
 * a result with `title === undefined` and missing/empty series name would
 * silently return `-Infinity` and pass any floor check downstream. The
 * `scores.length > 0 ? Math.max(...scores) : 0` form returns `0` instead.
 */
export function tagTitleScore(input: string, result: BookMetadata): number {
  const title = cleanTagTitle(result.title ?? '');
  const primary = result.seriesPrimary ?? result.series?.[0];
  const seriesName = cleanTagTitle(primary?.name ?? '');
  const seriesPos = primary?.position;
  const candidates: string[] = [title];
  if (seriesName) {
    candidates.push(
      `${title}: ${seriesName}`,
      `${title} - ${seriesName}`,
      `${seriesName}: ${title}`,
      `${seriesName} - ${title}`,
    );
    if (seriesPos !== undefined) {
      candidates.push(`${seriesName}: ${title}, Book ${seriesPos}`);
    }
  }
  const scores = candidates.filter(c => c.length > 0).map(c => diceCoefficient(input, c));
  return scores.length > 0 ? Math.max(...scores) : 0;
}

/**
 * Tag-pass scoring: composes the result-side title from `result.title` +
 * the canonical primary-series ref via `tagTitleScore`, removing the
 * cleanName-derived symmetry assumption from #984. Author side is preserved exactly from #995 —
 * normalizeNarrator on both sides so dice scores reflect semantic similarity,
 * not punctuation noise.
 *
 * Title/author weighting (0.6 / 0.4) mirrors `scoreResult` at
 * `src/core/utils/similarity.ts:62-84`; we re-derive the combined score
 * inline because we no longer call `scoreResult` for the title side.
 *
 * Year tiebreaker (#995): when dice scores are tied within 0.001 and tagQuery
 * carries a year hint from the audio tags, candidates whose publishedDate year
 * matches tagYear rank first. Tag-derived only — folder year is NOT consulted
 * here (Pass 2's signal stays out of Pass 1).
 */
export function rankResultsCleaned(
  detailed: BookMetadata[],
  tagQuery: TagQuery,
): { meta: BookMetadata; score: number }[] {
  const normalizedAuthor = normalizeNarrator(tagQuery.author);
  const scored = detailed.map(meta => {
    const titleScore = tagTitleScore(tagQuery.title, meta);
    const resultAuthor = meta.authors?.[0]?.name;
    const authorScore = resultAuthor
      ? diceCoefficient(normalizeNarrator(resultAuthor), normalizedAuthor)
      : 0;
    const titleWeight = meta.title !== undefined ? TAG_TITLE_WEIGHT : 0;
    const authorWeight = resultAuthor !== undefined ? TAG_AUTHOR_WEIGHT : 0;
    const totalWeight = titleWeight + authorWeight;
    const score = totalWeight > 0
      ? (titleScore * titleWeight + authorScore * authorWeight) / totalWeight
      : 0;
    return { meta, score };
  });

  const tagYear = tagQuery.year ? parseInt(tagQuery.year, 10) : undefined;
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 0.001 && tagYear) {
      const aYear = parsePublishedYear(a.meta.publishedDate);
      const bYear = parsePublishedYear(b.meta.publishedDate);
      const aMatch = aYear === tagYear ? 1 : 0;
      const bMatch = bYear === tagYear ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return b.score - a.score;
  });
  return scored;
}

/** Scores and ranks results by title+author similarity with year tiebreaker. */
export function rankResults(
  detailed: BookMetadata[],
  book: MatchCandidate,
): { meta: BookMetadata; score: number }[] {
  const context = { title: book.title, ...(book.author !== undefined && { author: book.author }) };
  const scored = detailed.map(meta => ({
    meta,
    score: scoreResult(
      { title: meta.title, ...(meta.authors?.[0]?.name !== undefined && { author: meta.authors[0].name }) },
      context,
    ),
  }));

  const folderYear = extractYear(basename(book.path));
  scored.sort((a, b) => {
    if (Math.abs(a.score - b.score) < 0.001 && folderYear) {
      const aYear = parsePublishedYear(a.meta.publishedDate);
      const bYear = parsePublishedYear(b.meta.publishedDate);
      const aMatch = aYear === folderYear ? 1 : 0;
      const bMatch = bYear === folderYear ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }
    return b.score - a.score;
  });
  return scored;
}

/** Extract the first 4-digit year from a publishedDate string (e.g. '2011-06-14' → 2011). */
export function parsePublishedYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const match = date.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

/**
 * Wrong-edition guard (#1650). Two *unabridged* readings of the same book are
 * inherently almost the same length, so duration cannot distinguish editions —
 * the narrator can. When the file's embedded narrator tag names a different
 * person than the matched edition's narrators, the match is the right book but
 * the wrong edition; return a user-facing reason so the central cap can
 * downgrade `high → medium` (Review).
 *
 * Fuzzy, via the shared `narratorsFuzzyMatch` primitive — spelling/punctuation
 * variants at or above the `0.8` dice threshold are NOT a mismatch. Returns
 * `null` (no cap) whenever either side lacks a narrator signal: an absent file
 * tag or an edition with no `narrators` is "no signal", not a mismatch.
 */
function narratorMismatchReason(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
): string | null {
  if (!fileNarratorRaw || tokenizeNarrators(fileNarratorRaw).length === 0) return null;
  const editions = (editionNarrators ?? []).filter(n => n.trim().length > 0);
  if (editions.length === 0) return null;
  if (narratorsFuzzyMatch(fileNarratorRaw, editionNarrators)) return null;
  return `Narrator mismatch — file: ${fileNarratorRaw.trim()} · matched edition: ${editions.join(', ')}`;
}

/**
 * Central post-outcome narrator clamp (#1650). Applied to the *resolved*
 * `{ confidence, reason }` of every high-confidence match outcome — both passes,
 * including the tag ASIN kill-shot — so no high-confidence branch can slip past
 * it. Only ever downgrades `high → medium`; never promotes, and never overrides
 * an existing duration/attempt cap (a result already at `medium`/`none` is left
 * untouched). Fires even when duration verified the match — narrator is the
 * discriminator duration lacks, so it must not be bypassed by `isDurationVerified`.
 */
export function applyNarratorCap(result: MatchResult, audioResult: AudioScanResult | null): MatchResult {
  if (result.confidence !== 'high' || !result.bestMatch) return result;
  const reason = narratorMismatchReason(audioResult?.tagNarrator, result.bestMatch.narrators);
  if (reason === null) return result;
  return { ...result, confidence: 'medium', reason };
}
