import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { BookService } from './book.service.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { FastifyBaseLogger } from 'fastify';

// DB-backed coverage for the case-insensitive ASIN predicate (#1537, PR-review F1).
// A mock-based test cannot prove case-insensitivity — `mockDbChain` returns its
// preloaded row regardless of the WHERE clause, so it would still pass if
// `findLibraryStatusByAsins` regressed to an exact `inArray(books.asin, asins)`
// match. This seeds a REAL libsql DB with a case-drifted asin and queries with the
// opposite casing; it FAILS under an exact predicate and passes only with the
// case-insensitive `lower(asin)` condition.

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return noopLog; }, level: 'info', silent() {},
} as unknown as FastifyBaseLogger;

describe('BookService.findLibraryStatusByAsins — case-insensitive ASIN predicate (DB-backed, #1537)', () => {
  let dir: string;
  let db: Db;
  let service: BookService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-svc-asin-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    service = new BookService(db, noopLog);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql may keep handles on Windows — best effort
    }
  });

  async function seed(asin: string | null, status: BookStatus = 'imported'): Promise<string> {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: `Book ${asin ?? 'no-asin'}`, asin, status })
      .returning();
    return row!.publicId;
  }

  it('matches a stored LOWERCASE asin for an UPPERCASE query (fails under an exact predicate)', async () => {
    const publicId = await seed('b00asin');

    const map = await service.findLibraryStatusByAsins(['B00ASIN']);

    expect(map.get('B00ASIN')).toEqual({ bookId: publicId, status: 'imported' });
  });

  it('matches a stored UPPERCASE asin for a LOWERCASE query (predicate symmetry)', async () => {
    const publicId = await seed('B00UPPER', 'downloading');

    const map = await service.findLibraryStatusByAsins(['b00upper']);

    // Map is keyed by the uppercased asin regardless of input casing.
    expect(map.get('B00UPPER')).toEqual({ bookId: publicId, status: 'downloading' });
  });

  it('does not match a different asin', async () => {
    await seed('B00AAA');

    const map = await service.findLibraryStatusByAsins(['B00BBB']);

    expect(map.size).toBe(0);
  });

  it('skips a null-asin owned book (partial unique index excludes null asins)', async () => {
    await seed(null);

    const map = await service.findLibraryStatusByAsins(['B00AAA']);

    expect(map.size).toBe(0);
  });

  it('resolves multiple case-drifted asins in one batch lookup', async () => {
    const idA = await seed('b00aaa', 'imported');
    const idB = await seed('B00bBb', 'wanted');

    const map = await service.findLibraryStatusByAsins(['B00AAA', 'B00BBB']);

    expect(map.get('B00AAA')).toEqual({ bookId: idA, status: 'imported' });
    expect(map.get('B00BBB')).toEqual({ bookId: idB, status: 'wanted' });
  });
});
