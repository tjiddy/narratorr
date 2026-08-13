import { basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '@core/metadata/index.js';
import type { AudioScanResult } from '@core/utils/audio-scanner.js';
import { compareNarratorSignals, diceCoefficient, normalizeNarrator, scoreResult } from '@core/utils/similarity.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import { cleanTagTitle, extractYear, hasTagSeriesMarker, isPureVolumeMarker } from '../utils/folder-parsing.js';
import type { Confidence, MatchCandidate, MatchResult } from './match-job.types.js';
import type { MatchReasonKind } from '@shared/match-reason-kind.js';
import type { MatchSource } from './tag-search-planner.js';
import type { BookService } from './book.service.js';
import { decideIntake } from './book-intake/index.js';
import { serializeError } from '../utils/serialize-error.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';
import { withinDurationTolerance } from '@shared/duration-tolerance.js';
import { formatDurationSeconds } from '@shared/format-duration.js';

/** User-facing recording-review reason; machine-specific reasons stay in logs. */
export const RECORDING_REVIEW_REASON =
  'Possible different recording of a book you already own — review before importing';

/** Annotate a resolved match from the three-way recording check. Review remains display-only;
 * different recordings are flagged only with an incumbent, and lookup failure is non-fatal. */
export async function applyLibraryDuplicate(
  result: MatchResult,
  bookService: Pick<BookService, 'findDuplicate'>,
  log: FastifyBaseLogger,
): Promise<MatchResult> {
  if (!result.bestMatch) return result;
  try {
    const decision = await decideIntake({ bookService }, {
      item: {
        title: result.bestMatch.title,
        authors: result.bestMatch.authors,
        ...(result.bestMatch.asin !== undefined && { asin: result.bestMatch.asin }),
        ...(result.bestMatch.narrators !== undefined && { narrators: result.bestMatch.narrators }),
        ...(result.bestMatch.duration !== undefined && { duration: result.bestMatch.duration }),
        // Normalize production form so an unmeasured abridged mismatch cannot look like the same recording.
        ...(result.bestMatch.formatType ? { productionType: normalizeProductionType(result.bestMatch.formatType) } : {}),
      },
    });
    if (decision.kind === 'same-recording' && decision.incumbent) {
      log.debug(
        { path: result.path, existingBookId: decision.incumbent.id, title: result.bestMatch.title },
        'Post-match library duplicate detected (same recording)',
      );
      return { ...result, isDuplicate: true, existingBookId: decision.incumbent.id, duplicateReason: 'slug', recordingVerdict: 'same-recording' };
    }
    if (decision.kind === 'review') {
      log.debug(
        { path: result.path, existingBookId: decision.incumbent?.id, title: result.bestMatch.title, recordingReviewReason: decision.recordingReviewReason },
        'Post-match recording review required',
      );
      // Keep the machine reason in logs; the UI receives a stable generic warning.
      return {
        ...result,
        reviewReason: RECORDING_REVIEW_REASON,
        recordingVerdict: 'review',
        ...(decision.incumbent ? { existingBookId: decision.incumbent.id } : {}),
      };
    }
    // Without an incumbent, a different recording is simply a new book and stays unflagged.
    if (decision.kind === 'admit' && decision.hasIncumbent) {
      log.debug(
        { path: result.path, title: result.bestMatch.title },
        'Post-match: new recording of an owned title (different recording)',
      );
      return { ...result, recordingVerdict: 'different-recording' };
    }
  } catch (error: unknown) {
    log.warn({ error: serializeError(error), path: result.path }, 'Post-match duplicate check failed — proceeding without flag');
  }
  return result;
}

const CAPPED_ATTEMPT_REASON = 'Low confidence match. Please verify.';

export function capConfidence(c: Confidence, cap: 'high' | 'medium'): Confidence {
  if (cap === 'medium' && c === 'high') return 'medium';
  return c;
}

// Cap-driven downgrades need a tooltip reason for the Review pill.
export function applyAttemptCap(
  raw: Confidence,
  cap: 'high' | 'medium',
  durationReason: string | undefined,
  durationReasonKind?: MatchReasonKind,
): { confidence: Confidence; reason?: string; reasonKind?: MatchReasonKind } {
  const confidence = capConfidence(raw, cap);
  const reason = durationReason ?? (confidence === 'medium' ? CAPPED_ATTEMPT_REASON : undefined);
  const base = reason !== undefined ? { confidence, reason } : { confidence };
  // `reasonKind` belongs only to a surviving duration reason, never a synthesized cap reason.
  return durationReasonKind !== undefined && reason === durationReason
    ? { ...base, reasonKind: durationReasonKind }
    : base;
}

export interface DurationConfidenceResult {
  confidence: Confidence;
  reason?: string;
  /** Present only for duration-derived reasons. */
  reasonKind?: MatchReasonKind;
}

/** Optional chapter-table runtimes in seconds; absent fields mean no usable reference. */
export interface ChapterRuntimeSeconds {
  fullSeconds?: number;
  /** Full table with trailing promotional chapters removed. */
  trimmedSeconds?: number;
}

/** Corroborate seconds against the shared absolute tolerance; provider duration is in minutes.
 * Missing/non-positive data is not disagreement, and chapter totals are additive references only. */
export function isDurationVerified(
  meta: BookMetadata,
  scannedSeconds: number | undefined,
  chapterRuntimes?: ChapterRuntimeSeconds | undefined,
): boolean {
  if (!scannedSeconds || scannedSeconds <= 0) return false;
  // Full or promo-trimmed chapter totals may corroborate a scan when the provider scalar is wrong.
  if (corroboratesScanned(chapterRuntimes?.fullSeconds, scannedSeconds)
    || corroboratesScanned(chapterRuntimes?.trimmedSeconds, scannedSeconds)) {
    return true;
  }
  if (!meta.duration || meta.duration <= 0) return false;
  return withinDurationTolerance(meta.duration * 60, scannedSeconds);
}

function corroboratesScanned(reference: number | undefined, scannedSeconds: number): boolean {
  return reference !== undefined && Number.isFinite(reference) && reference > 0
    && withinDurationTolerance(reference, scannedSeconds);
}

/** Classify the already-ranked top candidate without reordering it. Chapter runtimes can suppress
 * a scalar mismatch, but the displayed expectation remains the provider scalar. */
export function resolveConfidenceFromDuration(
  scored: { meta: BookMetadata }[],
  scannedSeconds: number | undefined,
  chapterRuntimes?: ChapterRuntimeSeconds | undefined,
): DurationConfidenceResult {
  if (!scannedSeconds || scannedSeconds <= 0) {
    return { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate', reasonKind: 'no-duration-data' };
  }
  const topResult = scored[0]!;
  if (topResult.meta.duration && topResult.meta.duration > 0) {
    if (isDurationVerified(topResult.meta, scannedSeconds, chapterRuntimes)) return { confidence: 'high' };
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatDurationSeconds(scannedSeconds)} vs expected ${formatDurationSeconds(topResult.meta.duration * 60)}`,
      reasonKind: 'duration-mismatch',
    };
  }
  return { confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' };
}

/** Raw single-candidate confidence stays high unless two positive runtimes disagree. Missing data
 * never demotes; chapter references only suppress mismatches, and attempt caps apply later. */
export function resolveSingleResultConfidence(
  meta: BookMetadata,
  scannedSeconds: number | undefined,
  chapterRuntimes?: ChapterRuntimeSeconds | undefined,
): DurationConfidenceResult {
  const bothPresent = !!scannedSeconds && scannedSeconds > 0 && !!meta.duration && meta.duration > 0;
  if (bothPresent && !isDurationVerified(meta, scannedSeconds, chapterRuntimes)) {
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatDurationSeconds(scannedSeconds)} vs expected ${formatDurationSeconds(meta.duration! * 60)}`,
      reasonKind: 'duration-mismatch',
    };
  }
  return { confidence: 'high' };
}

export const TITLE_SIMILARITY_FLOOR = 0.5;
export const TAG_AUTHOR_PREDICATE_FLOOR = 0.7;

export function tagPassPredicatesPass(
  log: FastifyBaseLogger,
  path: string,
  tagQuery: TagQuery,
  top: { meta: BookMetadata; score: number },
): boolean {
  const titleFloor = tagTitleScore(tagQuery.title, top.meta);
  if (titleFloor < TITLE_SIMILARITY_FLOOR) {
    log.debug(
      { path, titleSimilarity: titleFloor.toFixed(2), bestTitle: top.meta.title },
      'Tag-derived top result below title floor — falling through',
    );
    return false;
  }
  const topAuthor = top.meta.authors?.[0]?.name;
  const authorScore = topAuthor
    ? diceCoefficient(normalizeNarrator(topAuthor), normalizeNarrator(tagQuery.author))
    : 0;
  if (authorScore < TAG_AUTHOR_PREDICATE_FLOOR) {
    log.debug(
      { path, topResultAuthor: topAuthor, tagAuthor: tagQuery.author, score: authorScore.toFixed(2) },
      'tag-author predicate failed — falling through to filename-derived path',
    );
    return false;
  }
  return true;
}

export interface TagQuery {
  title: string;
  author: string;
  year?: string;
  /** Audio-tag series position; zero is valid. */
  seriesPosition?: number;
}

/** Strip only the trailing tagger suffix from authors; embedded parentheses may be meaningful aliases. */
export function cleanTagAuthor(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** Build a cleaned tag query or return null when title/author are unusable; preserve position zero. */
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
  return {
    title: searchTitle,
    author: cleanedAuthor,
    ...(tagYear ? { year: tagYear } : {}),
    ...(audioResult.tagSeriesPosition !== undefined && { seriesPosition: audioResult.tagSeriesPosition }),
  };
}

function normalizeForTitleCompare(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** Resolve raw tags before stripping Book markers. Bare volume placeholders use a usable album;
 * series-prefix tags use a differing album, while matching/no album keeps the cleaned title. */
function resolveTagSearchTitle(rawTitle: string, rawAlbum: string | undefined): string | null {
  const cleanedTitle = cleanTagTitle(rawTitle).trim();
  const cleanedAlbum = rawAlbum?.trim() ? cleanTagTitle(rawAlbum).trim() : '';
  // A bare volume-marker album is no more usable than a bare volume-marker title.
  const usableAlbum = cleanedAlbum.length > 0 && !isPureVolumeMarker(rawAlbum!.trim());

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

/** Score cleaned title and canonical primary-series composites against the already-cleaned input.
 * Keep the empty-candidate guard: `Math.max(...[])` is `-Infinity`, not zero. */
export function tagTitleScore(input: string, result: BookMetadata): number {
  const title = cleanTagTitle(result.title ?? '');
  const primary = pickPrimarySeries(result);
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

/** Prefer an exact primary-series position on score ties. Missing wanted position is a strict no-op;
 * zero is valid, and all non-matches remain tied. */
export function positionTiebreak(a: BookMetadata, b: BookMetadata, wanted: number | undefined): number {
  if (wanted == null) return 0;
  const aMatch = pickPrimarySeries(a)?.position === wanted ? 1 : 0;
  const bMatch = pickPrimarySeries(b)?.position === wanted ? 1 : 0;
  return bMatch - aMatch;
}

/** Prefer the only duration-verified edition on score ties. Invalid scans and equal verification
 * states are no-ops; the shared verifier keeps ranking and final verdict on one tolerance. */
export function durationTiebreak(a: BookMetadata, b: BookMetadata, scannedSeconds: number | undefined): number {
  const aMatch = isDurationVerified(a, scannedSeconds) ? 1 : 0;
  const bMatch = isDurationVerified(b, scannedSeconds) ? 1 : 0;
  return bMatch - aMatch;
}

/** Rank tag candidates 60/40 by title/author. Ties use tag series position, scanned duration,
 * then tag year; folder year never leaks into this pass. */
export function rankResultsCleaned(
  detailed: BookMetadata[],
  tagQuery: TagQuery,
  scannedSeconds?: number,
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
    if (Math.abs(a.score - b.score) < 0.001) {
      const posCmp = positionTiebreak(a.meta, b.meta, tagQuery.seriesPosition);
      if (posCmp !== 0) return posCmp;
      const durCmp = durationTiebreak(a.meta, b.meta, scannedSeconds);
      if (durCmp !== 0) return durCmp;
      if (tagYear) {
        const aYear = parsePublishedYear(a.meta.publishedDate);
        const bYear = parsePublishedYear(b.meta.publishedDate);
        const aMatch = aYear === tagYear ? 1 : 0;
        const bMatch = bYear === tagYear ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
      }
    }
    return b.score - a.score;
  });
  return scored;
}

/** Folder-pass score ties use series position, scanned duration, then folder year. */
export function rankResults(
  detailed: BookMetadata[],
  book: MatchCandidate,
  scannedSeconds?: number,
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
    if (Math.abs(a.score - b.score) < 0.001) {
      const posCmp = positionTiebreak(a.meta, b.meta, book.seriesPosition);
      if (posCmp !== 0) return posCmp;
      const durCmp = durationTiebreak(a.meta, b.meta, scannedSeconds);
      if (durCmp !== 0) return durCmp;
      if (folderYear) {
        const aYear = parsePublishedYear(a.meta.publishedDate);
        const bYear = parsePublishedYear(b.meta.publishedDate);
        const aMatch = aYear === folderYear ? 1 : 0;
        const bMatch = bYear === folderYear ? 1 : 0;
        if (aMatch !== bMatch) return bMatch - aMatch;
      }
    }
    return b.score - a.score;
  });
  return scored;
}

export function parsePublishedYear(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const match = date.match(/\b(\d{4})\b/);
  return match ? parseInt(match[1]!, 10) : undefined;
}

/** Narrator distinguishes same-length editions. The shared signal comparator treats absent or
 * punctuation-only values as no signal; only a genuine mismatch returns a Review reason. */
export function narratorMismatchReason(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
): string | null {
  if (compareNarratorSignals(fileNarratorRaw, editionNarrators) !== 'mismatch') return null;
  const editions = (editionNarrators ?? []).map(n => n.trim()).filter(n => n.length > 0);
  return `Narrator mismatch — file: ${(fileNarratorRaw ?? '').trim()} · matched edition: ${editions.join(', ')}`;
}

/** Branch-local context required only for the narrator-cap observability log. */
export interface NarratorCapContext {
  log: FastifyBaseLogger;
  matchSource: MatchSource;
  durationVerified: boolean;
}

/** Clamp every resolved high-confidence path to medium on narrator mismatch, even after duration
 * verification. Never override an existing cap; log only when the demotion actually occurs. */
export function applyNarratorCap(
  result: MatchResult,
  audioResult: AudioScanResult | null,
  ctx: NarratorCapContext,
): MatchResult {
  if (result.confidence !== 'high' || !result.bestMatch) return result;
  const reason = narratorMismatchReason(audioResult?.tagNarrator, result.bestMatch.narrators);
  if (reason === null) return result;
  ctx.log.info(
    {
      path: result.path,
      bestTitle: result.bestMatch.title,
      asin: result.bestMatch.asin,
      fileNarrator: audioResult?.tagNarrator,
      editionNarrators: result.bestMatch.narrators,
      matchSource: ctx.matchSource,
      durationVerified: ctx.durationVerified,
    },
    'Narrator wrong-edition cap fired — high → medium (Review)',
  );
  return { ...result, confidence: 'medium', reason };
}
