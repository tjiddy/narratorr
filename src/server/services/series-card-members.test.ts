import { describe, it, expect, vi } from 'vitest';
import {
  buildMembersFromState,
  compareByPositionThenTitle,
  libraryMemberCard,
  type MemberState,
  type SeriesMemberRow,
} from './series-card-members.js';
import type { MemberPoolBook } from './series-card-members.js';
import type { BookStatus } from '@shared/schemas/book.js';

let nextRowId = 1;

function hardcoverRow(overrides: Partial<SeriesMemberRow> & { title: string; position: number | null }): SeriesMemberRow {
  return {
    id: nextRowId++,
    seriesId: 1,
    bookId: null,
    hardcoverBookId: 900 + nextRowId,
    slug: `slug-${nextRowId}`,
    imageUrl: null,
    normalizedTitle: overrides.title.toLowerCase(),
    authorName: 'Frank Herbert',
    source: 'hardcover',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as SeriesMemberRow;
}

function book(id: number, title: string, seriesPosition: number | null, status: BookStatus = 'imported'): MemberPoolBook {
  return { id, title, seriesPosition, status };
}

function state(partial: Partial<MemberState>): MemberState {
  return { rows: [], pool: [], positionClearedIds: new Set(), ...partial };
}

describe('buildMembersFromState — AC9a seriesPosition projection gate', () => {
  it('projects null for a matched Hardcover row whose book carries the tombstone', () => {
    const rows = [hardcoverRow({ title: 'Hunters of Dune', position: 7 })];
    const pool = [book(580, 'Hunters of Dune', null)];

    const gated = buildMembersFromState(state({ rows, pool, positionClearedIds: new Set([580]) }));
    expect(gated.members).toEqual([
      expect.objectContaining({ title: 'Hunters of Dune', position: null, inLibrary: true, libraryBookId: 580 }),
    ]);
  });

  it('control: the same row with the id ABSENT from the set projects the cached 7', () => {
    const rows = [hardcoverRow({ title: 'Hunters of Dune', position: 7 })];
    const pool = [book(580, 'Hunters of Dune', null)];

    const ungated = buildMembersFromState(state({ rows, pool, positionClearedIds: new Set() }));
    expect(ungated.members).toEqual([
      expect.objectContaining({ title: 'Hunters of Dune', position: 7, inLibrary: true, libraryBookId: 580 }),
    ]);
  });

  it('gates on the RESOLVED book, never on the row: an unmatched row keeps its position', () => {
    const rows = [hardcoverRow({ title: 'Dune Messiah', position: 2 })];
    const pool = [book(580, 'Hunters of Dune', 7)];

    const built = buildMembersFromState(state({ rows, pool, positionClearedIds: new Set([580]) }));
    expect(built.members).toEqual([
      expect.objectContaining({ title: 'Dune Messiah', position: 2, inLibrary: false, libraryBookId: null }),
      expect.objectContaining({ title: 'Hunters of Dune', position: 7, libraryBookId: 580 }),
    ]);
  });

  it('the local/unmatched owned entry stays column-keyed — the tombstone does not gate it', () => {
    const decoupled = buildMembersFromState(state({ pool: [book(580, 'Hunters of Dune', 7)], positionClearedIds: new Set([580]) }));
    expect(decoupled.members).toEqual([expect.objectContaining({ position: 7, libraryBookId: 580 })]);

    const inAppClear = buildMembersFromState(state({ pool: [book(580, 'Hunters of Dune', null)], positionClearedIds: new Set([580]) }));
    expect(inAppClear.members).toEqual([expect.objectContaining({ position: null, libraryBookId: 580 })]);
  });

  it('sorts a gated member to the END, alongside the unnumbered ones', () => {
    const rows = [
      hardcoverRow({ title: 'Dune', position: 1 }),
      hardcoverRow({ title: 'Hunters of Dune', position: 7 }),
      hardcoverRow({ title: 'Sandworms of Dune', position: 8 }),
    ];
    const pool = [book(580, 'Hunters of Dune', null), book(581, 'Dune', 1)];

    const built = buildMembersFromState(state({ rows, pool, positionClearedIds: new Set([580]) }));
    expect(built.members.map((m) => [m.title, m.position])).toEqual([
      ['Dune', 1],
      ['Sandworms of Dune', 8],
      ['Hunters of Dune', null],
    ]);
  });

  it('leaves the matcher inputs unwidened — pool objects carry no tombstone field', async () => {
    const titleMatch = await import('./series-title-match.js');
    const spy = vi.spyOn(titleMatch, 'findInLibraryMatch');
    // Re-import through the module record bound by the subject so the spy intercepts it.
    const { buildMembersFromState: subject } = await import('./series-card-members.js');

    const pool = [book(580, 'Hunters of Dune', 7)];
    subject(state({ rows: [hardcoverRow({ title: 'Hunters of Dune', position: 7 })], pool, positionClearedIds: new Set([580]) }));

    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      for (const candidate of call[1]) {
        expect(candidate).toEqual(expect.objectContaining({ id: 580, title: 'Hunters of Dune', seriesPosition: 7 }));
        // The tombstone travels beside the pool, never merged into a candidate.
        expect(Object.keys(candidate)).not.toContain('positionCleared');
        expect(Object.keys(candidate)).not.toContain('userClearedFields');
      }
    }
    spy.mockRestore();
  });
});

describe('buildMembersFromState — libraryBucket projection (#2541)', () => {
  const byStatus: [BookStatus, string][] = [
    ['wanted', 'wanted'],
    ['searching', 'downloading'],
    ['downloading', 'downloading'],
    ['importing', 'imported'],
    ['imported', 'imported'],
    ['failed', 'failed'],
    ['missing', 'missing'],
  ];

  it.each(byStatus)('a Hardcover row matched to a %s book carries the %s bucket', (status, bucket) => {
    const rows = [hardcoverRow({ title: 'Dune Messiah', position: 2 })];
    const built = buildMembersFromState(state({ rows, pool: [book(11, 'Dune Messiah', 2, status)] }));

    expect(built.members).toEqual([
      expect.objectContaining({ title: 'Dune Messiah', inLibrary: true, libraryBookId: 11, libraryBucket: bucket }),
    ]);
  });

  it('an unmatched Hardcover row carries a null bucket alongside the null book id', () => {
    const rows = [hardcoverRow({ title: 'Children of Dune', position: 3 })];
    const built = buildMembersFromState(state({ rows, pool: [] }));

    expect(built.members).toEqual([
      expect.objectContaining({ title: 'Children of Dune', inLibrary: false, libraryBookId: null, libraryBucket: null }),
    ]);
  });

  it.each(byStatus)('a library-owned member card derives its bucket from the pool book (%s)', (status, bucket) => {
    expect(libraryMemberCard(book(12, 'God Emperor of Dune', 4, status))).toEqual(
      expect.objectContaining({ inLibrary: true, libraryBookId: 12, libraryBucket: bucket }),
    );
  });

  it('holds the linked-state invariant across a mixed local / Hardcover / unclaimed state', () => {
    const local = hardcoverRow({ title: 'Dune', position: null, source: 'local', bookId: 1 });
    const rows = [
      local,
      hardcoverRow({ title: 'Dune Messiah', position: 2 }),
      hardcoverRow({ title: 'Children of Dune', position: 3 }),
    ];
    const pool = [book(1, 'Dune', 1, 'imported'), book(2, 'Dune Messiah', 2, 'downloading'), book(3, 'Heretics of Dune', 5, 'wanted')];

    const built = buildMembersFromState(state({ rows, pool }));

    expect(built.members).toHaveLength(4);
    for (const member of built.members) {
      expect(member.libraryBucket !== null).toBe(member.inLibrary);
      expect(member.libraryBookId !== null).toBe(member.inLibrary);
    }
    expect(built.members.map((m) => [m.title, m.libraryBucket])).toEqual([
      ['Dune', 'imported'],
      ['Dune Messiah', 'downloading'],
      ['Children of Dune', null],
      ['Heretics of Dune', 'wanted'],
    ]);
  });

  it('gates position and bucket independently: a tombstoned match keeps its bucket', () => {
    const rows = [hardcoverRow({ title: 'Hunters of Dune', position: 7 })];
    const built = buildMembersFromState(state({
      rows,
      pool: [book(580, 'Hunters of Dune', 7, 'failed')],
      positionClearedIds: new Set([580]),
    }));

    expect(built.members).toEqual([
      expect.objectContaining({ position: null, libraryBookId: 580, libraryBucket: 'failed' }),
    ]);
  });

  it('keeps the bucket out of ordering — two members differing only by bucket sort by title', () => {
    const pool = [book(1, 'Zulu', 1, 'wanted'), book(2, 'Alpha', 1, 'imported')];
    const built = buildMembersFromState(state({ pool }));

    expect(built.members.map((m) => m.title)).toEqual(['Alpha', 'Zulu']);
  });
});

describe('buildMembersFromState — the pre-#2152 contract is unchanged', () => {
  it('local rows claim by book_id before the matcher runs', () => {
    const local = hardcoverRow({ title: 'Hunters of Dune', position: null, source: 'local', bookId: 580 });
    const hardcover = hardcoverRow({ title: 'Hunters of Dune', position: 7 });
    const built = buildMembersFromState(state({ rows: [local, hardcover], pool: [book(580, 'Hunters of Dune', 3)] }));

    expect(built.members).toEqual([
      expect.objectContaining({ title: 'Hunters of Dune', position: 3, libraryBookId: 580, hardcoverBookId: null }),
      expect.objectContaining({ title: 'Hunters of Dune', position: 7, inLibrary: false }),
    ]);
    expect(built.unclaimed).toEqual([]);
  });

  it('a pool book no member claims becomes its own unclaimed entry', () => {
    const built = buildMembersFromState(state({ pool: [book(1, 'Dune', 1)] }));
    expect(built.unclaimed).toEqual([book(1, 'Dune', 1)]);
    expect(built.members).toEqual([libraryMemberCard(book(1, 'Dune', 1))]);
  });
});

describe('compareByPositionThenTitle', () => {
  it('places NULL positions last and breaks ties by title', () => {
    expect(compareByPositionThenTitle(null, 'a', 1, 'b')).toBeGreaterThan(0);
    expect(compareByPositionThenTitle(1, 'a', null, 'b')).toBeLessThan(0);
    expect(compareByPositionThenTitle(1, 'b', 1, 'a')).toBeGreaterThan(0);
    expect(compareByPositionThenTitle(0, 'a', 1, 'b')).toBeLessThan(0);
  });
});
