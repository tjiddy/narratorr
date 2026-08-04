/**
 * Progressive query relaxation (#2104) — the THIN POLICY layer over the shared
 * title-variant generator (#2096).
 *
 * The release search builds exactly one query shape (full canonical title +
 * primary author) and indexer engines AND every token, so a canonical title
 * carrying franchise segments, subtitles or parenthetical annotations returns
 * zero on titles whose releases are named more loosely. Zero is terminal on
 * every surface. This module maps the generator's tagged variants onto an
 * ordered ladder of queries, and supplies the corroboration floor an auto-grab
 * path needs before it trusts a segment-cut rung.
 *
 * PURE: no I/O, no clock, no randomness. Execution is injected
 * ({@link runQueryLadder}) and every side effect (cooldown, held event, rung
 * disclosure) belongs to the caller. It lives server-side rather than in
 * `src/core/**` because it needs `cleanIndexerQuery` — a server module — and
 * `src/core/**` may not import `src/server/**`; all five search surfaces are
 * server-side, so a server home still satisfies "one home".
 */
import {
  titleVariants,
  titleSegments,
  normalizeTitleForVariantMatch,
  hasDegenerateFullForm,
  type Variant,
} from '@core/utils/title-variants.js';
import type { SearchResult } from '@core/index.js';
import { buildSearchQuery, cleanIndexerQuery } from './indexer-query.js';

/**
 * Rung 1 plus at most seven relaxed rungs.
 *
 * 8 is exactly the author-ON / author-OFF pairing of the four variants a
 * 3-segment franchise title yields under the segment budget — the deepest live
 * shape. There is NO client-side indexer rate limiter, so this constant is the
 * only protection against MAM's server-side limit; the exhaustion cooldown
 * (`search-ladder-cooldown.ts`) is the second. Do not raise it without one.
 */
export const MAX_SEARCH_RUNGS = 8;

/**
 * One query the ladder may issue.
 *
 * `author` is the TRANSPORT filter — Newznab/Torznab emit it as `author=`, so an
 * author-dropping rung must pass `undefined` or it is inert on exactly the
 * publisher-as-author cases it exists to fix. Ranking context stays canonical on
 * every rung via `SearchOptions.rankingAuthor` (#1015 transport/ranking split).
 *
 * `variant` is `null` and `segments` is `[]` on rung 1 — the canonical query is
 * not a relaxation and is never floored. On a relaxed rung `segments` holds the
 * variant's RETAINED segments, normalized and provably all non-empty, with
 * `segments.join(' ') === variant.raw` exact by construction.
 *
 * `segments` is the TRANSPORT record — what this rung actually carried into the
 * query — and is the disclosure/debug view, nothing more. It is deliberately NOT
 * the corroboration floor: a prefix rung's retained segments ARE its query, and
 * every result of an AND-semantics indexer search contains its own query terms,
 * so flooring a rung on its own retained set is circular (#2133). The floor is
 * {@link Rung.floorSegments}, derived from the CANONICAL title and identical on
 * every segment-cut rung of that title. `Rung` is internal — nothing serializes
 * it — so the extra field is not an API surface.
 */
export interface Rung {
  query: string;
  author: string | undefined;
  variant: Variant | null;
  segments: string[];
  /**
   * The corroboration floor: the canonical title's first and last effective
   * segments, each repeated as many times as it occurs in the canonical title's
   * own effective text (#2133 AC3). Empty on rung 1 and on `full` rungs, which
   * are never floored; identical across every segment-cut rung of one title,
   * whatever that rung transported. NOT bounded to two or three entries —
   * `"Alpha: Beta Gamma: Gamma"` already yields three.
   */
  floorSegments: string[];
}

export interface LadderInput {
  /** The book's CANONICAL title — the string every relaxed rung relaxes. */
  title: string;
  /** The book's primary author, or undefined. */
  author?: string | undefined;
  /**
   * Rung-1 transport query override. The Search Releases modal prefills an
   * editable query and the user may change it before searching; rung 1 is then
   * their string verbatim while relaxed rungs still relax the canonical title
   * (#2104 D13). Omit and rung 1 is `buildSearchQuery` over title + author.
   */
  query?: string | undefined;
}

/**
 * The dedup key: normalized query text plus the author on/off bit, first
 * occurrence winning.
 *
 * Normalizing the key (rather than comparing raw query strings) is what makes
 * rung 1's `buildSearchQuery` output collapse onto the generator's `full`
 * variant — they differ in case and in the `&` → "and" fold but are the same
 * search. That collapse is what delivers the guarantee that a colon-free,
 * paren-free title costs at most ONE extra rung.
 */
export function rungDedupKey(rung: Rung): string {
  return `${normalizeTitleForVariantMatch(rung.query)}|${rung.author !== undefined ? '1' : '0'}`;
}

/**
 * The ONE reduction both sides of every floor comparison go through (#2133 AC0):
 * `titleSegments` → the scalar normalizer per segment → drop empties.
 *
 * The symmetry is load-bearing, not stylistic. `titleSegments` strips generic
 * `(...)`/`[...]` groups before segmenting while `normalizeTitleForVariantMatch`
 * deliberately KEEPS parenthetical content, so deriving anchors on one axis and
 * evaluating releases on the other breaks a book's own title:
 * `"Star (Deluxe) Wars: Haunted Starlight"` anchors on `star wars`, its own
 * release normalizes (scalar-only) to `star deluxe wars haunted starlight`, and
 * the anchor is not contiguous — the book holds on its own release. One axis,
 * both sides.
 */
function effectiveSegments(title: string): string[] {
  return titleSegments(title).map(normalizeTitleForVariantMatch).filter((segment) => segment.length > 0);
}

/** {@link effectiveSegments} joined — the text occurrences are counted in. */
function effectiveText(title: string): string {
  return effectiveSegments(title).join(' ');
}

/**
 * Non-overlapping, space-bounded occurrences of `segment` in `text`.
 *
 * Each scan restarts at the match's TRAILING delimiter (`at + length + 1`), so
 * two adjacent occurrences SHARE one space and `"star wars star wars"` counts 2.
 * Restarting past that space instead counts 1, which makes a title whose two
 * anchors collapse (`"Star Wars: The High Republic: Star Wars"`) fail its own
 * floor. Self-overlapping segments count conservatively — `"a a a"` yields 1 for
 * `"a a"` — which errs toward `hold`.
 *
 * The SAME function derives the required counts (over the canonical text) and
 * evaluates them (over the release text), so the two sides cannot drift.
 */
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

/**
 * The floor every segment-cut rung of one title carries (#2133 AC3).
 *
 * The anchors are the canonical title's FIRST and LAST effective segments — its
 * two identity-bearing ends. Built over the DISTINCT anchor values, first then
 * last, each appended as many times as it occurs in the canonical title's own
 * effective text. Both halves of that are load-bearing:
 *
 *  - **Distinct values, not positions.** `"Star Wars: The High Republic:
 *    Star Wars"` has ONE distinct anchor occurring twice, so the floor is two
 *    copies. A positional reading would emit four and hold the book's own title.
 *  - **Canonical multiplicity, not one-each.** An anchor demanded once is
 *    worthless whenever the canonical title already carries that text elsewhere:
 *    for `"Alpha: Beta Gamma: Gamma"` the retained segment `beta gamma` supplies
 *    a space-bounded `gamma` all by itself, so the `prefix(2)` query clears a
 *    one-each floor from its own tokens — and so does the sibling
 *    `"Alpha: Beta Gamma: Delta"`.
 *
 * Empty below two effective segments, where no segment cut is admitted anyway
 * (a `prefix(1)`/`suffix(1)` at n === the segment count dedups onto `full`).
 */
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

/**
 * The retained slice a segment-cut tag names, as indices into the effective
 * segment list. Returns null for tags that are not segment cuts.
 */
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

/**
 * Which variants may become rungs, plus the ONE floor they all share.
 *
 * The budget decides ADMISSION — which queries the ladder issues — and #2133
 * deliberately leaves it alone: `prefix(2)` still enters and still gets issued.
 * What changed is what corroborates a grab from it. The budget was written to
 * suppress "exactly the pure-franchise rung", but a segment COUNT conflates
 * "retained half the segments" with "retained the identity": on a 3-segment
 * title whose first TWO segments are franchise, `prefix(2)` clears the count
 * carrying zero distinguishing power. {@link anchorFloor} is what now answers
 * that, and it is derived from the canonical title once, here, so every admitted
 * cut of one title carries a byte-identical floor.
 *
 * Segments are counted in exactly ONE representation — normalized and
 * empty-dropped — on BOTH sides of the comparison. Raw segment text is never
 * counted: `colonSegments` keeps any segment with non-whitespace content,
 * including punctuation-only text like `---`, which the normalizer then erases.
 *
 * Two steps:
 *
 *  1. **Reject any slice containing a normalization-empty segment.** Without
 *     this a slice could satisfy the COUNT while contributing fewer real
 *     constraints to the floor. Verified: for
 *     `"Star Wars: ---: The High Republic: Haunted Starlight"` the generator
 *     emits `prefix(2)` with `raw = "star wars"`; under a raw count it satisfied
 *     `ceil(4/2)` and its floor collapsed to `["star wars"]`, which
 *     `"Star Wars: Cataclysm"` passes — exactly the pure-franchise rung the
 *     budget exists to suppress. Step 1 also binds `first+last`, whose exemption
 *     from step 2 would otherwise let `"---: Alpha: Beta: Gamma"` admit a
 *     one-element floor `["gamma"]`.
 *  2. `n = slice.length`, which now provably equals the count of the slice's
 *     EFFECTIVE segments, and the variant enters iff `n >= ceil(count / 2)` — or
 *     its tag is `first+last`. That exemption is deliberate: on a 5-segment
 *     franchise title `first+last` retains 2 against a budget of 3, and it is
 *     the shape the deep-franchise live example needs.
 *
 * A `full` variant (either `parensStripped`) is unconditional and never floored.
 */
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
    if (slice.some((segment) => segment.length === 0)) continue; // step 1
    if (variant.tag !== 'first+last' && slice.length < budget) continue; // step 2
    admitted.push({ variant, segments: slice });
  }
  // `nonEmpty` IS `effectiveSegments(title)`, so the floor reuses the raw-vs-
  // normalized decision recorded above rather than introducing a second axis.
  return { admitted, floorSegments: anchorFloor(nonEmpty) };
}

/**
 * The ordered, deduped, capped ladder for one book.
 *
 * Rung 1 is today's canonical query verbatim, so a book findable at rung 1 never
 * fires the ladder and issues byte-identically the query it issued before.
 *
 * Order is AUTHOR-MAJOR: all author-ON rungs in generator-variant order, then
 * all author-OFF rungs in the same order. Dropping the author removes the
 * `author=` transport filter entirely and is a larger relaxation than cutting
 * one colon segment, so author-major is the correct "most-specific first"
 * reading. It also reaches every live example inside four rungs.
 *
 * A title with a DEGENERATE full form runs rung 1 only: the generator's `raw`
 * text is ASCII-folded, so a non-Latin title's variants collapse to their
 * franchise prefix (`"World of Warcraft: Перед бурей"` → `world of warcraft`)
 * and every relaxed rung would be a franchise-wide query. The per-variant
 * `lossy` flag (#2110) is deliberately NOT consulted: it can only be true when
 * some character fails the ASCII fold, so a title that reaches the relaxed rungs
 * at all has already proved every one of its slices non-lossy.
 */
export function buildQueryLadder(input: LadderInput): Rung[] {
  const { title, author } = input;
  const rung1: Rung = {
    query: input.query ?? buildSearchQuery({ title, ...(author !== undefined && { authors: [{ name: author }] }) }),
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

/**
 * Does a parsed release title corroborate a segment-cut rung?
 *
 * {@link Rung.floorSegments} is the ONLY input read — never `segments`, which is
 * what this rung transported and would make the test circular (#2133). The floor
 * is treated as a MULTISET: each distinct entry must appear in the reduced
 * release text at least as many times as the floor carries copies of it, each
 * occurrence CONTIGUOUS and space-bounded. Their relative order is not required.
 *
 * Contiguity is the point — it is what makes this genuine corroboration rather
 * than a token-scatter test. A non-contiguous ordered walk admits
 * `"Star Wars: Haunted Totally Different Starlight"` against anchors
 * `["star wars", "haunted starlight"]`; whole-string containment of
 * `variant.raw` false-negatives the book's OWN canonical title. Per-anchor
 * contiguous containment is the only shape that gets both right, and it is why a
 * rung whose query happens to BE the anchor text is still a real test.
 *
 * A whole-string dice floor provably cannot substitute: the measured true
 * positive `"The Churn"` vs `"The Churn: An Expanse Novella"` scores 0.444 while
 * the wrong book `"The Expanse: Nemesis Games"` scores 0.453.
 *
 * An empty floor short-circuits true — that is rung 1 and every `full` rung, and
 * nothing else: a surviving `prefix(n)` / `suffix(n)` at n === the segment count
 * dedups onto `full` by construction, and a title with fewer than two effective
 * segments admits no cut at all. Runs on the PARSED title (`parseReleaseNames`
 * rewrites `result.title` from the raw release name before ranking), reduced
 * through {@link effectiveText} — the same axis the anchors came from, NOT the
 * scalar normalizer alone, which keeps parenthetical content and would fail a
 * book's own paren-intact release against its own floor (AC0).
 *
 * **The character-survival gate is TWO-SIDED.** `buildQueryLadder` already
 * refuses to relax a canonical title whose distinguishing characters the ASCII
 * fold erases; the OFFERED release needs the same refusal, and for the same
 * reason. The anchors are ASCII by construction, so a lossy release can supply
 * them out of what merely SURVIVED the fold and wear the wanted book's identity:
 * for a canonical `"World of Warcraft: A"`, the different books
 * `"World of Warcraft: A前夜"` and `"World of Warcraft: A後夜"` both reduce to
 * `world of warcraft a` and clear the floor. That is the mixed-token collision
 * `degenerate-full-form-under-lossy-fold` names (#2103/#2110) one layer down —
 * partial loss is loss, so the question is asked at CHARACTER granularity by
 * `hasDegenerateFullForm`, not of the structure and not of the tokens.
 *
 * The gate runs on the RAW release title, deliberately matching the canonical
 * side's own call rather than the floor's paren-stripped axis: a release naming
 * the wanted book only alongside erased content is not identity evidence either.
 * It costs a book nothing at rung 1 or on a `full` rung (both short-circuit
 * above), and the failure direction is the safe one this whole module takes — a
 * false refusal costs a surfaced hold, a false pass costs the wrong book.
 */
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

/** What an auto-grab path should do with a winning rung's ranked results. */
export type RelaxedSelection =
  | { kind: 'grab'; result: SearchResult }
  | { kind: 'hold'; releaseTitle: string }
  | { kind: 'none' };

/**
 * Candidate selection on a winning rung — the SHARED decision every auto-grab
 * path routes through, so the scheduled pipeline and the retry path cannot
 * drift on floor policy.
 *
 * Runs AFTER the existing gate chain and canonical ranking, never before, and
 * takes no event dependency: callers record the held event with their own deps.
 *
 * The eligible population is the ranked post-gate results that have a
 * `downloadUrl`. A result without one can never be grabbed on any path today, so
 * it is not a floor outcome either way — it is never named in a held event and
 * never suppresses the grab of a lower-ranked downloadable candidate.
 *
 * Exhaustive over floor-pass × downloadability × emptiness:
 *
 * | State | Result |
 * |---|---|
 * | eligible population empty | `none` — nothing was grabbable regardless of the floor, so this is NOT a floor rejection and records no event |
 * | rung tag is `full` | `grab` the top eligible result; the floor never runs |
 * | some eligible result passes | `grab` the highest-ranked passing one, even past a higher-ranked failure |
 * | every eligible result fails | `hold`, naming the top one — which by construction failed |
 *
 * Because `hold` is scalar and fires only in the last row, the named release
 * always exists and always genuinely failed.
 *
 * Unchanged by #2133 and deliberately so: no rung is hold-only by tag and none
 * is exempted by tag. What a segment-cut rung must corroborate moved from its
 * own retained set to {@link Rung.floorSegments}; WHICH rungs are floored, and
 * what happens when one fails, did not.
 */
export function selectRelaxedCandidate(ranked: SearchResult[], rung: Rung): RelaxedSelection {
  const eligible = ranked.filter((r) => r.downloadUrl);
  const top = eligible[0];
  if (!top) return { kind: 'none' };
  if (rung.variant === null || rung.variant.tag === 'full') return { kind: 'grab', result: top };

  const passing = eligible.find((r) => passesSegmentFloor(r.title, rung));
  if (passing) return { kind: 'grab', result: passing };
  return { kind: 'hold', releaseTitle: top.title };
}

/** One rung's settled search: the aggregate results and how many indexers ANSWERED. */
export interface RungExecution {
  results: SearchResult[];
  /** Indexers that resolved successfully. Zero means an outage, not a zero. */
  succeeded: number;
}

/** Which rung produced the ladder's outcome, and whether it ran to exhaustion. */
export interface LadderRun {
  rung: Rung;
  /** Index of {@link rung} in the ladder — 0 means rung 1 answered. */
  index: number;
  results: SearchResult[];
  /** True only when EVERY rung ran and each returned a genuine, answered zero. */
  exhausted: boolean;
}

/**
 * Walk the ladder, stopping at the first non-empty rung.
 *
 * Both aggregate search methods collapse rejected indexers into `[]`, so "empty"
 * cannot be distinguished from "everything failed" without the settlement counts
 * — and the ladder must not burn eight queries and a 24-hour cooldown during an
 * outage. Hence three rules:
 *
 *  - **Advance** only when `succeeded > 0 && results.length === 0` — a real,
 *    answered zero.
 *  - **Abort** immediately when `succeeded === 0`, even on rung 1, returning the
 *    empty result set with `exhausted: false` so no cooldown is recorded.
 *  - **Exhaustion** is reported only when the ladder ran to its end with every
 *    rung a genuine zero.
 *
 * Indexers that merely errored on one rung are re-queried on the next; only
 * cancelled ones are skipped, by the pre-adapter abort guard in
 * `searchAllStreaming`.
 */
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
