import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { ReferenceReadService } from './reference-read.service.js';
import { createMockDb, mockDbChain, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';

const db = createMockDb();
const service = new ReferenceReadService(inject<Db>(db));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReferenceReadService.list* (paginated, deterministic)', () => {
  it('returns the page rows plus the full unpaginated total', async () => {
    const rows = [
      { id: 1, publicId: 'au_a', name: 'Alpha' },
      { id: 2, publicId: 'au_b', name: 'Beta' },
    ];
    db.select
      .mockReturnValueOnce(mockDbChain(rows))
      .mockReturnValueOnce(mockDbChain([{ value: 17 }]));

    const result = await service.listAuthors({ limit: 2, offset: 0 });

    expect(result).toEqual({ data: rows, total: 17 });
  });

  it('applies the requested limit/offset to the page query', async () => {
    // Pagination forwarding only — the actual `name ASC, id ASC` order contract
    // is proven against a real in-memory DB below (mockDbChain does not evaluate
    // orderBy, so asserting it here would prove nothing about the SQL result).
    const chain = mockDbChain([]);
    db.select
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(mockDbChain([{ value: 0 }]));

    await service.listSeries({ limit: 25, offset: 50 });

    expect(chain.limit).toHaveBeenCalledWith(25);
    expect(chain.offset).toHaveBeenCalledWith(50);
  });

  it('falls back to a default limit and offset 0 when pagination is omitted', async () => {
    const chain = mockDbChain([]);
    db.select
      .mockReturnValueOnce(chain)
      .mockReturnValueOnce(mockDbChain([{ value: 0 }]));

    await service.listNarrators({});

    expect(chain.limit).toHaveBeenCalledWith(120);
    expect(chain.offset).toHaveBeenCalledWith(0);
  });

  it('coerces a missing count row to total 0', async () => {
    db.select
      .mockReturnValueOnce(mockDbChain([]))
      .mockReturnValueOnce(mockDbChain([]));

    const result = await service.listAuthors({});
    expect(result.total).toBe(0);
  });
});

describe('ReferenceReadService.getById', () => {
  it('returns the row when found', async () => {
    const row = { id: 5, publicId: 'nr_x', name: 'Kate Reading' };
    db.select.mockReturnValue(mockDbChain([row]));

    expect(await service.getNarratorById(5)).toEqual(row);
  });

  it('returns null when no row matches', async () => {
    db.select.mockReturnValue(mockDbChain([]));
    expect(await service.getSeriesById(999)).toBeNull();
  });
});

/**
 * Spin up a real in-memory libsql DB with the `authors` table CREATEd from its
 * drizzle schema definition, seeded with DUPLICATE names in scrambled insert
 * order. mockDbChain never evaluates `orderBy`, so the SQL order contract
 * (`name ASC, id ASC`) can only be proven against a real engine: a regression
 * to the wrong column or descending direction would still pass a mocked test.
 *
 * Schema kept inline so a column-name drift in src/db/schema.ts surfaces here
 * (the inserts below would fail to bind) instead of silently breaking the proof.
 */
async function loadAuthorsOrderingDb() {
  const client = createClient({ url: ':memory:' });
  const db = drizzle(client);
  await client.execute(`
    CREATE TABLE authors (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      public_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      asin TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Insert order is deliberately NOT the sorted order. Three rows share the name
  // "Alpha" so the `id ASC` tiebreak is observable; a `name ASC, id DESC` bug
  // would flip the Alpha block to 5,3,2.
  const seed: Array<[number, string]> = [
    [1, 'Beta'],
    [2, 'Alpha'],
    [3, 'Alpha'],
    [4, 'Charlie'],
    [5, 'Alpha'],
  ];
  for (const [id, name] of seed) {
    await client.execute({
      sql: 'INSERT INTO authors (id, public_id, name, slug) VALUES (?, ?, ?, ?)',
      args: [id, `au_${id}`, name, `slug-${id}`],
    });
  }
  return { db, close: () => client.close() };
}

describe('ReferenceReadService list ordering (real in-memory DB)', () => {
  // Expected order by name ASC, id ASC across the seeded rows.
  const EXPECTED_IDS = ['au_2', 'au_3', 'au_5', 'au_1', 'au_4'];
  const EXPECTED_NAMES = ['Alpha', 'Alpha', 'Alpha', 'Beta', 'Charlie'];

  let realService: ReferenceReadService;
  let close: () => void;

  beforeEach(async () => {
    const loaded = await loadAuthorsOrderingDb();
    realService = new ReferenceReadService(inject<Db>(loaded.db));
    close = loaded.close;
  });

  afterEach(() => {
    close();
  });

  it('orders results by name ASC with id ASC as a stable tiebreak', async () => {
    const { data, total } = await realService.listAuthors({ limit: 10, offset: 0 });

    expect(data.map((r) => r.publicId)).toEqual(EXPECTED_IDS);
    expect(data.map((r) => r.name)).toEqual(EXPECTED_NAMES);
    expect(total).toBe(5);
  });

  it('paginates deterministically across pages with no overlap or gap', async () => {
    const page1 = await realService.listAuthors({ limit: 2, offset: 0 });
    const page2 = await realService.listAuthors({ limit: 2, offset: 2 });
    const page3 = await realService.listAuthors({ limit: 2, offset: 4 });

    expect(page1.data.map((r) => r.publicId)).toEqual(['au_2', 'au_3']);
    expect(page2.data.map((r) => r.publicId)).toEqual(['au_5', 'au_1']);
    expect(page3.data.map((r) => r.publicId)).toEqual(['au_4']);

    // Concatenated pages reproduce the full ordered set exactly — no row dropped,
    // none seen twice — which is the deterministic-offset-pagination contract.
    const paged = [...page1.data, ...page2.data, ...page3.data].map((r) => r.publicId);
    expect(paged).toEqual(EXPECTED_IDS);
    expect(new Set(paged).size).toBe(EXPECTED_IDS.length);

    // total is the full unpaginated count on every page, independent of limit/offset.
    expect([page1.total, page2.total, page3.total]).toEqual([5, 5, 5]);
  });
});
