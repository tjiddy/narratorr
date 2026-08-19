import { titleVariants, hasDegenerateFullForm, normalizeTitleLosslessly } from '@core/utils/title-variants.js';
// Import directly so core re-export drift is observed only by its dedicated guard test.
import type { TitlePairArm, TitlePairVerdict, Variant } from '@shared/schemas/series-title-variants.js';

/** Cross-source floating-point tolerance for series positions. */
export const POSITION_MATCH_EPSILON = 1e-9;

// Keep this compatibility export; core owns normalization because it cannot depend on server code.
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

// The raw-title memo avoids O(members × candidates) derivations inside persistence transactions.
// Wholesale reset bounds process lifetime; derivation-count tests cover both hit and bound branches.
/** Exported so the bound test drives the real ceiling. */
export const VARIANT_CACHE_MAX = 4096;

interface TitleShape {
  variants: Variant[];
  degenerateFull: boolean;
  /** Unicode-preserving identity evidence for a degenerate side. */
  lossless: string;
}

const variantCache = new Map<string, TitleShape>();

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

function fullForm(variants: readonly Variant[]): string {
  return variants.find((v) => v.tag === 'full' && !v.parensStripped)?.raw ?? '';
}

function isDerived(variant: Variant): boolean {
  return variant.tag !== 'full' || variant.parensStripped;
}

/** Keep an empty FULL form explicit in diagnostic reasons. */
function renderFull(full: string): string {
  return full.length === 0 ? '(empty)' : `"${full}"`;
}

// Both gates preserve identity: the target must be complete and the offered fragment non-lossy.
// Dropping either recreates the #2110 franchise cross-match class.
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
 * Sole acceptance rule: empty FULLs require equal non-empty lossless forms; equal FULLs
 * require lossless agreement when either side degenerates; differing FULLs require one
 * non-lossy derived form to equal the other's non-degenerate FULL. Derived-to-derived is
 * forbidden because shared fragments create franchise cross-matches.
 * Symmetric, reflexive only with lossless identity, and non-transitive: never use as a key.
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

// The total Record forces every future arm into a tier. Lossless-exact cannot compete
// with derived because it requires both FULL forms empty.
type ArmTier = 'exact' | 'derived' | null;

const ARM_TIER: Record<TitlePairArm, ArmTier> = {
  'full-equals-full': 'exact',
  'lossless-equals-lossless': 'exact',
  'derived-equals-full': 'derived',
  none: null,
};

function pairTier(a: TitleShape, b: TitleShape): ArmTier {
  return ARM_TIER[explainShapePairing(a, b).arm];
}

/** Derive both shapes directly so diagnostics do not perturb memoization derivation counts. */
export function explainTitlePairing(aTitle: string, bTitle: string): TitlePairVerdict {
  return explainShapePairing(titleShape(aTitle), titleShape(bTitle));
}

/**
 * Position wins before title matching; candidates must already be scoped to the series.
 * The title path ranks exact over derived and uses input order within a tier. `alreadyMatched`
 * lets callers prevent two members from claiming one library book.
 */
export function findInLibraryMatch(
  member: HardcoverMemberSummary,
  candidates: readonly LibraryBookSummary[],
  alreadyMatched?: ReadonlySet<number>,
): LibraryBookSummary | null {
  for (const candidate of candidates) {
    if (alreadyMatched?.has(candidate.id)) continue;
    if (positionsMatch(member.position, candidate.seriesPosition)) return candidate;
  }
  const memberShape = cachedTitleShape(member.title);
  // Zero variants are valid for non-Latin identity; only zero lossless evidence is unmatchable.
  if (memberShape.variants.length === 0 && memberShape.lossless.length === 0) return null;
  // Cross-member arbitration remains greedy: an earlier derived match can steal a later exact one.
  // Fixing it requires position → exact → derived sweeps across all members at both call sites.
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
