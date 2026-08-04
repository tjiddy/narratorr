import { titleVariants, hasDegenerateFullForm, normalizeTitleLosslessly } from '@core/utils/title-variants.js';
// The TYPE comes straight from its canonical shared home, not through core's
// re-export. `src/server/**` may import `src/shared/**`, and taking the type
// from the source keeps core's public `Variant` / `VariantTag` re-export free of
// production consumers — which is what lets the drift guards in
// `series-title-variants.test.ts` be the SOLE failing observation when one of
// those exported names drifts (they would otherwise be masked by an error here).
import type { TitlePairArm, TitlePairVerdict, Variant } from '@shared/schemas/series-title-variants.js';

/** Floating-point tolerance for matching series_position values across sources. */
export const POSITION_MATCH_EPSILON = 1e-9;

/**
 * Normalize a member work title for "In Library" matching across Hardcover and
 * Audible naming variants.
 *
 * Re-export of the ONE implementation, which lives in
 * `src/core/utils/title-variants.ts` beside the variant generator that consumes
 * it (`src/core/**` may not import `src/server/**`, so a server-homed normalizer
 * would be unreachable from the generator and force a duplicate). Kept under this
 * name so the four existing production call sites — `book-series-link.ts:65,193,206`
 * and `series-card.service.ts` — keep importing it from here unchanged.
 *
 * Since #2096 a `:` is a SEPARATOR, not a truncation point, and the generic
 * parenthetical strip has moved to the derived variant axis. The audio-edition
 * tail strip stays scalar — see the note on the core function.
 */
export { normalizeTitleForVariantMatch as normalizeMemberTitleForMatch } from '@core/utils/title-variants.js';

export interface LibraryBookSummary {
  id: number;
  title: string;
  seriesPosition: number | null;
}

export interface HardcoverMemberSummary {
  title: string;
  position: number | null;
}

/**
 * Bounded memo over `titleVariants`, keyed on the RAW title.
 *
 * `findInLibraryMatch` re-derives every candidate's variants on every call and
 * both callers invoke it once per member — O(members × candidates) derivations,
 * and the persist path holds a transaction open while it runs. Variant
 * generation is strictly more expensive than the scalar normalize it replaced,
 * so the repeated candidate work is memoized. Purity is unaffected:
 * `titleVariants` is a pure function of its input, so a cache hit and a miss are
 * observationally identical. The cache is cleared wholesale rather than evicted
 * one key at a time — a library's title set is small and bounded, the reset is
 * O(1), and no call depends on a prior entry surviving.
 *
 * Two independently breakable branches, each with its own test in
 * `series-title-match.test.ts` ("memoization"): the HIT branch (delete it and
 * matching silently regresses to O(members × candidates) derivations inside the
 * persistence transaction) and the BOUND branch (delete it and the module-level
 * map grows without limit for the process lifetime). Neither is observable
 * through pairing results — a cache hit and a miss return equal values — so both
 * are observed by counting derivations through a spy on `titleVariants`.
 */

/**
 * Entry ceiling: the memo is cleared wholesale on the insertion that would take
 * it past this. Exported as the bounded-cache contract so the reset test can
 * drive the transition without hard-coding the number in two places.
 */
export const VARIANT_CACHE_MAX = 4096;

/** One title's derived matching state — variants, degeneracy, and lossless identity text. */
interface TitleShape {
  variants: Variant[];
  degenerateFull: boolean;
  /** Unicode-preserving normalization, used as identity evidence for a degenerate side. */
  lossless: string;
}

const variantCache = new Map<string, TitleShape>();

/** Derive a title's matching state from the three pure core functions. */
function titleShape(title: string): TitleShape {
  return {
    variants: titleVariants(title),
    degenerateFull: hasDegenerateFullForm(title),
    lossless: normalizeTitleLosslessly(title),
  };
}

function cachedTitleShape(title: string): TitleShape {
  const hit = variantCache.get(title);
  if (hit) return hit;
  const computed = titleShape(title);
  if (variantCache.size >= VARIANT_CACHE_MAX) variantCache.clear();
  variantCache.set(title, computed);
  return computed;
}

/** The FULL form — `{ tag: 'full', parensStripped: false }` — or `''` when the set is empty. */
function fullForm(variants: readonly Variant[]): string {
  return variants.find((v) => v.tag === 'full' && !v.parensStripped)?.raw ?? '';
}

/** Every variant that is NOT the FULL form: prefix / suffix / first+last / paren-stripped. */
function isDerived(variant: Variant): boolean {
  return variant.tag !== 'full' || variant.parensStripped;
}

/** How a FULL form appears inside a `reason`. `''` is a real, load-bearing value, so it is NAMED. */
function renderFull(full: string): string {
  return full.length === 0 ? '(empty)' : `"${full}"`;
}

/**
 * The first non-lossy DERIVED variant of `offering` that equals `target`'s FULL
 * form — or `undefined` when the arm does not apply.
 *
 * TWO independent character-survival gates, and neither subsumes the other:
 *
 *  - `target.degenerateFull` gates the TARGET side. The arm's safety rests on
 *    that side being the COMPLETE title; when the fold has reduced it to a bare
 *    franchise prefix, every sibling's `prefix(1)` matches it.
 *  - `!v.lossy` gates the OFFERING side. Same lesson, applied one level down: a
 *    fragment whose own distinguishing characters the fold ate is not evidence
 *    of anything either. `"World of Warcraft: Тревелер (Traveler)"` offered
 *    `world of warcraft` and claimed a bare `"World of Warcraft"`;
 *    `"Star Wars: 前夜Thrawn"` offered `thrawn` and claimed a library
 *    `"Thrawn"`. Both are the franchise cross-match class re-entering through
 *    the variant axis rather than the full-form axis (#2110).
 *
 * The `"Sønner"`-class true positives are untouched: their offered fragments
 * lost nothing, so only the whole-title flag is set, not the slice's.
 */
function findDerivedOffer(offering: TitleShape, target: TitleShape, targetFull: string): Variant | undefined {
  if (target.degenerateFull) return undefined;
  return offering.variants.find((v) => isDerived(v) && !v.lossy && v.raw === targetFull);
}

function derivedVerdict(forms: string, variant: Variant, offeringSide: string, targetSide: string): TitlePairVerdict {
  return {
    pairs: true,
    arm: 'derived-equals-full',
    reason:
      `derived-equals-full: ${forms} — the FULL forms differ, but the ${variant.tag} variant ` +
      `"${variant.raw}" (offered by: ${offeringSide}) equals the non-degenerate FULL form of ${targetSide}`,
  };
}

/**
 * THE acceptance rule — the only place rows 1–8 exist in production code.
 * `pairTier` is a one-line ranking of its `arm` and the debug route delegates to
 * `explainTitlePairing`, so the diagnostic can never again reach the opposite
 * conclusion from the matcher (#2110). Ranking READS the arm; it never
 * redefines it, so which pairings are ACCEPTED is decided here and only here.
 *
 * Evaluated in this exact order; `arm` names the branch that decided it:
 *
 *   1. both FULL forms empty, both lossless forms non-empty and equal
 *      → `lossless-equals-lossless`, pairs
 *   2. both FULL forms empty, otherwise                → `none`
 *   3. exactly one FULL form empty                     → `none`
 *   4. FULLs equal, neither side degenerate            → `full-equals-full`, pairs
 *   5. FULLs equal, either degenerate, lossless equal  → `full-equals-full`, pairs
 *   6. FULLs equal, either degenerate, lossless differ → `none`
 *   7. FULLs differ, some non-lossy DERIVED variant of one side equals the
 *      other side's FULL form, and that other side is not degenerate
 *      → `derived-equals-full`, pairs
 *   8. otherwise                                       → `none`
 *
 * `pairs === (arm !== 'none')` for every input pair.
 *
 * Rows 4/7 are the #1891 asymmetric one-side-stripped rule generalized to
 * variant sets, and that asymmetry is the whole safety argument: derived≡derived
 * is NEVER a match, because otherwise `"Foo: A Novel"` and `"Bar: A Novel"` pair
 * on their shared `suffix(1)` and `"Star Wars: A"` pairs with `"Star Wars: B"`
 * on their shared franchise prefix. Requiring one side to be the complete title
 * means a fragment can only ever match something that IS that fragment in full.
 *
 * Rows 5/6 exist because equal FULL forms are only equal TITLES when neither
 * side is DEGENERATE (see `hasDegenerateFullForm`) — `"…: Перед бурей"`,
 * `"…: Последний страж"` and a genuinely bare `"World of Warcraft"` all reduce
 * to `world of warcraft`. When either side is degenerate the arm demands
 * non-lossy evidence: agreement under `normalizeTitleLosslessly`, which
 * preserves every script. Two NON-degenerate sides take row 4 untouched, so no
 * ASCII-titled pairing changes.
 *
 * Row 1 is the narrow non-Latin identity arm (#2110). An all-non-Latin title
 * scalar-folds to empty and yields ZERO variants, so before it two IDENTICAL
 * non-Latin titles could never title-pair — leaving the original Chapterhouse
 * symptom (a wrong '+Add' on an owned book) fully intact for non-Latin
 * libraries. It is deliberately the narrowest possible closure: exact lossless
 * equality only. There is no non-Latin fragment-to-FULL path, because row 2
 * catches `"Дюна: Капитул"` vs `"Капитул"` — both FULL forms are empty and the
 * lossless forms differ.
 *
 * SYMMETRIC for every input pair, in both `pairs` and `arm`. **Reflexive only
 * on the domain `normalizeTitleLosslessly(a) !== ''`** — titles carrying some
 * identity evidence. Outside it, row 2 refuses a self-pair, and that is
 * REQUIRED rather than tolerated: it is the same refusal that stops two
 * DIFFERENT untitled members (`'[ ]'`, `'   '`) claiming each other's books.
 * (An earlier revision of this docblock said "symmetric and reflexive" flatly,
 * which has been wrong for the empty-form case since #2096.) NON-transitive
 * either way, exactly like `titlesMatchForDedup` — never use it as a `Map`/`Set`
 * key.
 */
function explainShapePairing(a: TitleShape, b: TitleShape): TitlePairVerdict {
  const aFull = fullForm(a.variants);
  const bFull = fullForm(b.variants);
  const forms = `${renderFull(aFull)} vs ${renderFull(bFull)}`;

  if (aFull.length === 0 && bFull.length === 0) {
    if (a.lossless.length > 0 && a.lossless === b.lossless) {
      return {
        pairs: true,
        arm: 'lossless-equals-lossless',
        reason: `lossless-equals-lossless: ${forms} — both FULL forms are empty and the lossless forms are identical: "${a.lossless}"`,
      };
    }
    return {
      pairs: false,
      arm: 'none',
      reason: `no arm applies: ${forms} — both FULL forms are empty and the lossless forms are not both non-empty and equal`,
    };
  }
  if (aFull.length === 0 || bFull.length === 0) {
    return { pairs: false, arm: 'none', reason: `no arm applies: ${forms} — exactly one FULL form is empty` };
  }
  if (aFull === bFull) return explainEqualFulls(a, b, forms);

  const fromA = findDerivedOffer(a, b, bFull);
  if (fromA) return derivedVerdict(forms, fromA, 'title', 'other');
  const fromB = findDerivedOffer(b, a, aFull);
  if (fromB) return derivedVerdict(forms, fromB, 'other', 'title');
  return {
    pairs: false,
    arm: 'none',
    reason: `no arm applies: ${forms} — the FULL forms differ and no non-lossy derived variant of either side equals the other side's non-degenerate FULL form`,
  };
}

/** Rows 4-6, split out so `explainShapePairing` stays readable. */
function explainEqualFulls(a: TitleShape, b: TitleShape, forms: string): TitlePairVerdict {
  if (!a.degenerateFull && !b.degenerateFull) {
    return {
      pairs: true,
      arm: 'full-equals-full',
      reason: `full-equals-full: ${forms} — the FULL forms are equal and neither side is degenerate`,
    };
  }
  if (a.lossless === b.lossless) {
    return {
      pairs: true,
      arm: 'full-equals-full',
      reason: `full-equals-full: ${forms} — the FULL forms are equal and, a side being degenerate, the lossless forms agree: "${a.lossless}"`,
    };
  }
  return {
    pairs: false,
    arm: 'none',
    reason: `no arm applies: ${forms} — the FULL forms are equal but a side is degenerate and the lossless forms differ`,
  };
}

/**
 * Match-quality tier of an accepted pairing — the ONE place the arms are ranked.
 *
 *   EXACT   `full-equals-full`, `lossless-equals-lossless` — both sides are the
 *           COMPLETE title.
 *   DERIVED `derived-equals-full` — a FRAGMENT of one side equals the other
 *           side's complete title.
 *   null    `none` — not a match, so not a tier.
 *
 * Keyed as a total `Record<TitlePairArm, …>` on purpose: adding an arm to the
 * union in `series-title-variants.ts` without assigning it a tier is a
 * typecheck error here, so a future arm cannot slip into the matcher untiered.
 *
 * `lossless-equals-lossless` sitting in EXACT is DOCUMENTATIONAL, not
 * behavioural: it requires BOTH FULL forms to be empty (row 1), while
 * `full-equals-full` and `derived-equals-full` both require the member's FULL
 * form to be non-empty (rows 2-3 return first). A member therefore can never
 * have a `lossless-equals-lossless` candidate AND a `derived-equals-full`
 * candidate, so the two EXACT arms provably never compete with DERIVED or with
 * each other for the same member (#2108 AC8).
 */
type ArmTier = 'exact' | 'derived' | null;

const ARM_TIER: Record<TitlePairArm, ArmTier> = {
  'full-equals-full': 'exact',
  'lossless-equals-lossless': 'exact',
  'derived-equals-full': 'derived',
  none: null,
};

/** The hot path: the ranked tier the matcher needs, from the one rule. */
function pairTier(a: TitleShape, b: TitleShape): ArmTier {
  return ARM_TIER[explainShapePairing(a, b).arm];
}

/**
 * The diagnostic entry point — the SAME rule the matcher runs, from two raw
 * titles. `POST /api/series/title-variants-debug` calls exactly this, so the
 * endpoint's verdict is production's verdict by construction rather than by a
 * route comment an operator has to hand-apply.
 *
 * Derives both shapes DIRECTLY, bypassing `cachedTitleShape`. Deliberate: the
 * memoization suite counts `titleVariants` derivations through a spy, and
 * routing a diagnostic through the memo would make those counts a function of
 * two callers instead of one. A debug endpoint pays two derivations per
 * request; that is free.
 */
export function explainTitlePairing(aTitle: string, bTitle: string): TitlePairVerdict {
  return explainShapePairing(titleShape(aTitle), titleShape(bTitle));
}

/**
 * Find the matching library book for a Hardcover member, using either
 * position equality (with ε tolerance) OR title-variant pairing. Both
 * signals are necessary: position-only fails when Audnexus / Hardcover
 * disagree on numbering (Dark Tower's Wind Through the Keyhole at 8 vs 4.5,
 * Hunger Games prequels at NULL vs 0/0.5). Title-only fails on edition
 * variants where titles drift but positions agree. Either-hits is the
 * empirical sweet spot. Library books MUST already be scoped to the current
 * series_name by the caller — this matcher does no scoping itself.
 *
 * Position is evaluated FIRST and independently. The no-identity-evidence guard
 * sits BETWEEN the two passes, deliberately: its job is to stop an untitled
 * member from pairing empty≡empty on the title path, not to make that member
 * unmatchable. A member titled `'[ ]'` at position 2 still claims a candidate at
 * position 2; the same member with a null position claims nothing.
 *
 * The title pass is RANKED by match-quality tier (#2108): an EXACT pairing
 * (`full-equals-full` / `lossless-equals-lossless`) anywhere in the pool beats a
 * DERIVED one (`derived-equals-full`) anywhere in the pool, and first-claim-wins
 * applies only WITHIN a tier — which is why `loadLibraryBooksForSeriesNames`
 * pins `ORDER BY books.id`. Ranking changes only WHICH candidate is returned:
 * the matchable set is unchanged, so a single-candidate pool behaves exactly as
 * it did before.
 *
 * `alreadyMatched` (optional) lets callers iterate a member list with
 * first-match-wins semantics: pass a Set of already-claimed library book ids
 * and add each returned candidate's id to it before the next call. Two
 * Hardcover members at the same position (or with pairing titles) can otherwise
 * both claim the same library book, producing a duplicate "In Library" badge
 * and — in the persist path — a duplicate `bookId` in `series_members`.
 */
export function findInLibraryMatch(
  member: HardcoverMemberSummary,
  candidates: LibraryBookSummary[],
  alreadyMatched?: ReadonlySet<number>,
): LibraryBookSummary | null {
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    if (positionsMatch(member.position, candidate.seriesPosition)) return candidate;
  }
  const memberShape = cachedTitleShape(member.title);
  // The G5 empty-variant guard, loosened by exactly the width of the non-Latin
  // identity arm (#2110). An all-non-Latin title yields zero variants, so this
  // early return fired before any candidate was compared and made row 1 of the
  // acceptance rule unreachable from the matcher — changing only the pairing
  // rule would have been inert. A member carrying NO identity evidence at all
  // (`'[ ]'`, `'   '`) still returns here, which is what keeps it from claiming
  // another untitled member's book on the title path.
  if (memberShape.variants.length === 0 && memberShape.lossless.length === 0) return null;
  // The title pass is TIERED (#2108): an EXACT pairing anywhere in the pool beats
  // a DERIVED one anywhere in the pool, and only within a tier does first-claim
  // win. A single unranked scan let `"Chapterhouse: Dune"` claim a bare `"Dune"`
  // by `suffix(1)` whenever that book merely sorted earlier than the real
  // `"Chapterhouse Dune"` — and on the bind path that misclaim is durable, since
  // `bindHardcoverSeries` rewrites the claimed book's series_name/position, after
  // which the wrong pairing position-matches forever.
  //
  // One pass, recording the first candidate of each tier: `exact ?? derived` is
  // the same candidate two literal scans would return, with each candidate's arm
  // evaluated once.
  //
  // DEFERRED, deliberately — CROSS-MEMBER arbitration. Claiming is per-member
  // greedy rather than batched in rounds, so an EARLIER member's DERIVED match
  // can still steal a LATER member's EXACT one: `"World of Warcraft: Illidan"`
  // claims a bare `"World of Warcraft"` on `prefix(1)`, and the eponymous
  // `"World of Warcraft"` member — which pairs FULL≡FULL and iterates later —
  // then gets nothing. Fixing that means a position → EXACT → DERIVED sweep
  // across ALL members at both call sites; out of scope until a real case
  // demands it.
  let derived: LibraryBookSummary | null = null;
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    const tier = pairTier(memberShape, cachedTitleShape(candidate.title));
    if (tier === 'exact') return candidate;
    if (tier === 'derived') derived ??= candidate;
  }
  return derived;
}

function positionsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < POSITION_MATCH_EPSILON;
}
