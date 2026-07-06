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

/** Min non-space prefix length before a `:` for the colon-subtitle strip to fire. */
const COLON_PREFIX_MIN = 3;

/** Trailing `(...)` series/edition parenthetical group. */
const TRAILING_PAREN_REGEX = /\s*\([^)]*\)\s*$/;

/**
 * Normalize a title for duplicate comparison: lowercase + trim + collapse
 * whitespace, then strip the drift that creates false "fresh match" verdicts —
 * a colon subtitle, a trailing series/edition parenthetical, and a trailing
 * `, Book N` / `, Vol N` marker.
 *
 * The colon strip only fires when the prefix is ≥3 non-space chars (mirrors the
 * `strip-colon-suffix` guard in tag-search-planner) so a 1–2 char prefix like
 * `"X: Y"` is left intact. Idempotent on already-clean titles.
 */
export function normalizeTitleForDedup(title: string): string {
  let result = title.toLowerCase().trim().replace(/\s+/g, ' ');

  // Strip a colon subtitle — drop everything from the first ':' onward.
  const colonIdx = result.indexOf(':');
  if (colonIdx > 0) {
    const prefix = result.slice(0, colonIdx).trim();
    if (prefix.length >= COLON_PREFIX_MIN) result = prefix;
  }

  // Strip a trailing parenthetical series/edition group, then a trailing
  // `, Book N` / ` Book N` / `, Vol N` series marker.
  result = result.replace(TRAILING_PAREN_REGEX, '');
  result = result.replace(TAG_TITLE_SERIES_MARKER_REGEX, '');

  return result.replace(/\s+/g, ' ').trim();
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
 *   2. normalized title + position-0 author slug — `normalizeTitleForDedup`
 *      equal AND author slugs equal. The subtitle/parenthetical/series stripping
 *      is applied ONLY here, gated by a matching author slug, to bound the blast
 *      radius.
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

  // (2) normalized title + author slug — both authored, slugs equal.
  if (candidateSlug && entrySlug) {
    return candidateSlug === entrySlug
      && normalizeTitleForDedup(candidate.title) === normalizeTitleForDedup(entry.title);
  }

  // (3) author-less title-only — both author-less, exact title equality only.
  if (!candidateSlug && !entrySlug) {
    return candidate.title === entry.title;
  }

  // One side authored, the other not — never a match.
  return false;
}
