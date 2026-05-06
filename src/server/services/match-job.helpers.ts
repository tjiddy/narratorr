import { basename } from 'node:path';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import { diceCoefficient, normalizeNarrator, scoreResult } from '../../core/utils/similarity.js';
import { cleanTagTitle, extractYear } from '../utils/folder-parsing.js';
import type { Confidence, MatchCandidate } from './match-job.service.js';

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
 * Determines confidence from duration data without overriding the similarity-ranked winner.
 * The bestMatch stays as the top similarity-ranked result; duration only affects confidence level.
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
    const distance = Math.abs(topResult.meta.duration - duration) / duration;
    const threshold = topResult.score >= COMBINED_SCORE_GATE ? DURATION_THRESHOLD_RELAXED : DURATION_THRESHOLD_STRICT;
    if (distance <= threshold) return { confidence: 'high' };
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
 * Build a tag-derived search query from the AudioScanResult, applying
 * cleanTagTitle to tagTitle. Returns null when the scan lacks usable tags
 * (missing title or author after trimming) — caller falls through to Pass 2.
 * `year` is carried through (when present in tags) for use by the
 * rankResultsCleaned tiebreaker; missing tagYear is fine — tiebreaker no-ops.
 */
export function deriveTagQuery(audioResult: AudioScanResult | null): TagQuery | null {
  if (!audioResult) return null;
  const rawTitle = audioResult.tagTitle?.trim();
  const rawAuthor = audioResult.tagAuthor?.trim();
  if (!rawTitle || !rawAuthor) return null;
  const cleanedTitle = cleanTagTitle(rawTitle).trim();
  if (!cleanedTitle) return null;
  const tagYear = audioResult.tagYear?.trim();
  return { title: cleanedTitle, author: rawAuthor, ...(tagYear ? { year: tagYear } : {}) };
}

const TAG_TITLE_WEIGHT = 0.6;
const TAG_AUTHOR_WEIGHT = 0.4;

/**
 * Multi-form title score for a tag-derived input against a book-metadata
 * candidate. Composes 1-6 candidate strings from `result.title` and
 * `result.series[0]` and returns the max dice across them.
 *
 * Why composition: Audible's canonical title is short — series annotation lives
 * in the structured `series[]` field, not the title string. Tag titles inline
 * series. Symmetric cleaning of both sides produces dice ≈ 0.4 because the two
 * sides carry different content. Composing `title + ': ' + series.name` (and
 * the dash/order/position variants) lets the input match its semantic
 * equivalent, so an Eric-shape (`title="Eric"`, `series=[{name:"Discworld"}]`,
 * input="Eric: Discworld") scores 1.0.
 *
 * Empty-array guard: `Math.max(...[])` returns `-Infinity`. Without the guard,
 * a result with `title === undefined` and missing/empty `series[].name` would
 * silently return `-Infinity` and pass any floor check downstream. The
 * `scores.length > 0 ? Math.max(...scores) : 0` form returns `0` instead.
 */
export function tagTitleScore(input: string, result: BookMetadata): number {
  const title = cleanTagTitle(result.title ?? '');
  const seriesName = cleanTagTitle(result.series?.[0]?.name ?? '');
  const seriesPos = result.series?.[0]?.position;
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
 * `result.series[0]` via `tagTitleScore`, removing the cleanName-derived
 * symmetry assumption from #984. Author side is preserved exactly from #995 —
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
