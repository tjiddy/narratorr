import type { BookEditState } from '@/components/manual-import';
import type { BookMetadata, MatchResult } from '@/lib/api';

/**
 * Live case shared by both import hooks: chapter and raw scan differ by 0.02s, while the
 * provider scalar differs by 879.47s. Keep raw scanner precision because rounding changes both.
 */
export const FABLEHAVEN = {
  asin: 'B00CXXEX8W',
  scannedSeconds: 33219.47,
  chapterSeconds: 33219.49,
  /** Out-of-band chapter runtime for negative corroboration. */
  outOfBandChapterSeconds: 40000,
  scalarReason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
} as const;

/** Real response shape where the published total is out of band but its trimmed sum corroborates. */
export const FABLEHAVEN_TRIMMED_RESPONSE = {
  corroborated: true,
  chapterSeconds: FABLEHAVEN.outOfBandChapterSeconds,
  trimmedChapterSeconds: FABLEHAVEN.chapterSeconds,
} as const;

/** Non-trivial metadata that promotion must preserve by reference. */
export const FABLEHAVEN_BEST: BookMetadata = {
  title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: FABLEHAVEN.asin,
};
export const FABLEHAVEN_ALTERNATIVES: BookMetadata[] = [
  { title: 'Fablehaven (Unabridged)', authors: [{ name: 'Brandon Mull' }], duration: 553, asin: 'B00ALT00001' },
  { title: 'Fablehaven: Book 1', authors: [{ name: 'Brandon Mull' }], duration: 540, asin: 'B00ALT00002' },
];

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

/** Fresh explicit re-pick retaining the out-of-band 539-minute scalar by default. */
export function fablehavenPick(over: Partial<BookMetadata> = {}): BookMetadata {
  return { title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: FABLEHAVEN.asin, ...over };
}

export function fablehavenEdit(over: Partial<BookMetadata> = {}): BookEditState {
  return { title: 'Fablehaven', author: 'Brandon Mull', series: '', metadata: fablehavenPick(over) };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  // Prevent an unhandled rejection when a test creates but never dispatches the deferred.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
