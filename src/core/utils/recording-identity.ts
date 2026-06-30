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

import { normalizeNarrator, tokenizeNarrators, NARRATOR_PLACEHOLDERS } from './similarity.js';
import { matchesLibraryIdentity } from '../../shared/dedup.js';
import { canonicalizeAsin } from '../../shared/asin.js';
import type { RecordingVerdict, RecordingReviewReason } from '../../shared/schemas/recording-verdict.js';

/**
 * 3-way recording-identity verdict (#1741). Canonical source is the shared
 * `recordingVerdictValues` tuple (`src/shared/schemas/recording-verdict.ts`);
 * core re-exports the derived type — the boundary forbids `src/shared` importing
 * `src/core`, so the tuple lives in shared and core consumes it, not the reverse.
 * Existing consumers (`book-dedup.ts`, `match-job.helpers.ts`) keep importing
 * `RecordingVerdict` from here unchanged.
 */
export type { RecordingVerdict, RecordingReviewReason } from '../../shared/schemas/recording-verdict.js';

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

/** A narrator side split into usable signal tokens plus whether any placeholder was seen. */
interface NarratorTokens {
  signal: Set<string>;
  hasPlaceholder: boolean;
}

/**
 * Split each raw entry on `[,;&]` before normalizing (#1725), so a packed
 * `['Kate Reading, Michael Kramer']` — the one-element shape native-tag scans
 * deliver — counts as two people, not one token, and lines up with the
 * one-name-per-row library side. Mirrors `fileNarratorTokens` (`similarity.ts`):
 * split → normalize → filter. Tracks placeholder presence separately so the
 * comparison layer can distinguish a one-sided placeholder from real signal
 * instead of silently dropping it.
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
  const { signal: setA, hasPlaceholder: placeholderA } = recordingNarratorTokens(a);
  const { signal: setB, hasPlaceholder: placeholderB } = recordingNarratorTokens(b);
  // A placeholder present on only ONE side (e.g. a full-cast edition that also
  // credits its lead, `['Full Cast', 'Jim Dale']` vs `['Jim Dale']`) carries no
  // comparable signal — dropping it and comparing the survivors would falsely
  // equate it with a solo incumbent and silently overwrite. Evaluated BEFORE the
  // size-0 guard so a one-sided placeholder can never collapse to the survivor
  // set (#1725). Symmetric placeholders fall through and compare survivors as before.
  if (placeholderA !== placeholderB) return 'no-signal';
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
  /**
   * Canonical production form (#1728), nullable like `deriveEditionLabel`'s param
   * rather than the `ProductionType` union, to avoid coupling core to that enum.
   * A veto toward `review` only — never a positive identity signal. `null`/
   * `undefined`/`'unknown'` are all treated as "no production-type signal".
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
  /** Canonical production form (#1728) — see `RecordingCandidate.productionType`. */
  productionType?: string | null;
}

/**
 * Resolver result (#1728). `recordingReviewReason` is the MACHINE reason a
 * `review` verdict was reached; it is populated ONLY when `verdict === 'review'`
 * and is pure data (core stays free of any server/logger import). Callers that
 * only need the verdict read `.verdict`.
 */
export interface RecordingIdentityResult {
  verdict: RecordingVerdict;
  recordingReviewReason?: RecordingReviewReason;
}

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
 * True when both production forms carry a known, comparable, DIFFERENT signal —
 * the veto condition (#1728). `null`/`undefined`/`'unknown'` is "no signal" on
 * either side (mirrors how `durationNoSignal` treats missing duration), so a
 * one-sided known value can never veto.
 */
function productionTypesConflict(candidate: string | null | undefined, library: string | null | undefined): boolean {
  if (!candidate || !library || candidate === 'unknown' || library === 'unknown') return false;
  return candidate !== library;
}

/**
 * Corroborate an equal-narrator match (#1710, #1728). Narrator is primary; this
 * can only DOWNGRADE the equal match to `review`, never flip it to
 * `different-recording`. Two corroborators, in priority order:
 *
 *  1. Duration (authoritative when present): both sides present + within the 15%
 *     band → `same-recording` (the Tehanu case); beyond the band → `review`
 *     (`duration-mismatch`). When duration corroborates, production form is
 *     ignored — two unabridged readings whose `productionType` happens to differ
 *     must not be forced to review when their durations agree.
 *  2. Production-form veto (#1728): ONLY on the no-signal-duration branch (either
 *     side missing/zero). When both forms are known and different (e.g. unabridged
 *     vs abridged) → `review` (`production-type-mismatch`); otherwise the
 *     equal-narrator match stands as `same-recording`.
 */
function corroborateWithDuration(candidate: RecordingCandidate, library: LibraryRecording): RecordingIdentityResult {
  if (!durationNoSignal(candidate.duration) && !durationNoSignal(library.duration)) {
    const distance = Math.abs(candidate.duration! - library.duration!) / library.duration!;
    return distance <= DURATION_TOLERANCE ? { verdict: 'same-recording' } : { verdict: 'review', recordingReviewReason: 'duration-mismatch' };
  }
  if (productionTypesConflict(candidate.productionType, library.productionType)) {
    return { verdict: 'review', recordingReviewReason: 'production-type-mismatch' };
  }
  return { verdict: 'same-recording' };
}

/**
 * Resolve whether `candidate` is the same recording as the library `entry`,
 * a different recording, or needs human review (#1710).
 *
 *  1. ASIN equal (canonical form, both present) → `same-recording`. The ONLY
 *     ASIN-based conclusion — a *different* ASIN does NOT short-circuit (Tehanu is
 *     a different Audible ASIN of the same recording), it defers to narrator.
 *  2. else delegate the bibliographic-scope gate to the canonical
 *     `matchesLibraryIdentity` (#1726): normalized title + primary-author slug for
 *     authored rows, raw exact-title for author-less rows on BOTH sides. No scope →
 *     step 4.
 *  3. narrator predicate over the two sets:
 *       not-equal (incl. superset/subset) → `different-recording`;
 *       no-signal → `review`;
 *       equal → duration corroborator → `same-recording` or `review`.
 *  4. not in scope → `different-recording` (new).
 */
export function resolveRecordingIdentity(candidate: RecordingCandidate, entry: LibraryRecording): RecordingIdentityResult {
  // (1) ASIN equal — the only ASIN-based conclusion. Both sides are reduced to the
  // shared canonical form (trim + UPPERCASE → null on blank, #1733) before compare,
  // so a padded/case-drifted pre-write candidate (`' B01ABC '`) still matches a
  // stored canonical ASIN. `canonicalizeAsin` folds blank/whitespace to null, so a
  // one-sided or empty ASIN can never satisfy the both-present guard and falls
  // through to the scope + narrator path (#1729). The earlier `gatherIncumbentIds`
  // site canonicalizes identically so the two never drift.
  const candidateAsin = canonicalizeAsin(candidate.asin);
  const entryAsin = canonicalizeAsin(entry.asin);
  if (candidateAsin && entryAsin && candidateAsin === entryAsin) {
    return { verdict: 'same-recording' };
  }

  // (2) bibliographic-scope gate — delegate to the canonical `matchesLibraryIdentity`
  // so the resolver, `matchesLibraryIdentity`, and the `gatherIncumbentIds` predicate
  // share ONE scope contract and cannot drift (#1726). This covers the authored arm
  // (normalized title + position-0 author slug) AND the author-less arm (both sides
  // author-less → raw exact-title equality); a one-sided author-less pair is not in
  // scope. The ASIN-equal case is already resolved above, so a different/missing ASIN
  // simply falls through `matchesLibraryIdentity`'s ASIN arm to its title/author ladder.
  const inScope = matchesLibraryIdentity(
    { title: candidate.title, asin: candidate.asin, authorName: candidate.authors[0] },
    { title: entry.title, asin: entry.asin, authorSlug: entry.primaryAuthorSlug },
  );
  if (!inScope) {
    // (4) not in scope → different recording.
    return { verdict: 'different-recording' };
  }

  // (3) narrator predicate.
  const narratorVerdict = compareRecordingNarrators(candidate.narrators, entry.narrators);
  if (narratorVerdict === 'not-equal') return { verdict: 'different-recording' };
  if (narratorVerdict === 'no-signal') return { verdict: 'review', recordingReviewReason: 'narrator-no-signal' };
  return corroborateWithDuration(candidate, entry);
}
