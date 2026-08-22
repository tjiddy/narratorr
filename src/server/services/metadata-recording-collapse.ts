/**
 * Collapse policy for a candidate set that names the SAME recording twice — Audible lists territorial
 * publisher editions of one production under different ASINs, and #2202's ambiguous-window hold would
 * otherwise block such a book from ever enriching (#2219).
 *
 * The identity question is answered by `resolveRecordingIdentity`; this module only decides which
 * sets are admissible for a collapse and which member of an admissible set is kept. On the resolver
 * path the eligibility gate deliberately lives in the caller's exact-title subset, never over the
 * whole passing window; on the search path (#1597) `collapseDuplicateRecordings` supplies its own
 * bucketing, which is a partition and never a verdict.
 */

import { slugify, type BookMetadata } from '@core/index.js';
import { normalizeProductionType } from '@core/metadata/production-type.js';
import {
  resolveRecordingIdentity,
  type LibraryRecording,
  type RecordingCandidate,
} from '@core/utils/recording-identity.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { pickPrimarySeries } from '@shared/pick-primary-series.js';

/**
 * Schema validity is not usefulness: every optional string on `BookMetadata` is untrimmed, and the
 * provider mappers pass blanks through, so `!!value` admits `'   '` and `!== undefined` admits `''`.
 * Either one lets a blank outrank — and durably discard — a peer's real cover or description.
 */
export function usefulString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** An empty array and an array whose every entry is blank both count as absent. */
export function usefulArray(value: unknown): boolean {
  return Array.isArray(value) && value.some(usefulString);
}

/**
 * Fixed richness list. Fields on which no member of a collapsible set can differ are excluded on
 * purpose: `duration` and `asin` are required by the admission gate, and `narrators` must carry
 * equal signal on every member for the pairwise verdicts to have been `same-recording` at all — so
 * `usefulArray(narrators)` holds for all of them and could never discriminate.
 */
const RICHNESS_STRINGS = ['coverUrl', 'description', 'subtitle', 'publisher', 'publishedDate', 'language'] as const;

/**
 * A collapse-eligible member: a canonical ASIN so the pick is nameable and totally orderable, and a
 * positive duration so `resolveRecordingIdentity` corroborates on runtime rather than returning
 * `same-recording` for the absent-signal case.
 */
function isCollapseEligible(candidate: BookMetadata): boolean {
  return canonicalizeAsin(candidate.asin) !== null
    && typeof candidate.duration === 'number'
    && candidate.duration > 0;
}

function toRecordingSide(book: BookMetadata): RecordingCandidate {
  return {
    title: book.title,
    authors: book.authors.map((a) => a.name),
    narrators: book.narrators ?? [],
    duration: book.duration ?? null,
    asin: book.asin ?? null,
    productionType: normalizeProductionType(book.formatType),
  };
}

function toLibrarySide(book: BookMetadata): LibraryRecording {
  return {
    title: book.title,
    primaryAuthorSlug: slugify(book.authors[0]?.name ?? ''),
    narrators: book.narrators ?? [],
    duration: book.duration ?? null,
    asin: book.asin ?? null,
    productionType: normalizeProductionType(book.formatType),
  };
}

/**
 * A stricter admission rule than the primitive's own veto, applied here because it cannot fire on
 * this path: `corroborateWithDuration` returns from the duration branch whenever both sides have a
 * positive runtime, which admission already requires. Two known, different forms are a conflict;
 * `unknown` on either side carries no signal. This does not re-open #1728 — duration stays
 * authoritative for the primitive's own verdict.
 */
function productionFormsConflict(a: BookMetadata, b: BookMetadata): boolean {
  const left = normalizeProductionType(a.formatType);
  const right = normalizeProductionType(b.formatType);
  return left !== 'unknown' && right !== 'unknown' && left !== right;
}

/**
 * Whether every unordered pair is provably the same recording. The relation is NOT transitive —
 * 600/604/608-minute runtimes chain through the 240s band pairwise but 600~608 reviews — so no
 * representative, union-find or adjacent-pair shortcut is admissible. `VALIDATION_WINDOW` bounds
 * the set at five, hence ten pairs, so a plain nested loop needs no memoization.
 */
export function collapsesToOneRecording(candidates: BookMetadata[]): boolean {
  if (candidates.length < 2) return false;
  if (!candidates.every(isCollapseEligible)) return false;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (productionFormsConflict(a, b)) return false;
      if (resolveRecordingIdentity(toRecordingSide(a), toLibrarySide(b)).verdict !== 'same-recording') return false;
    }
  }
  return true;
}

function isSeriesBearing(candidate: BookMetadata): boolean {
  return usefulString(pickPrimarySeries(candidate)?.name);
}

function usefulFieldCount(candidate: BookMetadata): number {
  const strings = RICHNESS_STRINGS.filter((field) => usefulString(candidate[field])).length;
  return strings + (usefulArray(candidate.genres) ? 1 : 0);
}

/**
 * The chosen object is returned unmerged and its peers are discarded, so a sparse pick permanently
 * loses a cover, description or series mapping an equivalent listing carried. Richness therefore
 * ranks, but only after the row's own ASIN: canonicalization is lexicographic, not semantic, so it
 * identifies no "canonical" regional edition and is only fit to be the final total tie-break.
 *
 * Precondition: a non-empty set. Pure over any candidate shape otherwise — the eligibility gate is
 * the caller's, which is why fields the gate makes uniform are still excluded from the ranking.
 */
export function selectCanonicalRecording(candidates: BookMetadata[], inputAsin: string | undefined): BookMetadata {
  const wanted = canonicalizeAsin(inputAsin);
  if (wanted !== null) {
    const requested = candidates.find((candidate) => canonicalizeAsin(candidate.asin) === wanted);
    if (requested) return requested;
  }

  return [...candidates].sort(compareRichness)[0]!;
}

/**
 * Every collapsed peer's ASIN reaches the canonical, because `applyAudnexusEnrichment` walks
 * `[primaryAsin, ...alternateAsins]` — so a twin's record can still backfill the series or cover the
 * kept listing never carried. Sorted and canonicalized for the same reason the pick is: neither the
 * value nor its order may depend on provider ordering.
 */
export function mergeAlternateAsins(canonical: BookMetadata, members: readonly BookMetadata[]): BookMetadata {
  const own = canonicalizeAsin(canonical.asin);
  const merged = new Set<string>();
  for (const member of members) {
    for (const raw of [member.asin, ...(member.alternateAsins ?? [])]) {
      const asin = canonicalizeAsin(raw);
      if (asin === null || asin === own) continue;
      merged.add(asin);
    }
  }
  if (merged.size === 0) return canonical;
  return { ...canonical, alternateAsins: [...merged].sort() };
}

/** One performed collapse, shaped for the caller's `debug` record. */
export interface RecordingCollapse {
  canonicalAsin: string;
  collapsedAsins: string[];
}

export interface RecordingCollapseResult {
  books: BookMetadata[];
  collapses: RecordingCollapse[];
}

/**
 * Cheap invariants every member of a collapsible group must share. This is a PARTITION, not a
 * verdict: it only bounds the pairwise work `collapsesToOneRecording` then does over each bucket.
 * Narrator and author slugs are sorted so provider ordering cannot split a group, and the production
 * form is part of the key so an abridged listing never buckets with its unabridged twin.
 */
function recordingBucketKey(book: BookMetadata): string {
  // `authors` is schema-required but this runs over every raw search result, and the provider
  // mappers are the only thing standing between a malformed payload and this key.
  const authors = (book.authors ?? []).map((author) => slugify(author.name)).sort();
  const narrators = (book.narrators ?? []).map((narrator) => slugify(narrator)).sort();
  return JSON.stringify([slugify(book.title), authors, narrators, normalizeProductionType(book.formatType)]);
}

/**
 * Collapses each bucket that is provably one recording down to its canonical member, merging the
 * peers' ASINs onto it (#1597). Pure: no I/O and no settings read, so the caller owns the logging.
 *
 * A bucket is decided all-or-nothing, mirroring the resolver path — the relation is non-transitive,
 * so any failing pair leaves the whole bucket alone rather than collapsing a subset. `preferAsin`
 * exists for the resolver call site alone: an upstream collapse that did not know the requested ASIN
 * would silently defeat that site's override before the window ever reached it.
 */
export function collapseDuplicateRecordings(
  books: BookMetadata[],
  preferAsin?: string | undefined,
): RecordingCollapseResult {
  if (books.length < 2) return { books, collapses: [] };

  const keys = books.map(recordingBucketKey);
  const buckets = new Map<string, BookMetadata[]>();
  keys.forEach((key, index) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(books[index]!);
    else buckets.set(key, [books[index]!]);
  });

  const canonicals = new Map<string, BookMetadata>();
  const collapses: RecordingCollapse[] = [];
  for (const [key, bucket] of buckets) {
    if (!collapsesToOneRecording(bucket)) continue;
    const canonical = selectCanonicalRecording(bucket, preferAsin);
    canonicals.set(key, mergeAlternateAsins(canonical, bucket));
    // Admission already required a canonicalizable ASIN on every member, so none of these are null.
    collapses.push({
      canonicalAsin: canonicalizeAsin(canonical.asin)!,
      collapsedAsins: bucket.filter((peer) => peer !== canonical).map((peer) => canonicalizeAsin(peer.asin)!).sort(),
    });
  }
  if (collapses.length === 0) return { books, collapses };

  return { books: emitInInputOrder(books, keys, canonicals), collapses };
}

/**
 * A collapsed group takes the earliest slot any of its members held: provider order is the only
 * relevance signal the search path has, so the group keeps its best rank.
 */
function emitInInputOrder(
  books: BookMetadata[],
  keys: string[],
  canonicals: ReadonlyMap<string, BookMetadata>,
): BookMetadata[] {
  const emitted = new Set<string>();
  const collapsed: BookMetadata[] = [];
  keys.forEach((key, index) => {
    const canonical = canonicals.get(key);
    if (canonical === undefined) {
      collapsed.push(books[index]!);
      return;
    }
    if (emitted.has(key)) return;
    emitted.add(key);
    collapsed.push(canonical);
  });
  return collapsed;
}

function compareRichness(a: BookMetadata, b: BookMetadata): number {
  const series = Number(isSeriesBearing(b)) - Number(isSeriesBearing(a));
  if (series !== 0) return series;

  const fields = usefulFieldCount(b) - usefulFieldCount(a);
  if (fields !== 0) return fields;

  // Code-unit order, not localeCompare: the tie-break must be locale-independent to stay total.
  const left = canonicalizeAsin(a.asin) ?? '';
  const right = canonicalizeAsin(b.asin) ?? '';
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
