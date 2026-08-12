import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type { MetadataService } from '../metadata.service.js';
import { BookService } from '../book.service.js';
import { addBook } from './index.js';
import type { AddBookDeps, AddBookItem, AddBookRequest } from './index.js';

/**
 * Real libsql, real `BookService`: the unit suite proves the enriched ASIN reaches the DECISION,
 * and this proves the same value reaches the durable ROW — the half a mocked `create` cannot see.
 * It also pins the residual the precondition leaves behind: an authorless add still gets its ASIN,
 * just from `resolveCreateInput` after the decision instead of from `addBook` before it (#2249).
 */

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return noopLog; }, level: 'info', silent() {},
} as unknown as FastifyBaseLogger;

describe('addBook — pre-decision ASIN enrichment (DB-backed, #2249)', () => {
  let dir: string;
  let db: Db;
  let service: BookService;
  let getBook: ReturnType<typeof vi.fn>;
  let deps: AddBookDeps;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'add-book-asin-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    getBook = vi.fn().mockResolvedValue({ title: 'Leviathan Wakes', authors: [{ name: 'James S. A. Corey' }], asin: 'b0enriched' });
    const metadataService = { getBook } as unknown as MetadataService;
    // The same port on both sides, so a single call count settles WHICH side did the lookup.
    service = new BookService(db, noopLog, metadataService);
    deps = {
      bookService: service,
      eventHistory: { create: vi.fn().mockResolvedValue({ id: 1 }) },
      metadataService,
    };
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  function request(item: AddBookItem): AddBookRequest {
    return { item, onReview: 'refuse', resolve: 'skip', provenance: { source: 'manual', eventShape: 'snapshot' } };
  }

  async function storedAsins(): Promise<(string | null)[]> {
    return (await db.select({ asin: books.asin }).from(books)).map(r => r.asin);
  }

  it('refuses an owned ASIN with same-recording instead of collapsing a doomed INSERT into owned-race', async () => {
    // Spelled so title+author alone cannot find it: only the enriched ASIN can.
    const incumbent = await service.create({
      title: 'Leviathan Wakes: Book One of the Expanse',
      authors: [{ name: 'Corey, James S. A.' }],
      asin: 'B0ENRICHED',
      status: 'imported',
    });

    const result = await addBook(deps, request({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      providerId: '386446',
    }), noopLog);

    expect(result).toMatchObject({ outcome: 'duplicate', verdict: 'same-recording', existingBookId: incumbent.id });
    expect(await storedAsins()).toEqual(['B0ENRICHED']);
    // One lookup for the whole add: the refusal returned before `create`, so `resolveCreateInput`
    // never ran, and the pre-decision lookup is the only one there was.
    expect(getBook).toHaveBeenCalledExactlyOnceWith('386446');
  });

  // One value, both sides. Reading only the row would not distinguish the fix from today's
  // late enrichment, which lands the same ASIN on the row after deciding without it.
  it('decides on the enriched ASIN and writes that same ASIN to the durable row', async () => {
    const findDuplicate = vi.spyOn(service, 'findDuplicate');

    const result = await addBook(deps, request({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      providerId: '386446',
    }), noopLog);

    expect(result.outcome).toBe('created');
    expect(findDuplicate).toHaveBeenCalledWith(expect.objectContaining({ asin: 'b0enriched' }));
    // The provider answered lowercase; `createResolved` owns the canonicalization the partial
    // unique index keys on.
    expect(await storedAsins()).toEqual(['B0ENRICHED']);
    expect(getBook).toHaveBeenCalledTimes(1);
  });

  // AC7(b): the accepted residual. An authorless item is never enriched before the decision, so the
  // ASIN it ends up with is proof that BookService's own late lookup still runs for it.
  it('leaves an authorless add to BookService late enrichment, which still reaches the row', async () => {
    const result = await addBook(deps, request({
      title: 'Leviathan Wakes',
      authors: [],
      providerId: '386446',
    }), noopLog);

    expect(result.outcome).toBe('created');
    expect(await storedAsins()).toEqual(['B0ENRICHED']);
    expect(getBook).toHaveBeenCalledExactlyOnceWith('386446');
  });

  it('creates the row on the caller identity when the provider lookup fails', async () => {
    getBook.mockRejectedValue(new Error('provider unreachable'));

    const result = await addBook(deps, request({
      title: 'Leviathan Wakes',
      authors: [{ name: 'James S. A. Corey' }],
      providerId: '386446',
    }), noopLog);

    expect(result.outcome).toBe('created');
    expect(await storedAsins()).toEqual([null]);
    // The failed attempt still spent the add's one fetch: `providerId` was stripped, so
    // `resolveCreateInput` had nothing to retry with.
    expect(getBook).toHaveBeenCalledTimes(1);
  });
});
