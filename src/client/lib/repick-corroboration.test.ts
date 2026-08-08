import { describe, it, expect } from 'vitest';
import { needsChapterCorroboration, applyCorroboration, stampRow, type CorroborationTarget } from './repick-corroboration';
import type { MatchResult, BookMetadata } from '@/lib/api';
import type { ImportRow } from '@/components/manual-import';

// The live Fablehaven case, canonical values already pinned in-repo: the scanner's RAW
// unrounded runtime, the chapter-table total (Δ 0.02s — inside the band), and the provider
// scalar of 539 minutes (Δ 879.47s — outside it).
const ASIN = 'B00CXXEX8W';
const SCANNED = 33219.47;
const PATH = '/audiobooks/Brandon Mull/Fablehaven';

const mismatchRow: MatchResult = {
  path: PATH,
  confidence: 'medium',
  bestMatch: { title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: ASIN },
  alternatives: [],
  reason: 'Duration mismatch — scanned 9h 13m vs expected 8h 59m',
  reasonKind: 'duration-mismatch',
  scannedSeconds: SCANNED,
};

/**
 * A row the match job flagged `missing-duration` — the SCAN side has a positive runtime, the
 * best match has none (`MatchReasonKind`: "duration evidence is incomplete on ONE side").
 * Re-picking an edition that DOES carry a runtime re-evaluates this row, and when that
 * runtime is out of band it lands on the very same outcome (4) a `duration-mismatch` row
 * does — so it is equally entitled to the chapter-table second opinion.
 */
const missingDurationRow: MatchResult = {
  path: PATH,
  confidence: 'medium',
  bestMatch: { title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], asin: ASIN },
  alternatives: [],
  reason: 'Best match missing duration — cannot verify',
  reasonKind: 'missing-duration',
  scannedSeconds: SCANNED,
};

/** The picked edition: the provider scalar (539 min = 32340s) is out of band vs SCANNED. */
const picked = (over: Partial<BookMetadata> = {}): BookMetadata => ({
  title: 'Fablehaven', authors: [{ name: 'Brandon Mull' }], duration: 539, asin: ASIN, ...over,
});

describe('needsChapterCorroboration (#2055)', () => {
  it('requests corroboration for an out-of-band re-pick with a scanned runtime and an ASIN', () => {
    expect(needsChapterCorroboration(mismatchRow, picked(), undefined))
      .toEqual({ asin: ASIN, scannedSeconds: SCANNED });
  });

  // The predicate keys on the outcome of the re-evaluation, NOT on the row's ORIGINAL
  // reason kind. A `missing-duration` row whose re-pick supplies the runtime that was
  // missing lands on outcome (4) too, and it must dispatch — gating on the incoming
  // `reasonKind` instead would leave every other case in this file green.
  it('requests corroboration when an original missing-duration row re-evaluates out of band', () => {
    expect(needsChapterCorroboration(missingDurationRow, picked(), undefined))
      .toEqual({ asin: ASIN, scannedSeconds: SCANNED });
  });

  it('normalizes a padded ASIN — the TRIMMED value is the canonical one', () => {
    const request = needsChapterCorroboration(mismatchRow, picked({ asin: `  ${ASIN}  ` }), undefined);
    expect(request).toEqual({ asin: ASIN, scannedSeconds: SCANNED });
  });

  it('forwards the raw unrounded scanner runtime, never a rounded stand-in', () => {
    const request = needsChapterCorroboration(mismatchRow, picked(), undefined);
    expect(request?.scannedSeconds).toBe(33219.47);
  });

  it('makes no request for an IN-BAND re-pick — the sync path already cleared it to high', () => {
    // 553 min = 33180s, Δ 39.47s from the scan: inside the 240s band.
    expect(needsChapterCorroboration(mismatchRow, picked({ duration: 553 }), undefined)).toBeUndefined();
  });

  it('makes no request when the scanned runtime is absent — precedence (1) cannot-verify', () => {
    const { scannedSeconds: _dropped, ...noScan } = mismatchRow;
    expect(needsChapterCorroboration(noScan, picked(), undefined)).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['zero', 0],
  ])('makes no request when the picked edition duration is %s — precedence (2) cannot-verify', (_label, duration) => {
    expect(needsChapterCorroboration(mismatchRow, picked({ duration }), undefined)).toBeUndefined();
  });

  it.each([
    ['no-duration-data', 'no-duration-data' as const],
    ['legacy undefined', undefined],
  ])('makes no request for a %s medium row — the sync path clears it to high', (_label, reasonKind) => {
    const row: MatchResult = { ...mismatchRow, ...(reasonKind ? { reasonKind } : {}) };
    if (!reasonKind) delete (row as { reasonKind?: unknown }).reasonKind;
    expect(needsChapterCorroboration(row, picked(), undefined)).toBeUndefined();
  });

  it('makes no request for a high row', () => {
    expect(needsChapterCorroboration({ ...mismatchRow, confidence: 'high' }, picked(), undefined)).toBeUndefined();
  });

  it('makes no request for none → medium', () => {
    expect(needsChapterCorroboration({ ...mismatchRow, confidence: 'none' }, picked(), undefined)).toBeUndefined();
  });

  it('makes no request on the by-reference no-op', () => {
    const sameRef = picked();
    expect(needsChapterCorroboration(mismatchRow, sameRef, sameRef)).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['blank', '   '],
  ])('makes no request when the picked ASIN is %s', (_label, asin) => {
    expect(needsChapterCorroboration(mismatchRow, picked({ asin }), undefined)).toBeUndefined();
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
  ])('makes no request when scannedSeconds is %s', (_label, scannedSeconds) => {
    expect(needsChapterCorroboration({ ...mismatchRow, scannedSeconds }, picked(), undefined)).toBeUndefined();
  });

  it('makes no request when there is no match result or no picked metadata', () => {
    expect(needsChapterCorroboration(undefined, picked(), undefined)).toBeUndefined();
    expect(needsChapterCorroboration(mismatchRow, undefined, undefined)).toBeUndefined();
  });
});

describe('applyCorroboration staleness guard (#2055 B8)', () => {
  const liveRow: ImportRow = {
    book: { path: PATH, parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
    selected: true,
    userEdited: true,
    matchGeneration: 7,
    edited: { title: 'Fablehaven', author: 'Brandon Mull', series: '', metadata: picked() },
    matchResult: mismatchRow,
  };
  const target: CorroborationTarget = { path: PATH, generation: 7, request: { asin: ASIN, scannedSeconds: SCANNED } };

  it('promotes the live target to high, dropping reason + reasonKind and keeping scannedSeconds', () => {
    const [patched] = applyCorroboration([liveRow], target);
    expect(patched!.matchResult?.confidence).toBe('high');
    expect(patched!.matchResult).not.toHaveProperty('reason');
    expect(patched!.matchResult).not.toHaveProperty('reasonKind');
    expect(patched!.matchResult?.scannedSeconds).toBe(SCANNED);
    expect(patched!.matchResult?.bestMatch).toEqual(mismatchRow.bestMatch);
  });

  it('accepts a padded row ASIN — both sides trim', () => {
    const padded: ImportRow = { ...liveRow, edited: { ...liveRow.edited, metadata: picked({ asin: `  ${ASIN}  ` }) } };
    expect(applyCorroboration([padded], target)[0]!.matchResult?.confidence).toBe('high');
  });

  it.each([
    ['a different generation', { matchGeneration: 8 }],
    ['no generation stamp at all', { matchGeneration: undefined }],
  ])('drops the response for %s', (_label, over) => {
    const rows = [{ ...liveRow, ...over }];
    expect(applyCorroboration(rows, target)).toBe(rows);
  });

  it('drops the response when the generation matches but the target carries no number', () => {
    const rows = [{ ...liveRow, matchGeneration: undefined }];
    expect(applyCorroboration(rows, { ...target, generation: undefined as unknown as number })).toBe(rows);
  });

  it.each([
    ['the row is no longer medium', { matchResult: { ...mismatchRow, confidence: 'high' as const } }],
    ['the reasonKind changed', { matchResult: { ...mismatchRow, reasonKind: 'missing-duration' as const } }],
    ['scannedSeconds changed', { matchResult: { ...mismatchRow, scannedSeconds: 33180 } }],
    ['the row has no match result', { matchResult: undefined }],
  ])('drops the response when %s', (_label, over) => {
    const rows = [{ ...liveRow, ...over }];
    expect(applyCorroboration(rows, target)).toBe(rows);
  });

  it('drops the response when the row now carries a different edition', () => {
    const rows = [{ ...liveRow, edited: { ...liveRow.edited, metadata: picked({ asin: 'B000OTHER' }) } }];
    expect(applyCorroboration(rows, target)).toBe(rows);
  });

  it('leaves every row at a different path byte-for-byte untouched', () => {
    const other: ImportRow = { ...liveRow, book: { ...liveRow.book, path: '/audiobooks/Other/Book' } };
    const result = applyCorroboration([other, liveRow], target);
    expect(result[0]).toBe(other);
    expect(result[1]!.matchResult?.confidence).toBe('high');
  });
});

describe('stampRow (#2060)', () => {
  const unstamped: ImportRow = {
    book: { path: PATH, parsedTitle: 'Fablehaven', parsedAuthor: 'Brandon Mull', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
    selected: true,
    userEdited: false,
    edited: { title: 'Fablehaven', author: 'Brandon Mull', series: '' },
  };

  it('returns a copy carrying the given generation, leaving the argument untouched', () => {
    const stamped = stampRow(unstamped, 5);

    expect(stamped).toEqual({ ...unstamped, matchGeneration: 5 });
    expect(stamped).not.toBe(unstamped);
    expect(unstamped).not.toHaveProperty('matchGeneration');
  });

  it('carries an already-installed matchResult through untouched — it neither inspects nor derives it', () => {
    const withMatch: ImportRow = { ...unstamped, matchResult: mismatchRow };

    const stamped = stampRow(withMatch, 5);

    expect(stamped.matchResult).toBe(mismatchRow);
    expect(stamped.matchGeneration).toBe(5);
  });

  // Pins the property order inside the four-line body (`{ ...row, matchGeneration }`, not the
  // reverse): with the spread last, a row already carrying a stamp would keep the STALE one and
  // every superseding write in both hooks would silently stop superseding.
  it('overwrites an older stamp already on the row', () => {
    expect(stampRow({ ...unstamped, matchGeneration: 3 }, 9).matchGeneration).toBe(9);
  });
});
