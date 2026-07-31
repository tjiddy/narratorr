import type { BookEditState } from '@/components/manual-import';
import type { BookMetadata, MatchResult } from '@/lib/api';

/**
 * The live Fablehaven case (#2055), shared by both import-hook suites so the twin
 * coverage cannot drift. Every number is a value already pinned elsewhere in the repo:
 *
 * | value                        | seconds    | existing pin                                |
 * |------------------------------|------------|---------------------------------------------|
 * | scanned file (raw, unrounded)| 33219.47   | `match-job.helpers.test.ts`                  |
 * | chapter-table runtime        | 33219.49   | `chapter-corroboration.test.ts` FABLEHAVEN_MS|
 * | provider scalar (539 min)    | 32340      | `runtimeLengthMin` 539 × 60                  |
 *
 * Δ(chapter, scanned) = 0.02s — inside the 240s band. Δ(scalar, scanned) = 879.47s —
 * outside it. Under the shared floor formatter these render as `9h 13m` and `8h 59m`,
 * exactly the strings in the reported symptom. Do NOT substitute a rounded scanned value:
 * it changes both deltas and drops the coverage that the raw scanner runtime is forwarded
 * unmodified.
 */
export const FABLEHAVEN = {
  asin: 'B00CXXEX8W',
  scannedSeconds: 33219.47,
  chapterSeconds: 33219.49,
  /** A chapter runtime that is ALSO out of band (Δ 6780.53s) — renders as `11h 6m`. */
  outOfBandChapterSeconds: 40000,
  /** The scalar-rendered Review reason the sync re-evaluation produces (#1929 outcome 4). */
  scalarReason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
} as const;

/** Non-trivial match evidence, so a promotion that reconstructs the result loses something
 *  observable (B7 / carried obligation F3). */
export const FABLEHAVEN_BEST: BookMetadata = {
  title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: FABLEHAVEN.asin,
};
export const FABLEHAVEN_ALTERNATIVES: BookMetadata[] = [
  { title: 'Fablehaven (Unabridged)', authors: [{ name: 'Brandon Mull' }], duration: 553, asin: 'B00ALT00001' },
  { title: 'Fablehaven: Book 1', authors: [{ name: 'Brandon Mull' }], duration: 540, asin: 'B00ALT00002' },
];

/** A medium `duration-mismatch` match result for `path`, as the match job emits it. */
export function fablehavenMismatch(path: string): MatchResult {
  return {
    path,
    confidence: 'medium',
    bestMatch: FABLEHAVEN_BEST,
    alternatives: FABLEHAVEN_ALTERNATIVES,
    reason: FABLEHAVEN.scalarReason,
    reasonKind: 'duration-mismatch',
    scannedSeconds: FABLEHAVEN.scannedSeconds,
  };
}

/** A FRESH picked-edition object, the way `BookEditModal` spreads an explicit re-selection.
 *  `duration` stays the 539-minute scalar unless overridden — that is the whole point. */
export function fablehavenPick(over: Partial<BookMetadata> = {}): BookMetadata {
  return { title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: FABLEHAVEN.asin, ...over };
}

/** The `BookEditState` `handleEdit` receives for an explicit re-pick. */
export function fablehavenEdit(over: Partial<BookMetadata> = {}): BookEditState {
  return { title: 'Fablehaven', author: 'Brandon Mull', series: '', metadata: fablehavenPick(over) };
}

/** A promise whose settlement the test controls, for holding a request open. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // The rejection path is always attached by the code under test; this keeps an unhandled
  // rejection from firing if a test constructs one it never dispatches.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
