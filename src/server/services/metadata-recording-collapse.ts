/**
 * Collapse policy for a resolver window that names the SAME recording twice — Audible lists regional
 * variants of one production under different ASINs, and #2202's ambiguous-window hold would otherwise
 * block such a book from ever enriching (#2219).
 *
 * The identity question is answered by `resolveRecordingIdentity`; this module only decides which
 * sets are admissible for a collapse and which member of an admissible set is kept. The eligibility
 * gate deliberately lives in the caller's exact-title subset, never over the whole passing window.
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
