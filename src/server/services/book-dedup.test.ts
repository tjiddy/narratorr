import { describe, it, expect } from 'vitest';
import { OwnedRecordingError, buildForcedImportRefusedReason, toLibraryRecording, toRecordingCandidate } from './book-dedup.js';
import type { BookWithAuthor } from './book.service.js';

// Build a minimal `BookWithAuthor` row exercising only the fields `toLibraryRecording` reads.
function makeRow(overrides: {
  title?: string;
  authors?: { name: string }[];
  narrators?: { name: string }[];
  asin?: string | null;
  duration?: number | null;
  productionType?: string | null;
} = {}): BookWithAuthor {
  return {
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: [{ name: 'Michael Kramer' }, { name: 'Kate Reading' }],
    asin: 'B0041JKFJW',
    duration: 164940,
    productionType: 'unabridged',
    ...overrides,
  } as unknown as BookWithAuthor;
}

// #1736 — the copy-time collision fence raises `OwnedRecordingError`; the worker's refused terminal
// disposition maps it into a structured `forced-import-refused` reason. The ownerless fence throw
// sites carry the `-1` sentinel (audio on disk, no row claims it) which must map to `null` so a
// user-facing reason never reports "book #-1".
describe('buildForcedImportRefusedReason (#1736)', () => {
  it('always sets the forced-import-refused discriminator and carries the recording reason', () => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 7, title: 'Owned', reason: 'recording-review' }),
    );
    expect(reason.kind).toBe('forced-import-refused');
    expect(reason.recordingReason).toBe('recording-review');
  });

  // Single-owner `recording-review` and 2+-owner `recording-review-ambiguous-owner` always carry a
  // real incumbent id → keep it.
  it.each([
    'recording-review',
    'recording-review-ambiguous-owner',
  ])('keeps a real positive existingBookId for the %s variant', (variant) => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 42, title: 'Owned', reason: variant }),
    );
    expect(reason.existingBookId).toBe(42);
    expect(reason.recordingReason).toBe(variant);
  });

  // Ownerless throw sites (`recording-review-no-disambiguator`, `recording-review-disambiguated-collision`
  // with zero path owners) carry the `-1` sentinel → must map to null.
  it.each([
    'recording-review-no-disambiguator',
    'recording-review-disambiguated-collision',
  ])('maps the -1 sentinel to null for the ownerless %s variant', (variant) => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: -1, title: 'New Recording', reason: variant }),
    );
    expect(reason.existingBookId).toBeNull();
    expect(reason.recordingReason).toBe(variant);
  });

  it('maps any non-positive id (0) to null, never reporting a bogus owner', () => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 0, title: 'X', reason: 'recording-review-no-disambiguator' }),
    );
    expect(reason.existingBookId).toBeNull();
  });
});

// #1734 — drift guard. `toLibraryRecording` is the SINGLE adapter that maps a hydrated owner row
// into the resolver's `LibraryRecording` shape for BOTH the DB-side `findDuplicate` resolver and the
// copy-time on-disk collision fence (`import-orchestration.helpers.ts` previously held a byte-for-byte
// copy, `ownerToLibraryRecording`, now deleted). Pinning the output to an explicit expected shape makes
// any future field addition / normalization change visible here, so the fence and DB dedup can never
// silently disagree on whether a path owner is the same recording.
describe('toLibraryRecording (#1734 fence/DB-dedup drift guard)', () => {
  it('maps an owner row to the exact LibraryRecording shape both paths consume', () => {
    expect(toLibraryRecording(makeRow())).toEqual({
      title: 'The Way of Kings',
      primaryAuthorSlug: 'brandon-sanderson',
      narrators: ['Michael Kramer', 'Kate Reading'],
      asin: 'B0041JKFJW',
      duration: 164940,
      productionType: 'unabridged',
    });
  });

  it('slugifies the FIRST author into primaryAuthorSlug', () => {
    expect(toLibraryRecording(makeRow({ authors: [{ name: 'Patrick Rothfuss' }, { name: 'Ignored' }] }))
      .primaryAuthorSlug).toBe('patrick-rothfuss');
  });

  it('yields an empty primaryAuthorSlug when no author is present', () => {
    expect(toLibraryRecording(makeRow({ authors: [] })).primaryAuthorSlug).toBe('');
  });

  it('maps every narrator to its name and nulls absent asin/duration/productionType', () => {
    expect(toLibraryRecording(makeRow({ asin: null, duration: null, productionType: null }))).toEqual({
      title: 'The Way of Kings',
      primaryAuthorSlug: 'brandon-sanderson',
      narrators: ['Michael Kramer', 'Kate Reading'],
      asin: null,
      duration: null,
      productionType: null,
    });
  });

  // #1728 — the production form is the discriminator behind the resolver's veto;
  // pin that `toLibraryRecording` carries it through so the veto is not inert.
  it('carries productionType through from the owner row', () => {
    expect(toLibraryRecording(makeRow({ productionType: 'abridged' })).productionType).toBe('abridged');
  });
});

// #1728 — the candidate adapter must forward `productionType` so the resolver's
// production-type veto can fire; an omitted value maps to null (no veto signal).
describe('toRecordingCandidate (#1728 productionType plumbing)', () => {
  it('forwards productionType from the candidate', () => {
    expect(toRecordingCandidate({ title: 'T', productionType: 'unabridged' }).productionType).toBe('unabridged');
  });

  it('maps an absent productionType to null', () => {
    expect(toRecordingCandidate({ title: 'T' }).productionType).toBeNull();
  });
});
