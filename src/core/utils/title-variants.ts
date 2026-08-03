/**
 * Shared title-variant generator (#2096).
 *
 * One title, one policy for "which shapes of this title could plausibly name the
 * same book". Pure: no I/O, no clock, no randomness, no server imports. The
 * series member matcher (`src/server/services/series-title-match.ts`) is built on
 * it; `POST /api/series/title-variants-debug` exposes it verbatim.
 *
 * Two axes, and only two:
 *
 *   1. parenthetical / bracket stripping
 *   2. colon-segment selection
 *
 * They are NOT a free cross product (G1). The parens-INTACT string contributes
 * exactly ONE variant — its FULL normalized form. Everything else is derived
 * from the paren-STRIPPED base, because a colon living inside a parenthetical
 * must never shear a segment: a literal cross product over
 * `"The Spiral Path (World of Warcraft: Traveler, Book 2)"` would emit
 * `prefix(1) = "the spiral path world of warcraft"`. `src/shared/dedup.ts`
 * documents the same load-bearing ordering on `buildTitleShape`.
 *
 * Deliberately absent: a `titleBearing` signal (safety lives in the pairwise
 * acceptance rule, not in a per-variant flag) and an article-stripping axis
 * (articles are series-identity scope). Also deliberately absent, and this one
 * is a divergence from `dedup.ts` carrying a named DRY-3 justification: the
 * `TAG_TITLE_SERIES_MARKER_REGEX` volume-marker strip. `dedup.ts` collapses
 * `"Saga Book 1"` onto `"Saga Book 2"` (#1896, a pinned, deliberately-unchanged
 * behaviour there). Propagating it here would make consecutive volumes of a
 * series indistinguishable — which is precisely the population this matcher
 * iterates — so the marker stays.
 */

import type { Variant, VariantTag } from '@shared/schemas/series-title-variants.js';

/**
 * The canonical variant contract lives in `src/shared` — `src/shared` may not
 * import `src/core`, so the type goes there and core consumes it, not the
 * reverse. Both declarations below are needed and neither is redundant: a
 * re-export-from does NOT create a local binding, so without the `import type`
 * above the `Variant[]` return annotation would not resolve.
 */
export type { Variant, VariantTag } from '@shared/schemas/series-title-variants.js';

/**
 * Min trimmed length of a segment's left context for a `:` to act as a
 * boundary. Same threshold, same intent as `COLON_PREFIX_MIN` in
 * `src/shared/dedup.ts` — generalized from "the first colon" to "every colon"
 * (G3). Below the threshold the `:` stays inside its segment as ordinary
 * separator text, so `"IT: Chapter Two"` is one segment, not two.
 */
const COLON_PREFIX_MIN = 3;

/**
 * The scalar normalizer, and the SINGLE implementation home for it — a
 * server-homed one would be unreachable from here (`src/core/**` may not import
 * `src/server/**`) and would force a duplicate. `series-title-match.ts`
 * re-exports it as `normalizeMemberTitleForMatch`, so its existing call sites
 * are untouched.
 *
 * Folds curly apostrophes, peels audio-edition tails (`(Unabridged)` /
 * `(Audio)` / `(Audible)`, paren and bracket forms), lowercases, folds combining
 * diacritics (é → e) before the alnum strip so the accented spelling keeps its
 * letter, canonicalizes `&`/`+` to the word "and" so neither spelling drops,
 * then collapses every remaining non-alphanumeric run to a single space.
 *
 * A `:` is therefore a SEPARATOR, not a truncation point: `"Chapterhouse: Dune"`
 * normalizes to `chapterhouse dune`, not `chapterhouse`. The pre-#2096 truncation
 * is what made that member fail to pair with a library `"Chapterhouse Dune"`.
 *
 * The edition strip staying HERE (rather than being left to the derived
 * paren-stripped axis) is load-bearing. Demote it and both sides of
 * `"Foo (Audio)"` ≡ `"Foo (Unabridged)"` reduce to `foo` as DERIVED forms, which
 * the asymmetric acceptance rule forbids from pairing. Keeping it scalar makes
 * both FULL forms `foo`, matching on the FULL≡FULL arm.
 *
 * The generic parenthetical strip is NOT here — that is the derived axis.
 */
export function normalizeTitleForVariantMatch(title: string): string {
  return title
    .replace(/[’‘]/g, "'")
    .replace(/\(\s*(?:unabridged|audio|audible)\s*\)/gi, ' ')
    .replace(/\[\s*(?:unabridged|audio|audible)\s*\]/gi, ' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Drop every `(...)` / `[...]` group. Runs on the RAW title, before segmentation. */
function stripParentheticals(title: string): string {
  return title.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
}

/**
 * Split the paren-stripped base on qualifying colon boundaries (G3). Scans
 * left to right: a `:` closes the pending segment only when that segment's
 * trimmed text already reaches `COLON_PREFIX_MIN`; otherwise the `:` is appended
 * as ordinary text. Segments empty after trimming are dropped, so a leading or
 * trailing colon contributes nothing.
 */
function colonSegments(base: string): string[] {
  const segments: string[] = [];
  let pending = '';
  for (const ch of base) {
    if (ch === ':' && pending.trim().length >= COLON_PREFIX_MIN) {
      segments.push(pending);
      pending = '';
    } else {
      pending += ch;
    }
  }
  segments.push(pending);
  return segments.filter((segment) => segment.trim().length > 0);
}

/**
 * Generate the ordered, deduped variant set for a title.
 *
 * Order is a TOTAL order (G4), most-specific first, so a full-array assertion is
 * meaningful: the parens-intact `full`, then the paren-stripped `full`, then
 * descending retained-segment count — within one count `prefix` before `suffix`,
 * with `first+last` immediately after the pair of the same count (it retains two
 * segments). Dedup keeps the FIRST occurrence of each collapsed key, which is
 * why `prefix(k)`/`suffix(k)` at k === the segment count silently collapse onto
 * the paren-stripped `full` rather than shadowing it.
 *
 * Variants whose normalized text is empty are discarded, so a title carrying no
 * alphanumerics (`'[ ]'`, `'   '`) yields `[]` — never an empty-string entry that
 * could pair with another empty-string entry.
 */
export function titleVariants(title: string): Variant[] {
  const variants: Variant[] = [];
  const seen = new Set<string>();

  // `raw` is already lowercased and whitespace-collapsed, so it IS the
  // case-insensitive collapsed key — no second derivation to drift.
  const push = (text: string, tag: VariantTag, parensStripped: boolean): void => {
    const raw = normalizeTitleForVariantMatch(text);
    if (raw.length === 0 || seen.has(raw)) return;
    seen.add(raw);
    variants.push({ raw, tag, parensStripped });
  };

  push(title, 'full', false);

  const base = stripParentheticals(title);
  push(base, 'full', true);

  const segments = colonSegments(base);
  const last = segments[segments.length - 1];
  for (let n = segments.length; n >= 1; n--) {
    push(segments.slice(0, n).join(' '), `prefix(${n})`, true);
    push(segments.slice(segments.length - n).join(' '), `suffix(${n})`, true);
    // `first+last` retains two segments, so it belongs to the n === 2 group.
    // For a two-segment title it equals the paren-stripped full and is deduped.
    if (n === 2 && last !== undefined) {
      push(`${segments[0]} ${last}`, 'first+last', true);
    }
  }

  return variants;
}
