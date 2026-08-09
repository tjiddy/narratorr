import { describe, it, expect, vi } from 'vitest';
import {
  buildMembersFromState,
  compareByPositionThenTitle,
  libraryMemberCard,
  type MemberState,
  type SeriesMemberRow,
} from './series-card-members.js';
import type { LibraryBookSummary } from './series-title-match.js';

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

function book(id: number, title: string, seriesPosition: number | null): LibraryBookSummary {
  return { id, title, seriesPosition };
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
        expect(Object.keys(candidate).sort()).toEqual(['id', 'seriesPosition', 'title']);
      }
    }
    spy.mockRestore();
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
