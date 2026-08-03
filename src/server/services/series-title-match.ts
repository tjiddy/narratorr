import { titleVariants } from '@core/utils/title-variants.js';
import type { Variant } from '@core/utils/title-variants.js';

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
 */
const VARIANT_CACHE_MAX = 4096;
const variantCache = new Map<string, Variant[]>();

function cachedTitleVariants(title: string): Variant[] {
  const hit = variantCache.get(title);
  if (hit) return hit;
  const computed = titleVariants(title);
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

/**
 * The #1891 asymmetric one-side-stripped rule, generalized to variant sets: two
 * titles pair iff their FULL forms are equal, OR some DERIVED variant of one
 * side equals the other side's FULL form. derived≡derived is NEVER a match.
 *
 * That asymmetry is the whole safety argument. Without it, `"Foo: A Novel"` and
 * `"Bar: A Novel"` pair on their shared `suffix(1)` (the generic-tail sibling
 * class), and `"Star Wars: A"` pairs with `"Star Wars: B"` on their shared
 * franchise prefix. Requiring one side to be the complete title means a
 * fragment can only ever match something that IS that fragment in full.
 *
 * Symmetric and reflexive but NON-transitive, exactly like `titlesMatchForDedup`
 * — never use it as a `Map`/`Set` key.
 */
function titleVariantsPair(a: readonly Variant[], b: readonly Variant[]): boolean {
  const aFull = fullForm(a);
  const bFull = fullForm(b);
  if (aFull.length === 0 || bFull.length === 0) return false;
  if (aFull === bFull) return true;
  if (a.some((v) => isDerived(v) && v.raw === bFull)) return true;
  return b.some((v) => isDerived(v) && v.raw === aFull);
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
 * Position is evaluated FIRST and independently. The empty-variant guard sits
 * BETWEEN the two passes, deliberately: its job is to stop an untitled member
 * from pairing empty≡empty on the title path, not to make that member
 * unmatchable. A member titled `'[ ]'` at position 2 still claims a candidate at
 * position 2; the same member with a null position claims nothing.
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
  const memberVariants = cachedTitleVariants(member.title);
  if (memberVariants.length === 0) return null;
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    if (titleVariantsPair(memberVariants, cachedTitleVariants(candidate.title))) return candidate;
  }
  return null;
}

function positionsMatch(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) < POSITION_MATCH_EPSILON;
}
