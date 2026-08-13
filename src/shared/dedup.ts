import { slugify } from './utils.js';
import { canonicalizeAsin } from './asin.js';

// Trailing Book/Vol marker with optional saga/trilogy/series/cycle/chronicles prefix.
export const TAG_TITLE_SERIES_MARKER_REGEX =
  /[\s,]+(?:saga|trilogy|series|cycle|chronicles)?\s*(?:book|vol(?:ume)?)\s+\d+\s*$/i;

// Shared threshold; dedup and title-variant generation deliberately apply different policies.
export const COLON_PREFIX_MIN = 3;

const TRAILING_PAREN_REGEX = /\s*\([^)]*\)\s*$/;

// Repeatedly strip trailing parentheticals and series markers. The fixpoint handles
// stacked suffixes and removes colons inside discarded suffixes before subtitle parsing.
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

// colonBase and hadSubtitle derive only from fullNormalized. Equal full forms therefore
// share a colonBase, making author-plus-colonBase buckets complete for pairwise filtering.
export interface TitleShape {
  fullNormalized: string;
  colonBase: string;
  hadSubtitle: boolean;
}

// Normalize suffixes before colon detection. A colon splits only after a long-enough
// prefix; normalize that prefix again so a newly trailing series marker is removed.
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

// Match equal full forms, or equal colon bases when at most one side stripped a
// subtitle. This is symmetric and reflexive but non-transitive; never use it as a key.
export function titlesMatchForDedup(a: TitleShape, b: TitleShape): boolean {
  if (a.fullNormalized === b.fullNormalized) return true;
  return a.colonBase === b.colonBase && !(a.hadSubtitle && b.hadSubtitle);
}

export interface DedupIdentity {
  title: string;
  asin?: string | null | undefined;
  // Preferred over slugified authorName when provided.
  authorSlug?: string | null | undefined;
  authorName?: string | null | undefined;
}

/**
 * The one author-slug rule the identity predicate keys on; exported so a caller narrowing rows
 * for `matchesLibraryIdentity` derives the same slug the match will compare.
 *
 * A DERIVED slug that comes out empty is `null`, not `''`. `slugify` strips everything that is not
 * a word character, so a whitespace- or punctuation-only author name slugs to `''` — which reads as
 * authorless everywhere here (every branch below is a truthiness test) but is a distinct value to a
 * persisted column. A caller that stores this result and later queries `author_slug IS NULL` on it
 * would write a row it can never fetch again (#2305).
 */
export function resolveAuthorSlug(id: DedupIdentity): string | null {
  if (typeof id.authorSlug === 'string') return id.authorSlug.length > 0 ? id.authorSlug : null;
  if (typeof id.authorName === 'string' && id.authorName.length > 0) return slugify(id.authorName) || null;
  return null;
}

// Ordered identity: canonical ASIN, then tolerant title gated by equal author slug,
// then exact title only when both sides lack authors. An ASIN miss falls through.
export function matchesLibraryIdentity(candidate: DedupIdentity, entry: DedupIdentity): boolean {
  const candidateAsin = canonicalizeAsin(candidate.asin);
  const entryAsin = canonicalizeAsin(entry.asin);
  if (candidateAsin && entryAsin && candidateAsin === entryAsin) {
    return true;
  }

  const candidateSlug = resolveAuthorSlug(candidate);
  const entrySlug = resolveAuthorSlug(entry);

  if (candidateSlug && entrySlug) {
    return candidateSlug === entrySlug
      && titlesMatchForDedup(buildTitleShape(candidate.title), buildTitleShape(entry.title));
  }

  if (!candidateSlug && !entrySlug) {
    return candidate.title === entry.title;
  }

  return false;
}
