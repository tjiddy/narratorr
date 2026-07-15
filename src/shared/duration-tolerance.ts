/**
 * Single home for the audiobook duration-match tolerance band (#1850/#1854).
 *
 * A same-edition scanned runtime and a provider's stated runtime differ by a
 * *fixed-size* amount — intro/outro credits plus the provider's whole-minute
 * runtime granularity — that does NOT scale with book length (212 ASIN-verified
 * same-edition pairs, 2026-07-07: max Δ 69s; correlation with length ≈ 0.096).
 * #1854 folded the two remaining relative-15%-band call sites
 * (`recording-identity.ts`, `quality-gate.helpers.ts`) onto this one absolute band
 * so a third copy-instead-of-import drift can't recur.
 *
 * 90s → 240s (2026-07-15, live Library-Import UAT): the 90s ceiling was derived
 * from CLEAN same-edition pairs; real-world rips — especially multi-part rips
 * merged into one file, carrying per-part intro/outro credits — routinely run a
 * couple of honest minutes over the catalog runtime (e.g. a 29h41m book scanning
 * 29h43m) and were flooding import review. 4 minutes still separates every
 * verified different-recording pair that matters: the closest marquee re-records
 * are Martian Bray/Wheaton Δ6m, HP1 Dale/Fry Δ7m, NOTW Podehl/Degas Δ8m, and only
 * ~5% of the 491-pair catalog study sits inside 4m (vs 2% inside 90s), nearly all
 * narrator-gated classics (evidence: #1854 data comment + .scratch/duration-band-data/).
 *
 * Layer placement: `src/shared/` is importable from `core`, `server`, AND
 * `client` (unlike `server`, which `core` may not import — the original reason
 * `recording-identity` *copied* the constant instead of importing it).
 *
 * UAT-tunable: raise it if live UAT shows too many false Reviews rather than
 * reintroducing a relative/score tier.
 */
export const DURATION_TOLERANCE_SECONDS = 240;

/**
 * True when two runtimes are within the absolute duration-match band.
 *
 * Both arguments are SECONDS — unit conversion is each caller's responsibility.
 * The provider `runtimeLengthMin` and the `books.duration` DB column are MINUTES,
 * so callers reading those sides multiply by 60 BEFORE calling this (the units
 * bug class `book-duration-minutes-vs-quality-seconds`: a raw-minutes argument
 * into a seconds band yields an effective 60×-too-loose tolerance). The scanner
 * value and the quality chain are already seconds.
 *
 * Boundary is INCLUSIVE at the band (Δ240s inside, Δ241s outside), matching #1850. The
 * predicate does NO guarding — a missing/zero/negative input is compared as a
 * plain absolute difference; call sites own their present/positive guards.
 */
export function withinDurationTolerance(aSeconds: number, bSeconds: number): boolean {
  return Math.abs(aSeconds - bSeconds) <= DURATION_TOLERANCE_SECONDS;
}
