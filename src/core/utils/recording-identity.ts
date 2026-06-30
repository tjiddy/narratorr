/**
 * Recording-identity primitive (#1710, Multiple Narrations 1/3).
 *
 * Distinguishes "the same recording I already own" from "a different recording of
 * a book I own" so a library can hold more than one recording of the same book
 * (unabridged + full-cast, two narrators, …). Two parts:
 *
 *  - `compareRecordingNarrators` — a pure narrator-SET equality predicate. Unlike
 *    `compareNarratorSignals` (`similarity.ts`), which is asymmetric set-OVERLAP
 *    and returns `match` on a single pairwise hit, this requires both-direction
 *    containment: a superset (full cast ⊃ single narrator) is NOT equal.
 *  - `resolveRecordingIdentity` — the 3-way `same-recording | different-recording
 *    | review` verdict over a candidate and one library recording.
 *
 * Core layer: imports `src/shared` (slug + title normalizer) and the sibling
 * narrator primitives, never server types. The resolver's I/O are plain-primitive
 * shapes; story 2's caller adapts a hydrated `BookWithAuthor` into them. Nothing
 * is wired to this yet — it merges with zero behavior change.
 */

import { normalizeNarrator, NARRATOR_PLACEHOLDERS } from './similarity.js';
import { normalizeTitleForDedup } from '../../shared/dedup.js';
import { slugify } from '../../shared/utils.js';

/** Narrator-set comparison verdict. Duration is NOT an input — the resolver applies it separately. */
export type NarratorEquality = 'equal' | 'not-equal' | 'no-signal';

/**
 * Relaxed duration tolerance band (15%) for the equal-narrator corroborator.
 * COPIED (not imported) from `match-job.helpers.ts`'s `DURATION_THRESHOLD_RELAXED`
 * to keep core free of server imports — two unabridged readings of one book are
 * ~the same length, so duration can only *downgrade* an equal-narrator match,
 * never separate editions on its own.
 */
const DURATION_TOLERANCE = 0.15;

/** Normalized, signal-carrying narrator tokens: normalize each → drop empties and placeholders. */
function recordingNarratorTokens(narrators: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const raw of narrators) {
    const normalized = normalizeNarrator(raw);
    if (normalized.length > 0 && !NARRATOR_PLACEHOLDERS.has(normalized)) tokens.add(normalized);
  }
  return tokens;
}

/** True when every member of `a` is in `b`. */
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Compare two recording narrator-sets with both-direction containment (#1710).
 *
 * - `no-signal` — either side normalizes to NO usable tokens (empty, punctuation-
 *   only like `'-'`/`'.'`, or all-placeholder like `['full cast']`/`['various']`).
 *   An asymmetric real-vs-placeholder pair is `no-signal`, not a spurious mismatch.
 * - `equal` — the two normalized sets are exactly equal (each contains the other).
 * - `not-equal` — both sides carry signal but the sets differ: a SUPERSET (file
 *   `{A,B}` vs edition `{A}`) and a SUBSET (file `{A}` vs edition `{A,B}`) are both
 *   not-equal. A different recording, never a match.
 *
 * Reuses `normalizeNarrator` + `NARRATOR_PLACEHOLDERS` and does its own local
 * placeholder filtering — it does NOT call `compareNarratorSignals`.
 */
export function compareRecordingNarrators(a: string[], b: string[]): NarratorEquality {
  const setA = recordingNarratorTokens(a);
  const setB = recordingNarratorTokens(b);
  if (setA.size === 0 || setB.size === 0) return 'no-signal';
  if (setA.size === setB.size && isSubset(setA, setB)) return 'equal';
  return 'not-equal';
}

/** Plain-primitive candidate shape (core-safe — no server row types). */
export interface RecordingCandidate {
  title: string;
  authors: string[];
  narrators: string[];
  duration?: number | null;
  asin?: string | null;
}

/** Plain-primitive library-recording shape. Callers precompute `primaryAuthorSlug`. */
export interface LibraryRecording {
  title: string;
  primaryAuthorSlug: string;
  narrators: string[];
  duration?: number | null;
  asin?: string | null;
}

/** 3-way recording-identity verdict. */
export type RecordingVerdict = 'same-recording' | 'different-recording' | 'review';

/** Human-readable labels for the production forms that can stand in as an edition discriminator. */
const PRODUCTION_FORM_LABELS: Record<string, string> = {
  full_cast: 'Full Cast',
  dramatized: 'Dramatized',
  graphic_audio: 'GraphicAudio',
  abridged: 'Abridged',
  unabridged: 'Unabridged',
};

/**
 * Derive a deterministic edition discriminator for a recording from STABLE
 * metadata only (#1711) — never a `(2)` counter and never post-enrichment data,
 * so a rescan re-derives the same label rather than spawning a phantom folder.
 *
 * Priority: the primary signal-carrying narrator's display name (the strongest
 * discriminator between two readings of one book), falling back to the
 * production form when no usable narrator signal exists. Returns `null` when
 * nothing stable distinguishes the recording — the caller then takes the review
 * disposition rather than overwriting or guessing.
 */
export function deriveEditionLabel(narrators: string[], productionType?: string | null): string | null {
  for (const raw of narrators) {
    const normalized = normalizeNarrator(raw);
    if (normalized.length > 0 && !NARRATOR_PLACEHOLDERS.has(normalized)) {
      return raw.trim();
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
 * Duration corroborator — only ever runs on the equal-narrator branch. Narrator is
 * primary; duration can only DOWNGRADE an equal match to `review`, never flip it to
 * `different-recording` and never block on absence:
 *  - either side missing/zero → no-signal → `same-recording` on narrator equality alone.
 *  - both present, within the 15% band → `same-recording` (the Tehanu case).
 *  - both present, beyond the band → `review` (abridged-vs-unabridged ambiguity).
 */
function corroborateWithDuration(candidate: number | null | undefined, library: number | null | undefined): RecordingVerdict {
  if (durationNoSignal(candidate) || durationNoSignal(library)) return 'same-recording';
  const distance = Math.abs(candidate! - library!) / library!;
  return distance <= DURATION_TOLERANCE ? 'same-recording' : 'review';
}

/**
 * Resolve whether `candidate` is the same recording as the library `entry`,
 * a different recording, or needs human review (#1710).
 *
 *  1. ASIN equal (case-insensitive, both present) → `same-recording`. The ONLY
 *     ASIN-based conclusion — a *different* ASIN does NOT short-circuit (Tehanu is
 *     a different Audible ASIN of the same recording), it defers to narrator.
 *  2. else scope by normalized title (`normalizeTitleForDedup`) + primary-author
 *     slug. No match → step 4.
 *  3. narrator predicate over the two sets:
 *       not-equal (incl. superset/subset) → `different-recording`;
 *       no-signal → `review`;
 *       equal → duration corroborator → `same-recording` or `review`.
 *  4. no title+author match → `different-recording` (new).
 */
export function resolveRecordingIdentity(candidate: RecordingCandidate, entry: LibraryRecording): RecordingVerdict {
  // (1) ASIN equal — the only ASIN-based conclusion.
  if (candidate.asin && entry.asin && candidate.asin.toLowerCase() === entry.asin.toLowerCase()) {
    return 'same-recording';
  }

  // (2) title + primary-author slug scope. A different ASIN falls through here.
  const candidateSlug = slugify(candidate.authors[0] ?? '');
  const titleMatch = normalizeTitleForDedup(candidate.title) === normalizeTitleForDedup(entry.title);
  if (!titleMatch || candidateSlug !== entry.primaryAuthorSlug) {
    // (4) no title+author match → different recording.
    return 'different-recording';
  }

  // (3) narrator predicate.
  const narratorVerdict = compareRecordingNarrators(candidate.narrators, entry.narrators);
  if (narratorVerdict === 'not-equal') return 'different-recording';
  if (narratorVerdict === 'no-signal') return 'review';
  return corroborateWithDuration(candidate.duration, entry.duration);
}
