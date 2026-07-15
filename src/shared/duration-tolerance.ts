/**
 * Single home for the audiobook duration-match tolerance band (#1850/#1854).
 *
 * A same-edition scanned runtime and a provider's stated runtime differ by a
 * *fixed-size* amount — the "This is Audible" intro + end credits (~40s) plus the
 * provider's whole-minute runtime granularity (±30s) — that does NOT scale with
 * book length (212 ASIN-verified same-edition pairs, 2026-07-07: max Δ 69s at any
 * length, correlation with length ≈ 0.096). 90s = the 69s observed ceiling + ~21s
 * headroom. #1854 folded the two remaining relative-15%-band call sites
 * (`recording-identity.ts`, `quality-gate.helpers.ts`) onto this one absolute band
 * so a third copy-instead-of-import drift can't recur.
 *
 * Layer placement: `src/shared/` is importable from `core`, `server`, AND
 * `client` (unlike `server`, which `core` may not import — the original reason
 * `recording-identity` *copied* the constant instead of importing it).
 *
 * UAT-tunable: raise it if live UAT shows too many false Reviews rather than
 * reintroducing a relative/score tier.
 */
export const DURATION_TOLERANCE_SECONDS = 90;

/**
 * True when two runtimes are within the absolute duration-match band.
 *
 * Both arguments are SECONDS — unit conversion is each caller's responsibility.
 * The provider `runtimeLengthMin` and the `books.duration` DB column are MINUTES,
 * so callers reading those sides multiply by 60 BEFORE calling this (the units
 * bug class `book-duration-minutes-vs-quality-seconds`: a raw-minutes argument
 * into a 90-*second* band yields an effective 90-*minute* tolerance, 60× too
 * loose). The scanner value and the quality chain are already seconds.
 *
 * Boundary is INCLUSIVE at 90 (Δ90s inside, Δ91s outside), matching #1850. The
 * predicate does NO guarding — a missing/zero/negative input is compared as a
 * plain absolute difference; call sites own their present/positive guards.
 */
export function withinDurationTolerance(aSeconds: number, bSeconds: number): boolean {
  return Math.abs(aSeconds - bSeconds) <= DURATION_TOLERANCE_SECONDS;
}
