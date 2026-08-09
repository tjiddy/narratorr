/**
 * Generates title forms on two axes: parenthetical stripping and colon slices. Only the intact
 * full form bypasses stripping; crossing intact parentheses with slicing can fabricate franchise
 * prefixes. Article and volume-marker stripping are excluded because they erase series identity.
 */

/** Internal aliases stay separate so drift tests can independently mutate each public re-export. */
import type {
  Variant as SharedVariant,
  VariantTag as SharedVariantTag,
} from '@shared/schemas/series-title-variants.js';

export type { Variant, VariantTag } from '@shared/schemas/series-title-variants.js';

/**
 * Shared numeric threshold, applied here at every colon against the raw paren-stripped segment.
 * dedup applies it only at the first colon after scalar normalization; the semantics stay distinct.
 */
import { COLON_PREFIX_MIN } from '@shared/dedup.js';

/** Bounds adversarial input; the length cap must match hardcover's source mapping bound. */
export const MAX_VARIANT_TITLE_LENGTH = 2048;
export const MAX_VARIANT_SEGMENTS = 32;

/**
 * Scalar fold for full titles: audio-edition tails, case, Latin diacritics, apostrophes,
 * `&`/`+`, punctuation, and whitespace. Colons are separators, not truncation points. Generic
 * parenthetical stripping belongs to derived variants; edition tails stay here so Audio and
 * Unabridged titles can pair as full forms under asymmetric acceptance.
 */
export function normalizeTitleForVariantMatch(title: string): string {
  return applyCommonFolds(title, SCALAR_DIACRITIC_STRIP, SCALAR_KEEP_CLASS);
}

/**
 * Shared mechanics, kept private to avoid expanding the contract. Scalar and lossless knobs remain
 * independently editable, so their lockstep is enforced by a property test rather than this helper.
 */
function applyCommonFolds(
  title: string,
  diacriticStrip: (decomposed: string) => string,
  keepClass: RegExp,
): string {
  const decomposed = title
    .replace(/[’‘]/g, "'")
    .replace(/\(\s*(?:unabridged|audio|audible)\s*\)/gi, ' ')
    .replace(/\[\s*(?:unabridged|audio|audible)\s*\]/gi, ' ')
    .toLowerCase()
    .normalize('NFD');
  return diacriticStrip(decomposed)
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(keepClass, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Both pipelines strip U+0300–036F; lossless limits the strip to Latin bases.
const SCALAR_DIACRITIC_STRIP = (decomposed: string): string => decomposed.replace(/[̀-ͯ]/g, '');
const SCALAR_KEEP_CLASS = /[^a-z0-9' ]+/g;
const LOSSLESS_DIACRITIC_STRIP = (decomposed: string): string =>
  decomposed.replace(/(\p{Script=Latin})[̀-ͯ]+/gu, '$1');
const LOSSLESS_KEEP_CLASS = /[^\p{L}\p{N}\p{M}' ]+/gu;

/**
 * Removes bracketed groups before segmentation with one shared depth counter. Nested and
 * unterminated groups strip as one run; either closer ends either opener to preserve malformed
 * title behavior. Each run emits one space, keeping balanced raw segments unchanged. The scan is
 * linear; the former regex backtracked quadratically on unmatched openers.
 */
function stripParentheticals(title: string): string {
  let depth = 0;
  let out = '';
  let runEmitted = false;
  for (const ch of title) {
    const opener = ch === '(' || ch === '[';
    const closer = ch === ')' || ch === ']';
    if (!opener && !closer && depth === 0) {
      out += ch;
      runEmitted = false;
      continue;
    }
    if (opener) depth++;
    else if (closer && depth > 0) depth--;
    if (!runEmitted) {
      out += ' ';
      runEmitted = true;
    }
  }
  return out;
}

/**
 * Splits the paren-stripped base where a colon's trimmed left segment reaches
 * COLON_PREFIX_MIN. Short-prefix colons remain text; empty edge segments are dropped.
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
 * Returns the exact raw, paren-stripped colon segments used for derived variants. Variant tags
 * cannot recover the segment count after dedup. Punctuation-only segments remain, so consumers
 * must normalize and drop empties before counting. This linear helper is intentionally unclamped.
 */
export function titleSegments(title: string): string[] {
  return colonSegments(stripParentheticals(title));
}

/**
 * Unicode-preserving twin of the scalar fold for identity checks. It strips U+0300–036F marks
 * only from Latin bases; script-agnostic stripping would erase identity-bearing marks in Cyrillic,
 * Indic, and other scripts. All other letters, digits, and marks survive, then recompose to NFC.
 * Do not widen the strip to `\p{M}`: scalar normalization does not strip marks outside this band.
 */
export function normalizeTitleLosslessly(title: string): string {
  return applyCommonFolds(title, LOSSLESS_DIACRITIC_STRIP, LOSSLESS_KEEP_CLASS).normalize('NFC');
}

/**
 * True when scalar normalization drops any character preserved by the lossless fold. Detection is
 * character-level because structural and whole-token checks miss annotations and partial token
 * loss. Empty scalar forms belong to the empty-variant guard. Non-decomposing `ß`/`ø`/`æ` count as
 * loss; Latin diacritics that fold to ASCII do not.
 */
export function hasDegenerateFullForm(title: string): boolean {
  const full = normalizeTitleForVariantMatch(title);
  if (full.length === 0) return false;
  return /[^a-z0-9' ]/.test(normalizeTitleLosslessly(title));
}

/**
 * Returns first-key-wins variants in this order: intact full, stripped full, then slices by
 * descending retained count with prefix before suffix and first+last in the two-segment group.
 * Empty forms are dropped. Over either clamp only full forms remain because dense colon slicing
 * is quadratic. Titles are never truncated: dropping derived forms can refuse a match, while a
 * truncated fragment could create a false match. titleSegments remains unclamped.
 */
export function titleVariants(title: string): SharedVariant[] {
  const variants: SharedVariant[] = [];
  const seen = new Set<string>();

  // raw is the dedup key; compute lossy from the unnormalized slice so discarded characters remain
  // observable. First-key-wins keeps the first flag, which is conservative on lossy collisions.
  const push = (text: string, tag: SharedVariantTag, parensStripped: boolean): void => {
    const raw = normalizeTitleForVariantMatch(text);
    if (raw.length === 0 || seen.has(raw)) return;
    seen.add(raw);
    variants.push({ raw, tag, parensStripped, lossy: hasDegenerateFullForm(text) });
  };

  push(title, 'full', false);

  const base = stripParentheticals(title);
  push(base, 'full', true);

  if (title.length > MAX_VARIANT_TITLE_LENGTH) return variants;

  const segments = colonSegments(base);
  if (segments.length > MAX_VARIANT_SEGMENTS) return variants;

  const last = segments[segments.length - 1];
  for (let n = segments.length; n >= 1; n--) {
    push(segments.slice(0, n).join(' '), `prefix(${n})`, true);
    push(segments.slice(segments.length - n).join(' '), `suffix(${n})`, true);
    // first+last belongs to the two-segment group and dedupes against a two-segment full.
    if (n === 2 && last !== undefined) {
      push(`${segments[0]} ${last}`, 'first+last', true);
    }
  }

  return variants;
}
