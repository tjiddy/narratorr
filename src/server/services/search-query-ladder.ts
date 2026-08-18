/**
 * Maps shared title variants into a query ladder with an auto-grab corroboration floor.
 * Pure: execution and all side effects belong to callers.
 */
import {
  titleVariants,
  titleSegments,
  normalizeTitleForVariantMatch,
  hasDegenerateFullForm,
  type Variant,
} from '@core/utils/title-variants.js';
import type { SearchResult } from '@core/index.js';
import { buildSearchQuery, cleanIndexerQuery, cleanIndexerQueryKeepingApostrophes } from './indexer-query.js';

// Hard per-book query budget: there is no client-side indexer rate limiter.
// Author-on variants fill first, so reaching the cap intentionally truncates the author-off tail.
export const MAX_SEARCH_RUNGS = 8;

/**
 * `author` controls the Newznab/Torznab transport filter; ranking keeps canonical
 * author context separately. `segments` records transported terms for disclosure,
 * never corroboration—flooring a rung on its own query would be circular (#2133).
 */
export interface Rung {
  query: string;
  /**
   * The same query with apostrophes kept, for the one adapter that cannot match a de-apostrophized
   * token (#2422). Required, so a hand-built envelope cannot silently carry `undefined` into a
   * request URL. Casing is inherited from each rung's own source, never imposed.
   */
  queryWithApostrophes: string;
  author: string | undefined;
  variant: Variant | null;
  segments: string[];
  // Canonical first/last anchors with multiplicity; empty on rung 1 and full variants.
  floorSegments: string[];
}

export interface LadderInput {
  title: string;
  author?: string | undefined;
  // Rung 1 uses this verbatim; later rungs still relax the canonical title.
  query?: string | undefined;
  // Rung 1's apostrophe-bearing source. Absent, rung 1 derives it from title and author (#2422).
  queryWithApostrophes?: string | undefined;
}

// First occurrence wins. Normalization collapses rung 1 onto an equivalent full
// variant while the author bit preserves transport-distinct queries.
// Deliberately blind to `queryWithApostrophes`: keying on it would split rung 1 from
// the equivalent full variant and lengthen the ladder (#2422).
export function rungDedupKey(rung: Rung): string {
  return `${normalizeTitleForVariantMatch(rung.query)}|${rung.author !== undefined ? '1' : '0'}`;
}

// Both canonical and release sides must use this exact reduction. Mixing the
// segmenter with scalar-only normalization can make a title fail its own floor.
function effectiveSegments(title: string): string[] {
  return titleSegments(title).map(normalizeTitleForVariantMatch).filter((segment) => segment.length > 0);
}

function effectiveText(title: string): string {
  return effectiveSegments(title).join(' ');
}

// Count non-overlapping, space-bounded matches. Restart at the trailing delimiter
// so adjacent occurrences sharing one space both count; use this on both sides.
function countOccurrences(text: string, segment: string): number {
  const haystack = ` ${text} `;
  const needle = ` ${segment} `;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + segment.length + 1;
  }
}

// Use distinct first/last canonical anchors, repeated with canonical multiplicity.
// Counting positions would over-demand identical ends; one-each would under-demand
// anchors repeated elsewhere. Fewer than two effective segments has no cut floor.
function anchorFloor(segments: string[]): string[] {
  const first = segments[0];
  const last = segments[segments.length - 1];
  if (segments.length < 2 || first === undefined || last === undefined) return [];

  const canonicalText = segments.join(' ');
  const floor: string[] = [];
  for (const anchor of first === last ? [first] : [first, last]) {
    for (let i = countOccurrences(canonicalText, anchor); i > 0; i--) floor.push(anchor);
  }
  return floor;
}

function retainedSlice(tag: Variant['tag'], segments: string[]): string[] | null {
  if (tag === 'first+last') {
    const last = segments[segments.length - 1];
    if (segments.length < 2 || segments[0] === undefined || last === undefined) return null;
    return [segments[0], last];
  }
  const match = /^(prefix|suffix)\((\d+)\)$/.exec(tag);
  if (!match) return null;
  const n = Number(match[2]);
  return match[1] === 'prefix' ? segments.slice(0, n) : segments.slice(segments.length - n);
}

// These shapes can retain the strongest identity while missing the count budget.
// Exempt by tag, not slice: first-wins dedup may assign identical tail text to
// prefix(1), which must stay suppressed. Normalization-empty slices still fail.
function isBudgetExempt(tag: Variant['tag']): boolean {
  return tag === 'first+last' || tag === 'suffix(1)';
}

// Full variants are unconditional. Cuts reject normalization-empty slices, then
// require half the effective segments unless tag-exempt. Every admitted cut gets
// one canonical anchor floor; transported segments never become corroboration.
function admitVariants(title: string): {
  admitted: Array<{ variant: Variant; segments: string[] }>;
  floorSegments: string[];
} {
  const effective = titleSegments(title).map(normalizeTitleForVariantMatch);
  const nonEmpty = effective.filter((s) => s.length > 0);
  const budget = Math.ceil(nonEmpty.length / 2);

  const admitted: Array<{ variant: Variant; segments: string[] }> = [];
  for (const variant of titleVariants(title)) {
    if (variant.tag === 'full') {
      admitted.push({ variant, segments: [] });
      continue;
    }
    const slice = retainedSlice(variant.tag, effective);
    if (!slice || slice.length === 0) continue;
    if (slice.some((segment) => segment.length === 0)) continue;
    if (!isBudgetExempt(variant.tag) && slice.length < budget) continue;
    admitted.push({ variant, segments: slice });
  }
  return { admitted, floorSegments: anchorFloor(nonEmpty) };
}

// Keep rung 1 byte-for-byte. Relaxations are author-major because dropping the
// transport author is the larger relaxation. Never relax a degenerate ASCII fold:
// non-Latin distinguishing text can otherwise collapse to a franchise-only query.
export function buildQueryLadder(input: LadderInput): Rung[] {
  const { title, author } = input;
  const rung1: Rung = {
    query: input.query ?? buildSearchQuery({ title, ...(author !== undefined && { authors: [{ name: author }] }) }),
    // Prefer the caller's own query text over re-deriving from title+author, so a custom-query
    // caller sends ABB the same rung-1 text as every other indexer instead of relying on the two
    // constructions happening to agree. Identical output for every current caller.
    queryWithApostrophes: cleanIndexerQueryKeepingApostrophes(
      input.queryWithApostrophes ?? input.query ?? [title, author].filter(Boolean).join(' '),
    ),
    author,
    variant: null,
    segments: [],
    floorSegments: [],
  };

  const ladder: Rung[] = [rung1];
  if (hasDegenerateFullForm(title)) return ladder;

  const seen = new Set([rungDedupKey(rung1)]);
  const { admitted, floorSegments } = admitVariants(title);

  for (const rungAuthor of [author, undefined]) {
    for (const { variant, segments } of admitted) {
      if (ladder.length >= MAX_SEARCH_RUNGS) return ladder;
      const rung: Rung = {
        query: cleanIndexerQuery([variant.raw, rungAuthor].filter(Boolean).join(' ')),
        // `variant.raw` is lowercase and `rungAuthor` is not; both fields inherit that mixed shape.
        queryWithApostrophes: cleanIndexerQueryKeepingApostrophes([variant.raw, rungAuthor].filter(Boolean).join(' ')),
        author: rungAuthor,
        variant,
        segments,
        floorSegments: variant.tag === 'full' ? [] : floorSegments,
      };
      const key = rungDedupKey(rung);
      if (seen.has(key)) continue;
      seen.add(key);
      ladder.push(rung);
    }
  }
  return ladder;
}

// Compare the canonical floor multiset, never transported segments (#2133).
// Each anchor must occur contiguously and space-bounded with canonical multiplicity
// in the identically reduced parsed release title. Reject lossy release folds too:
// erased distinguishing characters can otherwise create false identity matches.
// Dice cannot substitute: measured true-positive 0.444 versus wrong-book 0.453.
export function passesSegmentFloor(parsedReleaseTitle: string, rung: Rung): boolean {
  if (rung.floorSegments.length === 0) return true;
  if (hasDegenerateFullForm(parsedReleaseTitle)) return false;

  const demanded = new Map<string, number>();
  for (const segment of rung.floorSegments) demanded.set(segment, (demanded.get(segment) ?? 0) + 1);

  const releaseText = effectiveText(parsedReleaseTitle);
  for (const [segment, count] of demanded) {
    if (countOccurrences(releaseText, segment) < count) return false;
  }
  return true;
}

export type RelaxedSelection =
  | { kind: 'grab'; result: SearchResult }
  | { kind: 'hold'; releaseTitle: string }
  | { kind: 'none' };

// Shared after ranking so auto-grab paths cannot drift. Ignore nondownloadable
// results; full rungs grab the top eligible result, cuts grab the highest-ranked
// floor pass, and hold names the top result only when every eligible result fails.
export function selectRelaxedCandidate(ranked: SearchResult[], rung: Rung): RelaxedSelection {
  const eligible = ranked.filter((r) => r.downloadUrl);
  const top = eligible[0];
  if (!top) return { kind: 'none' };
  if (rung.variant === null || rung.variant.tag === 'full') return { kind: 'grab', result: top };

  const passing = eligible.find((r) => passesSegmentFloor(r.title, rung));
  if (passing) return { kind: 'grab', result: passing };
  return { kind: 'hold', releaseTitle: top.title };
}

export interface RungExecution {
  results: SearchResult[];
  /** Indexers that resolved successfully. Zero means an outage, not a zero. */
  succeeded: number;
}

export interface LadderRun {
  rung: Rung;
  index: number;
  results: SearchResult[];
  /** True only when EVERY rung ran and each returned a genuine, answered zero. */
  exhausted: boolean;
}

// Aggregate search collapses outages and answered-zero into []; succeeded separates
// them. Advance only after an answered zero, abort outages without cooldown, and
// report exhaustion only after every rung returned an answered zero.
export async function runQueryLadder(
  ladder: Rung[],
  execute: (rung: Rung, index: number) => Promise<RungExecution>,
): Promise<LadderRun> {
  let index = 0;
  for (; index < ladder.length; index++) {
    const rung = ladder[index]!;
    const { results, succeeded } = await execute(rung, index);
    if (succeeded === 0) return { rung, index, results: [], exhausted: false };
    if (results.length > 0) return { rung, index, results, exhausted: false };
  }
  const lastIndex = ladder.length - 1;
  return { rung: ladder[lastIndex]!, index: lastIndex, results: [], exhausted: true };
}
