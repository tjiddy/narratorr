/**
 * Distinguishes an existing recording from another edition of the same book. Narrator comparison
 * requires exact normalized set equality, unlike asymmetric overlap matching; the resolver adds
 * bibliographic scope and corroboration. Core accepts primitives and never imports server row types.
 */

import { normalizeNarrator, tokenizeNarrators, NARRATOR_PLACEHOLDERS } from './similarity.js';
import { matchesLibraryIdentity } from '@shared/dedup.js';
import { canonicalizeAsin } from '@shared/asin.js';
import { withinDurationTolerance } from '@shared/duration-tolerance.js';
import type { RecordingVerdict, RecordingReviewReason } from '@shared/schemas/recording-verdict.js';

/**
 * Core-facing re-export of the shared verdict types. Shared owns the canonical tuple because it
 * cannot import up from core.
 */
export type { RecordingVerdict, RecordingReviewReason } from '@shared/schemas/recording-verdict.js';

/** Narrator-set comparison verdict. Duration is NOT an input — the resolver applies it separately. */
export type NarratorEquality = 'equal' | 'not-equal' | 'no-signal';

interface NarratorTokens {
  signal: Set<string>;
  hasPlaceholder: boolean;
}

/**
 * Splits packed native-tag entries before normalizing so they align with one-name-per-row library
 * data. Placeholder presence stays separate from usable signal; silently dropping it can equate
 * `Full Cast, Jim Dale` with a solo Jim Dale recording.
 */
function recordingNarratorTokens(narrators: string[]): NarratorTokens {
  const signal = new Set<string>();
  let hasPlaceholder = false;
  for (const raw of narrators) {
    for (const part of tokenizeNarrators(raw)) {
      const normalized = normalizeNarrator(part);
      if (normalized.length === 0) continue;
      if (NARRATOR_PLACEHOLDERS.has(normalized)) hasPlaceholder = true;
      else signal.add(normalized);
    }
  }
  return { signal, hasPlaceholder };
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Exact narrator-set comparison: `equal` requires both-direction containment; differing signal,
 * including subsets/supersets, is `not-equal`. Empty or placeholder-only input is `no-signal`, as is
 * asymmetric placeholder input whose survivor sets are equal. This deliberately does not use the
 * overlap comparator.
 */
export function compareRecordingNarrators(a: string[], b: string[]): NarratorEquality {
  const { signal: setA, hasPlaceholder: placeholderA } = recordingNarratorTokens(a);
  const { signal: setB, hasPlaceholder: placeholderB } = recordingNarratorTokens(b);
  if (setA.size === 0 || setB.size === 0) return 'no-signal';
  if (setA.size !== setB.size || !isSubset(setA, setB)) return 'not-equal';
  // #1725: a full-cast credit must not collapse to its lead, so equal survivors under a one-sided
  // placeholder stay undecided — the placeholder stands for voices the other side may not have.
  // Unequal survivors are already decided, so this guard stays off that arm (#2206). An all-placeholder
  // side has an empty survivor set by construction, so the size-0 arm above still catches it first.
  if (placeholderA !== placeholderB) return 'no-signal';
  return 'equal';
}

export interface RecordingCandidate {
  title: string;
  authors: string[];
  narrators: string[];
  duration?: number | null;
  asin?: string | null;
  /**
   * Canonical production form kept as a nullable string to avoid an enum dependency. It can only
   * veto toward review; null, undefined, and `unknown` carry no signal.
   */
  productionType?: string | null;
}

/** Plain-primitive library-recording shape. Callers precompute `primaryAuthorSlug`. */
export interface LibraryRecording {
  title: string;
  primaryAuthorSlug: string;
  narrators: string[];
  duration?: number | null;
  asin?: string | null;
  productionType?: string | null;
}

/**
 * `recordingReviewReason` is present only for review verdicts and remains pure core data.
 */
export interface RecordingIdentityResult {
  verdict: RecordingVerdict;
  recordingReviewReason?: RecordingReviewReason;
}

const PRODUCTION_FORM_LABELS: Record<string, string> = {
  full_cast: 'Full Cast',
  dramatized: 'Dramatized',
  graphic_audio: 'GraphicAudio',
  abridged: 'Abridged',
  unabridged: 'Unabridged',
};

/**
 * Deterministic edition label from stable metadata only: first usable narrator display name, then
 * production form. Never use counters or enrichment data. No stable discriminator returns null so
 * the caller reviews rather than overwrites or guesses.
 */
export function deriveEditionLabel(narrators: string[], productionType?: string | null): string | null {
  // Packed native tags must yield the first usable token, not the entire placeholder-bearing string.
  for (const raw of narrators) {
    for (const part of tokenizeNarrators(raw)) {
      const normalized = normalizeNarrator(part);
      if (normalized.length > 0 && !NARRATOR_PLACEHOLDERS.has(normalized)) {
        return part.trim();
      }
    }
  }
  if (productionType && productionType !== 'unknown') {
    return PRODUCTION_FORM_LABELS[productionType] ?? null;
  }
  return null;
}

/** Duration is no-signal when missing or non-positive (mirrors `isDurationVerified`). */
function durationNoSignal(d: number | null | undefined): boolean {
  return !d || d <= 0;
}

/**
 * A production veto requires two known, different forms; one-sided or `unknown` values carry no signal.
 */
function productionTypesConflict(candidate: string | null | undefined, library: string | null | undefined): boolean {
  if (!candidate || !library || candidate === 'unknown' || library === 'unknown') return false;
  return candidate !== library;
}

/**
 * Equal-narrator corroboration can only downgrade to review. When both durations exist, the shared
 * 240-second band is authoritative and production form is ignored. Without two usable durations,
 * two known, different production forms veto the match.
 */
function corroborateWithDuration(candidate: RecordingCandidate, library: LibraryRecording): RecordingIdentityResult {
  if (!durationNoSignal(candidate.duration) && !durationNoSignal(library.duration)) {
    // Interface durations are minutes; the shared tolerance is seconds, so both sides must convert.
    return withinDurationTolerance(candidate.duration! * 60, library.duration! * 60)
      ? { verdict: 'same-recording' }
      : { verdict: 'review', recordingReviewReason: 'duration-mismatch' };
  }
  if (productionTypesConflict(candidate.productionType, library.productionType)) {
    return { verdict: 'review', recordingReviewReason: 'production-type-mismatch' };
  }
  return { verdict: 'same-recording' };
}

/**
 * Equal canonical ASIN is same-recording; a different or one-sided ASIN falls through. Otherwise
 * canonical bibliographic scope gates exact narrator-set comparison. Out-of-scope or differing
 * narrator signal is different-recording, absent narrator signal reviews, and equal narrators use
 * duration/production corroboration.
 */
export function resolveRecordingIdentity(candidate: RecordingCandidate, entry: LibraryRecording): RecordingIdentityResult {
  // Canonicalize here and when gathering incumbents so padded/case-drifted ASINs behave identically.
  const candidateAsin = canonicalizeAsin(candidate.asin);
  const entryAsin = canonicalizeAsin(entry.asin);
  if (candidateAsin && entryAsin && candidateAsin === entryAsin) {
    return { verdict: 'same-recording' };
  }

  // Share one scope predicate with incumbent gathering; author-less pairs require raw exact titles.
  const inScope = matchesLibraryIdentity(
    { title: candidate.title, asin: candidate.asin, authorName: candidate.authors[0] },
    { title: entry.title, asin: entry.asin, authorSlug: entry.primaryAuthorSlug },
  );
  if (!inScope) {
    return { verdict: 'different-recording' };
  }

  const narratorVerdict = compareRecordingNarrators(candidate.narrators, entry.narrators);
  if (narratorVerdict === 'not-equal') return { verdict: 'different-recording' };
  if (narratorVerdict === 'no-signal') return { verdict: 'review', recordingReviewReason: 'narrator-no-signal' };
  return corroborateWithDuration(candidate, entry);
}
