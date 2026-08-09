import { describe, it, expect, vi } from 'vitest';
import { mockDbChain } from '../__tests__/helpers.js';
import { OwnedRecordingError, buildForcedImportRefusedReason, toLibraryRecording, toRecordingCandidate, resolveDuplicate } from './book-dedup.js';
import type { BookWithAuthor } from './book.service.js';
import type { Db } from '@db/index.js';

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

// -1 means audio exists with no owning row and must never reach user-facing output.
describe('buildForcedImportRefusedReason (#1736)', () => {
  it('always sets the forced-import-refused discriminator and carries the recording reason', () => {
    const reason = buildForcedImportRefusedReason(
      new OwnedRecordingError({ existingBookId: 7, title: 'Owned', reason: 'recording-review' }),
    );
    expect(reason.kind).toBe('forced-import-refused');
    expect(reason.recordingReason).toBe('recording-review');
  });

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

// DB dedup and the copy-time collision fence share this adapter; pin its full shape against drift.
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

  it('carries productionType through from the owner row', () => {
    expect(toLibraryRecording(makeRow({ productionType: 'abridged' })).productionType).toBe('abridged');
  });
});

// Reverse gather order makes the terminal sort the only path to the lowest-ID representative.
describe('resolveDuplicate — deterministic review representative under reverse gather order (#1891 F8)', () => {
  const makeBook = (id: number): BookWithAuthor =>
    ({
      id,
      title: 'Match Title',
      authors: [{ name: 'Some Author' }],
      narrators: [{ name: `Reader ${id}` }],
      asin: null,
      duration: null,
      productionType: null,
    }) as unknown as BookWithAuthor;

  it('returns the lowest-id review incumbent even when the author query gathers the higher id first', async () => {
    const db = {
      select: vi.fn().mockReturnValue(
        mockDbChain([
          { id: 80, title: 'Match Title' },
          { id: 75, title: 'Match Title' },
        ]),
      ),
    } as unknown as Db;
    const getById = vi.fn(async (id: number) => makeBook(id));

    const res = await resolveDuplicate(db, getById, {
      title: 'Match Title',
      authors: [{ name: 'Some Author' }],
    });

    expect(res.verdict).toBe('review');
    expect(res.book?.id).toBe(75);
    expect(res.recordingReviewReason).toBeDefined();
  });
});

describe('toRecordingCandidate (#1728 productionType plumbing)', () => {
  it('forwards productionType from the candidate', () => {
    expect(toRecordingCandidate({ title: 'T', productionType: 'unabridged' }).productionType).toBe('unabridged');
  });

  it('maps an absent productionType to null', () => {
    expect(toRecordingCandidate({ title: 'T' }).productionType).toBeNull();
  });
});
