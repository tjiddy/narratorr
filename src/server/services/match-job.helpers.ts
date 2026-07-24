import { basename } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { BookMetadata } from '../../core/metadata/index.js';
import type { AudioScanResult } from '../../core/utils/audio-scanner.js';
import { compareNarratorSignals, diceCoefficient, normalizeNarrator, scoreResult } from '../../core/utils/similarity.js';
import { normalizeProductionType } from '../../core/metadata/production-type.js';
import { cleanTagTitle, extractYear, hasTagSeriesMarker, isPureVolumeMarker } from '../utils/folder-parsing.js';
import type { Confidence, MatchCandidate, MatchResult } from './match-job.types.js';
import type { MatchReasonKind } from '../../shared/match-reason-kind.js';
import type { MatchSource } from './tag-search-planner.js';
import type { BookService } from './book.service.js';
import { serializeError } from '../utils/serialize-error.js';
import { pickPrimarySeries } from '../../shared/pick-primary-series.js';
import { withinDurationTolerance } from '../../shared/duration-tolerance.js';
import { formatDurationSeconds } from '../../shared/format-duration.js';

/** User-facing reason surfaced on a post-match recording-review row (#1711). */
export const RECORDING_REVIEW_REASON =
  'Possible different recording of a book you already own — review before importing';

/**
 * Post-match recording-identity check (#1662, #1711). On a resolved match, ask
 * the three-way `findDuplicate` whether the matched recording is already owned,
 * a different recording, or needs review — `bestMatch` carries the narrators +
 * duration the resolver needs (a no-author filename does not):
 *
 *  - `same-recording` → flag `isDuplicate=true, duplicateReason='slug'` (owned),
 *    plus `recordingVerdict:'same-recording'`.
 *  - `review`/no-signal → set the display-only `reviewReason` (NOT a hard
 *    `isDuplicate`) so the UI surfaces it but the row still flows, plus
 *    `recordingVerdict:'review'`.
 *  - `different-recording` WITH an incumbent → `recordingVerdict:'different-recording'`
 *    (a deliberate new recording of an owned title); not a duplicate, row stays selected.
 *  - `different-recording` WITHOUT an incumbent → a genuinely new book; left unflagged
 *    (no verdict, no badge).
 *
 * A failed lookup is non-fatal: the match still returns, just without a flag.
 */
export async function applyLibraryDuplicate(
  result: MatchResult,
  bookService: Pick<BookService, 'findDuplicate'>,
  log: FastifyBaseLogger,
): Promise<MatchResult> {
  if (!result.bestMatch) return result;
  try {
    const resolution = await bookService.findDuplicate({
      title: result.bestMatch.title,
      authors: result.bestMatch.authors,
      ...(result.bestMatch.asin !== undefined && { asin: result.bestMatch.asin }),
      ...(result.bestMatch.narrators !== undefined && { narrators: result.bestMatch.narrators }),
      ...(result.bestMatch.duration !== undefined && { duration: result.bestMatch.duration }),
      // Production form (#1728, F2): normalize the matched edition's formatType so
      // an abridged-vs-unabridged best match with no usable duration classifies as
      // review rather than a silent same-recording duplicate.
      ...(result.bestMatch.formatType ? { productionType: normalizeProductionType(result.bestMatch.formatType) } : {}),
    });
    if (resolution.verdict === 'same-recording' && resolution.book) {
      log.debug(
        { path: result.path, existingBookId: resolution.book.id, title: result.bestMatch.title },
        'Post-match library duplicate detected (same recording)',
      );
      return { ...result, isDuplicate: true, existingBookId: resolution.book.id, duplicateReason: 'slug', recordingVerdict: 'same-recording' };
    }
    if (resolution.verdict === 'review') {
      log.debug(
        { path: result.path, existingBookId: resolution.book?.id, title: result.bestMatch.title, recordingReviewReason: resolution.recordingReviewReason },
        'Post-match recording review required',
      );
      // The user-facing `reviewReason` display text is intentionally left as the
      // generic human warning (#1728): the machine reason rides the log context
      // above, never into the display string.
      return {
        ...result,
        reviewReason: RECORDING_REVIEW_REASON,
        recordingVerdict: 'review',
        ...(resolution.book ? { existingBookId: resolution.book.id } : {}),
      };
    }
    // `different-recording` WITH an incumbent → a new recording of an owned title.
    // A different-recording with NO incumbent is a genuinely new book — left unflagged.
    if (resolution.verdict === 'different-recording' && resolution.hasIncumbent) {
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

/**
 * Cap a computed Confidence at the planner-attempt's `maxConfidence`. Stripped
 * attempts (album/strip-leading-series/etc.) emit `'medium'` as their cap so
 * downstream Review/Verified UI can flag them for human attention even when
 * the duration check would otherwise bless them as `'high'`.
 */
export function capConfidence(c: Confidence, cap: 'high' | 'medium'): Confidence {
  if (cap === 'medium' && c === 'high') return 'medium';
  return c;
}

// Cap-driven downgrades from a planner attempt need a user-facing tooltip
// reason; without one the amber Review pill renders with no explanation (#1052).
export function applyAttemptCap(
  raw: Confidence,
  cap: 'high' | 'medium',
  durationReason: string | undefined,
  durationReasonKind?: MatchReasonKind,
): { confidence: Confidence; reason?: string; reasonKind?: MatchReasonKind } {
  const confidence = capConfidence(raw, cap);
  const reason = durationReason ?? (confidence === 'medium' ? CAPPED_ATTEMPT_REASON : undefined);
  const base = reason !== undefined ? { confidence, reason } : { confidence };
  // `reasonKind` rides only when the DURATION reason survives (it pairs with
  // `durationReason`). A cap-synthesized `CAPPED_ATTEMPT_REASON` carries no kind,
  // matching the spec's "attempt-cap rows have no reasonKind" (#1929).
  return durationReasonKind !== undefined && reason === durationReason
    ? { ...base, reasonKind: durationReasonKind }
    : base;
}

export interface DurationConfidenceResult {
  confidence: Confidence;
  reason?: string;
  /** Structured discriminator paired with `reason` (#1929) — one of the three
   * duration-derived kinds, or absent on a `high` result. */
  reasonKind?: MatchReasonKind;
}

/**
 * Single source of truth for "does the scanned runtime independently corroborate
 * this candidate?". Returns true only when both the scanned duration and the
 * candidate's metadata duration are present and positive AND the absolute gap is
 * within the shared `withinDurationTolerance` band (#1850/#1854). The two runtimes
 * carry different units — `scannedSeconds` is the unrounded scanner value in
 * SECONDS, `meta.duration` is the provider `runtimeLengthMin` in MINUTES — so the
 * minutes side is multiplied by 60 before the comparison. There is no relative %/score
 * tier: the result is identical regardless of title/author score, because a
 * duration gap answers the orthogonal "is this the complete edition I expect?"
 * question, on which high title confidence makes a gap MORE diagnostic, not less.
 *
 * Guard hygiene (#1266/#1821): both the falsy and `<= 0` checks are load-bearing —
 * a bare `!scannedSeconds` or `meta.duration > 0` alone misbehaves on the
 * `0`/`undefined` boundaries. A MISSING/zero runtime on either side is NOT a
 * disagreement (returns false so the single-result path keeps `high`; absent data
 * must not demote).
 */
export function isDurationVerified(
  meta: BookMetadata,
  scannedSeconds: number | undefined,
): boolean {
  if (!scannedSeconds || scannedSeconds <= 0) return false;
  if (!meta.duration || meta.duration <= 0) return false;
  return withinDurationTolerance(meta.duration * 60, scannedSeconds);
}

/**
 * Determines confidence from duration data; it does NOT itself pick or reorder
 * the winner. The bestMatch is whatever the ranker returned as `scored[0]` —
 * primarily the top text-scored result, with duration only ever breaking a
 * score tie between sibling editions upstream (#1882, `durationTiebreak`); this
 * verdict then reads `high`/`medium` off that chosen top candidate.
 * The high-vs-medium decision is delegated to `isDurationVerified` so the single
 * absolute band lives in exactly one place (#1266/#1850). `scannedSeconds` is the
 * unrounded scanner runtime in SECONDS; the mismatch reason renders it from
 * seconds and the provider side from minutes.
 */
export function resolveConfidenceFromDuration(
  scored: { meta: BookMetadata }[],
  scannedSeconds: number | undefined,
): DurationConfidenceResult {
  if (!scannedSeconds || scannedSeconds <= 0) {
    return { confidence: 'medium', reason: 'Multiple results — no duration data to disambiguate', reasonKind: 'no-duration-data' };
  }
  const topResult = scored[0]!;
  if (topResult.meta.duration && topResult.meta.duration > 0) {
    if (isDurationVerified(topResult.meta, scannedSeconds)) return { confidence: 'high' };
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatDurationSeconds(scannedSeconds)} vs expected ${formatDurationSeconds(topResult.meta.duration * 60)}`,
      reasonKind: 'duration-mismatch',
    };
  }
  return { confidence: 'medium', reason: 'Best match missing duration — cannot verify', reasonKind: 'missing-duration' };
}

/**
 * Single-candidate RAW confidence (#1821): `high` unless the scanned runtime and
 * the candidate runtime are BOTH present and disagree (then `medium`/Review with
 * the same mismatch reason the multi-result path emits). Reuses the exact band in
 * `isDurationVerified` — no new threshold. A MISSING runtime on either side stays
 * `high` (absent data must not demote; only a positive disagreement warns).
 *
 * This is the RAW value. On the filename-single path it becomes the final
 * `MatchResult.confidence` directly; on the tag-single path it is still subject to
 * the pre-existing attempt cap, which can clamp a raw `high` to final `medium` for
 * a `maxConfidence: 'medium'` attempt. The helper only ever demotes an otherwise-
 * `high` single; it never raises a capped attempt's ceiling.
 */
export function resolveSingleResultConfidence(
  meta: BookMetadata,
  scannedSeconds: number | undefined,
): DurationConfidenceResult {
  const bothPresent = !!scannedSeconds && scannedSeconds > 0 && !!meta.duration && meta.duration > 0;
  if (bothPresent && !isDurationVerified(meta, scannedSeconds)) {
    return {
      confidence: 'medium',
      reason: `Duration mismatch — scanned ${formatDurationSeconds(scannedSeconds)} vs expected ${formatDurationSeconds(meta.duration! * 60)}`,
      reasonKind: 'duration-mismatch',
    };
  }
  return { confidence: 'high' };
}

export interface TagQuery {
  title: string;
  author: string;
  year?: string;
  /** Wanted series position from the audio tags (#1849), threaded to the
   * shared position tiebreaker in `rankResultsCleaned`. Position 0 is valid
   * (#1028) — preserved with `!== undefined`, never `||`. */
  seriesPosition?: number;
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
 * tiebreaker no-ops. `seriesPosition` is likewise carried through (when the
 * scan tagged one) for the shared position tiebreaker; a genuine position `0`
 * survives via the `!== undefined` guard (#1849/#1028).
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
  return {
    title: searchTitle,
    author: cleanedAuthor,
    ...(tagYear ? { year: tagYear } : {}),
    ...(audioResult.tagSeriesPosition !== undefined && { seriesPosition: audioResult.tagSeriesPosition }),
  };
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
  // Shape-check the album the same way the title is checked (#1652): a bare
  // volume marker (`Book 5`) is no more usable as a search title than a bare
  // volume-marker title, so it must not survive `cleanTagTitle` and become the
  // search query.
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

/**
 * Shared position-agreement tiebreaker (#1849), consumed by BOTH `rankResults`
 * (folder pass) and `rankResultsCleaned` (tag pass) so the two rankers can't
 * drift (DRY-3). On a score tie between identically-titled series entries
 * (the whole Fablehaven series is just "Fablehaven"), prefer the candidate
 * whose primary-series position equals the wanted (parsed/tagged) position.
 *
 * Semantics:
 *  - `wanted == null` → returns `0` (strict no-op); ranking falls through to
 *    the year tiebreaker byte-for-byte, exactly as before this existed.
 *  - Uses `pickPrimarySeries` (the one shared series resolver, #1088/#1097)
 *    and `===` so a genuine position `0` (#1028) is respected, never coerced.
 *  - A candidate with no position — or a differing one — is a non-match: it
 *    loses ONLY to a candidate whose position equals `wanted`, and ties every
 *    other non-match (returns `0`), so ordering among non-matches is unchanged.
 *    Absence never demotes a candidate below another non-match and never throws.
 */
export function positionTiebreak(a: BookMetadata, b: BookMetadata, wanted: number | undefined): number {
  if (wanted == null) return 0;
  const aMatch = pickPrimarySeries(a)?.position === wanted ? 1 : 0;
  const bMatch = pickPrimarySeries(b)?.position === wanted ? 1 : 0;
  return bMatch - aMatch;
}

/**
 * Shared duration-agreement tiebreaker (#1882), consumed by BOTH `rankResults`
 * (folder pass) and `rankResultsCleaned` (tag pass). On a score tie between
 * sibling editions of one book (identical title/author/narrators, different
 * runtimes — e.g. the four Audible editions of "Dogs of War"), prefer the
 * candidate whose provider runtime agrees with the scanned duration.
 *
 * It is a TIEBREAKER, never a ranker: it runs only inside the existing
 * `< 0.001` score-tie branch, AFTER `positionTiebreak` (position disambiguates
 * different BOOKS in a series; duration disambiguates EDITIONS of one book) and
 * BEFORE the year tiebreaker.
 *
 * The whole duration/units decision is delegated to `isDurationVerified` →
 * `withinDurationTolerance` — no new predicate, no new tolerance constant, no
 * re-derived minutes→seconds conversion (the DRY mandate that keeps the tiebreak
 * judging with the same ruler as the post-match verdict, so pick and verdict
 * cannot disagree). Four-state contract, all falling out of the two booleans:
 *  - Invalid `scannedSeconds` (undefined/0/negative) → `isDurationVerified` is
 *    false on both sides → `0` (whole comparator no-ops; absent scan cannot
 *    decide, the #1850 "absent must not demote" doctrine).
 *  - Valid scan: a VERIFIED candidate beats a NON-VERIFIED one. "Non-verified"
 *    folds together missing/zero AND present-but-off candidate duration —
 *    `isDurationVerified` returns false for all of them.
 *  - verified vs verified → `0` (both agree, nothing to decide).
 *  - non-verified vs non-verified → `0` (absence/disagreement never demotes one
 *    non-match below another).
 */
export function durationTiebreak(a: BookMetadata, b: BookMetadata, scannedSeconds: number | undefined): number {
  const aMatch = isDurationVerified(a, scannedSeconds) ? 1 : 0;
  const bMatch = isDurationVerified(b, scannedSeconds) ? 1 : 0;
  return bMatch - aMatch;
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
 * Tiebreakers (score tie within 0.001), in precedence order: the shared
 * `positionTiebreak` (#1849) runs first — series position is the stronger
 * series-disambiguation signal — then `durationTiebreak` (#1882) prefers the
 * sibling edition whose runtime agrees with the scanned duration, then the year
 * tiebreaker (#995): candidates whose publishedDate year matches tagYear rank
 * first. Position/year are tag-derived only; folder year is NOT consulted here
 * (Pass 2's signal stays out of Pass 1). `scannedSeconds` is the unrounded
 * scanner runtime in SECONDS; it is optional so direct/backward-compatible
 * callers (unit tests) may omit it — the comparator no-ops on an absent scan.
 */
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
      // Series position is the stronger series-disambiguation signal (#1849),
      // so it runs before the year tiebreaker; when positions tie or the wanted
      // position is absent it no-ops and year decides exactly as before.
      const posCmp = positionTiebreak(a.meta, b.meta, tagQuery.seriesPosition);
      if (posCmp !== 0) return posCmp;
      // Edition disambiguation (#1882): after position, prefer the sibling whose
      // runtime agrees with the scan; no-ops on an absent/zero scan.
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

/**
 * Scores and ranks results by title+author similarity. On a score tie the
 * precedence is `positionTiebreak` (#1849) → `durationTiebreak` (#1882) →
 * folder-year. `scannedSeconds` is the unrounded scanner runtime in SECONDS and
 * is optional: the folder scan can be absent, so an undefined value no-ops the
 * duration comparator (direct unit-test callers may omit it too).
 */
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
      // Position agreement (#1849) outranks the folder-year tiebreaker; it
      // no-ops when the wanted position is absent so year decides as before.
      const posCmp = positionTiebreak(a.meta, b.meta, book.seriesPosition);
      if (posCmp !== 0) return posCmp;
      // Edition disambiguation (#1882): after position, prefer the sibling whose
      // runtime agrees with the scan; no-ops on an absent/zero scan.
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
 * Delegates the signal-presence AND match decision to the shared core
 * `compareNarratorSignals` predicate (#1652) so the file side and the primitive
 * can no longer disagree about emptiness: a punctuation-only narrator (`'-'`
 * vs `'.'`) normalizes to no usable signal on both sides → `'no-signal'` → no
 * cap, NOT a spurious mismatch. Spelling/punctuation variants at or above the
 * `0.8` dice threshold are `'match'` (no cap); an absent file tag or an edition
 * with no usable `narrators` is `'no-signal'` (no cap). Only a genuine
 * `'mismatch'` returns a user-facing reason. Exported for direct unit tests.
 */
export function narratorMismatchReason(
  fileNarratorRaw: string | undefined,
  editionNarrators: string[] | undefined,
): string | null {
  if (compareNarratorSignals(fileNarratorRaw, editionNarrators) !== 'mismatch') return null;
  const editions = (editionNarrators ?? []).map(n => n.trim()).filter(n => n.length > 0);
  return `Narrator mismatch — file: ${(fileNarratorRaw ?? '').trim()} · matched edition: ${editions.join(', ')}`;
}

/**
 * Explicit context the cap needs to emit its observability log (#1652). The
 * `MatchResult` alone carries no `matchSource`/`durationVerified` — those live
 * branch-locally at the call site, so the caller threads them in here.
 */
export interface NarratorCapContext {
  log: FastifyBaseLogger;
  matchSource: MatchSource;
  /** True when the scanned runtime independently corroborated the chosen edition (the `/import-uat` signal). */
  durationVerified: boolean;
}

/**
 * Central post-outcome narrator clamp (#1650). Applied to the *resolved*
 * `{ confidence, reason }` of every high-confidence match outcome — both passes,
 * including the tag ASIN kill-shot — so no high-confidence branch can slip past
 * it. Only ever downgrades `high → medium`; never promotes, and never overrides
 * an existing duration/attempt cap (a result already at `medium`/`none` is left
 * untouched). Fires even when duration verified the match — narrator is the
 * discriminator duration lacks, so it must not be bypassed by `isDurationVerified`.
 *
 * On an actual `high → medium` demotion it emits a single observability log
 * (#1652) carrying the book identity, the file/edition narrators, the match
 * source, and whether duration corroborated the edition — the instrument the
 * next `/import-uat` run reads. The log fires ONLY on the transition, never on
 * the no-op/non-high/no-signal paths above.
 */
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
