import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { blacklist } from '@db/schema.js';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { mockDbChain } from '../__tests__/helpers.js';
import { applyPagination, getRowsAffected } from './db-helpers.js';

describe('getRowsAffected', () => {
  it('returns the numeric rowsAffected for typical update results', () => {
    expect(getRowsAffected({ rowsAffected: 1 })).toBe(1);
    expect(getRowsAffected({ rowsAffected: 0 })).toBe(0);
    expect(getRowsAffected({ rowsAffected: 5 })).toBe(5);
  });

  it('tolerates additional libSQL result fields without misreading', () => {
    const libSqlShape = {
      rowsAffected: 3,
      lastInsertRowid: 42n,
      columns: ['id', 'name'],
      columnTypes: ['INTEGER', 'TEXT'],
      rows: [],
      toJSON: () => ({}),
    };
    expect(getRowsAffected(libSqlShape)).toBe(3);
  });

  it('throws a descriptive error when rowsAffected is missing', () => {
    expect(() => getRowsAffected({})).toThrow(/rowsAffected/);
  });

  it('throws a descriptive error when rowsAffected is explicitly undefined', () => {
    expect(() => getRowsAffected({ rowsAffected: undefined })).toThrow(/rowsAffected/);
  });

  it('throws a descriptive error when rowsAffected is non-numeric', () => {
    expect(() => getRowsAffected({ rowsAffected: '1' })).toThrow(/rowsAffected/);
    expect(() => getRowsAffected({ rowsAffected: null })).toThrow(/rowsAffected/);
  });

  it('throws when input is null or undefined', () => {
    expect(() => getRowsAffected(null)).toThrow(/rowsAffected/);
    expect(() => getRowsAffected(undefined)).toThrow(/rowsAffected/);
  });
});

// Serialize the real builder so the pagination assertions read emitted SQL, not helper internals.
const dialect = new SQLiteSyncDialect();
function toSQL(query: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((query as any).getSQL()).sql;
}
function toParams(query: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return dialect.sqlToQuery((query as any).getSQL()).params;
}

describe('applyPagination', () => {
  let dir: string;
  let db: Db;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'db-helpers-pagination-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterAll(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libSQL may retain the file handle briefly on Windows.
    }
  });

  const base = () => db.select().from(blacklist).$dynamic();

  it('emits neither limit nor offset when pagination is omitted', () => {
    const query = applyPagination(base());
    expect(toSQL(query)).toBe(toSQL(base()));
    expect(toSQL(query)).not.toMatch(/limit|offset/);
    expect(toParams(query)).toEqual([]);
  });

  it('treats an empty pagination object exactly like an omitted one', () => {
    expect(toSQL(applyPagination(base(), {}))).toBe(toSQL(applyPagination(base())));
    expect(toParams(applyPagination(base(), {}))).toEqual([]);
  });

  it('emits limit and offset with both values bound', () => {
    const query = applyPagination(base(), { limit: 10, offset: 20 });
    expect(toSQL(query)).toMatch(/limit \? offset \?$/);
    expect(toParams(query)).toEqual([10, 20]);
  });

  it('emits limit alone when offset is absent', () => {
    const query = applyPagination(base(), { limit: 10 });
    expect(toSQL(query)).toMatch(/limit \?$/);
    expect(toSQL(query)).not.toMatch(/offset/);
    expect(toParams(query)).toEqual([10]);
  });

  it('binds limit 0 rather than dropping it — a truthiness guard would return every row', () => {
    const query = applyPagination(base(), { limit: 0 });
    expect(toSQL(query)).toMatch(/limit \?$/);
    expect(toParams(query)).toEqual([0]);
  });

  it('still calls offset for 0, which Drizzle then declines to render', () => {
    const withZeroOffset = applyPagination(base(), { limit: 10, offset: 0 });
    expect(toSQL(withZeroOffset)).toBe(toSQL(applyPagination(base(), { limit: 10 })));
    expect(toParams(withZeroOffset)).toEqual([10]);

    // The SQL above cannot distinguish offset 0 from no offset, so observe the call itself.
    const chain = mockDbChain([]);
    applyPagination(chain, { limit: 10, offset: 0 });
    expect(chain.offset).toHaveBeenCalledWith(0);
  });

  it('leaves an offset without a limit bare, which SQLite rejects at execution', async () => {
    const query = applyPagination(base(), { offset: 5 });
    expect(toSQL(query)).toMatch(/offset \?$/);
    expect(toSQL(query)).not.toMatch(/limit/);
    expect(toParams(query)).toEqual([5]);

    await expect(applyPagination(base(), { offset: 5 })).rejects.toThrow();
  });

  it('renders limit before offset whichever order the helper applies them in', () => {
    expect(toSQL(applyPagination(base(), { limit: 10, offset: 20 })))
      .toBe(toSQL(base().offset(20).limit(10)));
  });

  it('can be applied repeatedly to one dynamic builder, last value winning', () => {
    const query = applyPagination(base(), { limit: 10, offset: 20 });
    expect(toParams(applyPagination(query, { limit: 5, offset: 1 }))).toEqual([5, 1]);
  });
});

describe('Drizzle builder-narrowing cast', () => {
  // The scan is scoped to the five converted services: `query` is a common identifier and a
  // repo-wide scan matches an unrelated `typeof queryClient` cast in a React Query test.
  const convertedServices = [
    '../services/blacklist.service.ts',
    '../services/event-history.service.ts',
    '../services/download.service.ts',
    '../services/book-list.service.ts',
    '../services/import-list-exclusion.service.ts',
  ];

  it('no longer appears in any of the converted pagination services', () => {
    const offenders = convertedServices.filter((relative) =>
      /as typeof query\b/.test(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
