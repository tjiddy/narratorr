/**
 * Shared library-identity normalizer + predicate (#1662).
 *
 * One duplicate decision, defined once, consumed by BOTH client and server so
 * the scan flag, the post-match pass, confirm, scan-debug, and the client
 * In-Library / edit-recheck surfaces cannot disagree. `src/client/**` and
 * `src/server/**` may import `src/shared/**`; the reverse is forbidden
 * (eslint.config.js) — so this module owns the canonical series-marker regex
 * that `folder-parsing.ts` (server) imports from here.
 */

import { slugify } from './utils.js';
import { canonicalizeAsin } from './asin.js';

/**
 * Canonical trailing series/volume marker regex. Catches comma- AND
 * space-prefixed forms with an optional series keyword: `, Book 9`, ` book 1`,
 * `trilogy book 1`, `saga book 5`, `series book 3`, `chronicles vol 2`.
 *
 * Owned here (not in `src/server/utils/folder-parsing.ts`) because the dedup
 * normalizer needs it and shared cannot import from server — `folder-parsing.ts`
 * imports it from this module (server→shared is allowed). One home, no
 * duplication, no boundary violation (#1662 F6).
 */
export const TAG_TITLE_SERIES_MARKER_REGEX =
  /[\s,]+(?:saga|trilogy|series|cycle|chronicles)?\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

/** Min trimmed prefix length before a `:` for the colon-subtitle boundary to fire. */
const COLON_PREFIX_MIN = 3;

/** Trailing `(...)` series/edition parenthetical group. */
const TRAILING_PAREN_REGEX = /\s*\([^)]*\)\s*$/;

/**
 * Non-colon core normalizer (#1891): lowercase + trim + collapse whitespace, then
 * strip trailing series/edition noise — a trailing parenthetical
 * (`TRAILING_PAREN_REGEX`) and/or a trailing `, Book N` / `, Vol N` marker
 * (`TAG_TITLE_SERIES_MARKER_REGEX`) — run to a **fixpoint**. It does NOT look at
 * colons: subtitle handling is a pairwise concern layered on top by
 * `buildTitleShape`/`titlesMatchForDedup`, not baked into a unary output.
 *
 * The fixpoint (repeat both operations until a full pass removes nothing) is
 * load-bearing: a single paren-then-marker pass leaves a residual trailing
 * parenthetical when suffixes are STACKED (`"Foo (A) (B)"`, `"Foo, Book 1, Vol 2"`,
 * a parenthetical hidden behind a marker). Fully unwinding stacked suffixes keeps a
 * colon that lived only inside a removable trailing suffix (`"Dune (Edition: Deluxe)"`)
 * from ever becoming a false subtitle boundary. Single-suffix titles are byte-identical
 * to the pre-#1891 single pass. Each successful strip removes non-empty text, so the
 * loop converges.
 */
export function normalizeTitleCore(s: string): string {
  let result = s.toLowerCase().trim().replace(/\s+/g, ' ');

  let changed = true;
  while (changed) {
    const before = result;
    result = result.replace(TRAILING_PAREN_REGEX, '');
    result = result.replace(TAG_TITLE_SERIES_MARKER_REGEX, '');
    changed = result !== before;
  }

  return result.replace(/\s+/g, ' ').trim();
}

/**
 * The colon-tolerant shape of a title (#1891). `fullNormalized` is the full
 * non-colon-normalized string (subtitle text retained — that is what distinguishes
 * two franchise subtitles); `colonBase` drops a colon subtitle; `hadSubtitle` records
 * whether a subtitle boundary fired. `colonBase`/`hadSubtitle` are pure functions of
 * `fullNormalized` (see `buildTitleShape`), so equal `fullNormalized` ⟹ equal
 * `colonBase` — the retrieval invariant that makes an author+`colonBase` bucket a
 * complete index for the pairwise predicate.
 */
export interface TitleShape {
  fullNormalized: string;
  colonBase: string;
  hadSubtitle: boolean;
}

/**
 * Reduce a raw title to its `TitleShape` (#1891). `fullNormalized` is computed
 * FIRST (this ordering is load-bearing) so that a colon surviving only inside a
 * removable trailing suffix is already gone before any colon logic runs, and
 * `colonBase`/`hadSubtitle` are derived purely FROM `fullNormalized`.
 *
 * A colon subtitle boundary exists iff the first `:` in `fullNormalized` is at index
 * > 0 AND the trimmed pre-colon prefix has `length >= COLON_PREFIX_MIN` (3). Because
 * whitespace is already collapsed, internal spaces count toward that trimmed length
 * (`"A B"` = 3 → boundary; `"IT"` = 2, `"X"` = 1 → no boundary). When a boundary
 * exists, `colonBase = normalizeTitleCore(prefix)` (re-normalized so a now-trailing
 * `, Book N` marker strips); otherwise `colonBase = fullNormalized`.
 */
export function buildTitleShape(title: string): TitleShape {
  const fullNormalized = normalizeTitleCore(title);
  const colonIdx = fullNormalized.indexOf(':');
  if (colonIdx > 0) {
    const prefix = fullNormalized.slice(0, colonIdx).trim();
    if (prefix.length >= COLON_PREFIX_MIN) {
      return { fullNormalized, colonBase: normalizeTitleCore(prefix), hadSubtitle: true };
    }
  }
  return { fullNormalized, colonBase: fullNormalized, hadSubtitle: false };
}

/**
 * Pairwise, non-transitive title-match relation (#1891). Two title shapes match iff
 * their `fullNormalized` forms are equal, OR their `colonBase` forms are equal AND at
 * most one side stripped a subtitle. Two titles that BOTH stripped (distinct)
 * subtitles do NOT match (unless their `fullNormalized` are identical — two copies of
 * the same `"Series: Y"` still match via the first arm).
 *
 * Symmetric and reflexive but NON-transitive (`Series ~ Series: A`,
 * `Series ~ Series: B`, `Series: A ≁ Series: B`) — never use as a `Map`/`Set` key.
 * Keyed call sites bucket by author slug + `colonBase` (complete by the retrieval
 * invariant) then pairwise-filter within the bucket.
 */
export function titlesMatchForDedup(a: TitleShape, b: TitleShape): boolean {
  if (a.fullNormalized === b.fullNormalized) return true;
  return a.colonBase === b.colonBase && !(a.hadSubtitle && b.hadSubtitle);
}

/** Already-resolved identity over which the dedup predicate runs. */
export interface DedupIdentity {
  title: string;
  asin?: string | null | undefined;
  /** Pre-computed author slug; takes precedence over `authorName` when present. */
  authorSlug?: string | null | undefined;
  /** Author display name; slugified when `authorSlug` is absent. */
  authorName?: string | null | undefined;
}

/** Resolve the position-0 author slug, or null when the identity is author-less. */
function resolveAuthorSlug(id: DedupIdentity): string | null {
  if (typeof id.authorSlug === 'string') return id.authorSlug.length > 0 ? id.authorSlug : null;
  if (typeof id.authorName === 'string' && id.authorName.length > 0) return slugify(id.authorName);
  return null;
}

/**
 * The single ordered library-identity predicate (#1662) — the canonical
 * bibliographic-scope contract. Returns true when `candidate` is the same library
 * book as `entry`:
 *
 *   1. ASIN — canonical form (`canonicalizeAsin`: trim + UPPERCASE → null on
 *      blank, #1733). One canonical ASIN contract shared with the resolver
 *      (`resolveRecordingIdentity`) and the gather predicate (`gatherIncumbentIds`),
 *      so a padded/case-drifted `' b01abc '` still scopes to a stored `'B01ABC'`
 *      and a whitespace-only ASIN folds to "no ASIN" and falls through (#1726).
 *   2. title + position-0 author slug — `titlesMatchForDedup` (the pairwise,
 *      non-transitive subtitle-tolerant relation, #1891) over the two title shapes
 *      AND author slugs equal. The subtitle/parenthetical/series tolerance is applied
 *      ONLY here, gated by a matching author slug, to bound the blast radius.
 *   3. author-less title-only fallback — both sides author-less, EXACT title
 *      equality (no stripping; mirrors the `#253 notExists(bookAuthors)` intent
 *      so an authored book is never matched via the author-less branch).
 *
 * An ASIN miss falls through to (2); an author mismatch in (2) is NOT a match.
 * `resolveRecordingIdentity`'s scope gate delegates here so the resolver and this
 * predicate cannot drift on bibliographic scope (#1726).
 */
export function matchesLibraryIdentity(candidate: DedupIdentity, entry: DedupIdentity): boolean {
  // (1) ASIN — canonical form (trim + UPPERCASE → null on blank), one contract
  // shared with the resolver and gather sites (#1726).
  const candidateAsin = canonicalizeAsin(candidate.asin);
  const entryAsin = canonicalizeAsin(entry.asin);
  if (candidateAsin && entryAsin && candidateAsin === entryAsin) {
    return true;
  }

  const candidateSlug = resolveAuthorSlug(candidate);
  const entrySlug = resolveAuthorSlug(entry);

  // (2) title + author slug — both authored, slugs equal, titles pairwise-match.
  if (candidateSlug && entrySlug) {
    return candidateSlug === entrySlug
      && titlesMatchForDedup(buildTitleShape(candidate.title), buildTitleShape(entry.title));
  }

  // (3) author-less title-only — both author-less, exact title equality only.
  if (!candidateSlug && !entrySlug) {
    return candidate.title === entry.title;
  }

  // One side authored, the other not — never a match.
  return false;
}
