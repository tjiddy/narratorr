import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { BookService, OwnedRecordingError } from './book.service.js';
import type { FastifyBaseLogger } from 'fastify';

// DB-backed coverage for the three-way, multi-incumbent `findDuplicate`, the
// `findPathOwners` cardinality contract, and the `create()` same-ASIN race
// (#1711). A mock-chain test cannot prove multi-incumbent precedence or
// order-independence (the resolver runs over rows returned in DB order); this
// seeds a real libsql DB and exercises the resolver end-to-end.

const noopLog = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {},
  child() { return noopLog; }, level: 'info', silent() {},
} as unknown as FastifyBaseLogger;

describe('BookService.findDuplicate — 3-way + multi-incumbent (DB-backed, #1711)', () => {
  let dir: string;
  let db: Db;
  let service: BookService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'book-svc-dedup-'));
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

  async function seed(opts: {
    title: string;
    author?: string;
    narrators?: string[];
    asin?: string;
    duration?: number;
    path?: string;
  }): Promise<number> {
    const book = await service.create({
      title: opts.title,
      authors: opts.author ? [{ name: opts.author }] : [],
      ...(opts.narrators && { narrators: opts.narrators }),
      ...(opts.asin && { asin: opts.asin }),
      ...(opts.duration !== undefined && { duration: opts.duration }),
      status: 'imported',
    });
    if (opts.path) {
      await service.update(book.id, { path: opts.path });
    }
    return book.id;
  }

  it('equal ASIN → same-recording (owned), even with a different title', async () => {
    const id = await seed({ title: 'The Way of Kings', author: 'Brandon Sanderson', asin: 'B003P2WO5E' });
    const res = await service.findDuplicate({ title: 'Different Title', asin: 'b003p2wo5e' });
    expect(res.verdict).toBe('same-recording');
    expect(res.book?.id).toBe(id);
    expect(res.hasIncumbent).toBe(true);
  });

  it('Tehanu under a different ASIN, same narrator → same-recording (owned)', async () => {
    const id = await seed({ title: 'Tehanu', author: 'Ursula K. Le Guin', narrators: ['Jenny Sterlin'], asin: 'B0OLDEDITION', duration: 36000 });
    const res = await service.findDuplicate({
      title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }], narrators: ['Jenny Sterlin'], asin: 'B0NEWEDITION', duration: 36100,
    });
    expect(res.verdict).toBe('same-recording');
    expect(res.book?.id).toBe(id);
    expect(res.hasIncumbent).toBe(true);
  });

  it('full-cast vs single narrator → different-recording (keep-both), hasIncumbent true', async () => {
    await seed({ title: "Harry Potter", author: 'J.K. Rowling', narrators: ['Jim Dale'], asin: 'B0JIMDALE' });
    const res = await service.findDuplicate({
      title: "Harry Potter", authors: [{ name: 'J.K. Rowling' }], narrators: ['Stephen Fry'], asin: 'B0FRY',
    });
    expect(res.verdict).toBe('different-recording');
    expect(res.book).toBeNull();
    // An incumbent existed (an owned title) but resolved different → a NEW recording of an owned title.
    expect(res.hasIncumbent).toBe(true);
  });

  it('title+author match but no narrator signal → review', async () => {
    const id = await seed({ title: 'Mistborn', author: 'Brandon Sanderson', narrators: ['Michael Kramer'] });
    const res = await service.findDuplicate({ title: 'Mistborn', authors: [{ name: 'Brandon Sanderson' }] });
    expect(res.verdict).toBe('review');
    expect(res.book?.id).toBe(id);
    expect(res.hasIncumbent).toBe(true);
  });

  it('no incumbent in scope → different-recording (new), book null, hasIncumbent false', async () => {
    const res = await service.findDuplicate({ title: 'Brand New', authors: [{ name: 'Nobody' }], narrators: ['X'] });
    expect(res.verdict).toBe('different-recording');
    expect(res.book).toBeNull();
    // No incumbent at all → a genuinely new book; the import-review badge stays absent.
    expect(res.hasIncumbent).toBe(false);
  });

  describe('multi-incumbent precedence (order-independent)', () => {
    it('any same-recording wins as owned when a different-recording row was seeded first', async () => {
      // Seed the different-recording first, the same-recording second.
      await seed({ title: 'Elantris', author: 'Brandon Sanderson', narrators: ['Jack Garrett'], asin: 'B0DIFF' });
      const owned = await seed({ title: 'Elantris', author: 'Brandon Sanderson', narrators: ['Jled Marsh'], asin: 'B0SAME' });
      const res = await service.findDuplicate({
        title: 'Elantris', authors: [{ name: 'Brandon Sanderson' }], narrators: ['Jled Marsh'],
      });
      expect(res.verdict).toBe('same-recording');
      expect(res.book?.id).toBe(owned);
    });

    it('all different-recording rows → different-recording (new)', async () => {
      await seed({ title: 'Warbreaker', author: 'Brandon Sanderson', narrators: ['Alpha One'] });
      await seed({ title: 'Warbreaker', author: 'Brandon Sanderson', narrators: ['Beta Two'] });
      const res = await service.findDuplicate({
        title: 'Warbreaker', authors: [{ name: 'Brandon Sanderson' }], narrators: ['Gamma Three'],
      });
      expect(res.verdict).toBe('different-recording');
      expect(res.book).toBeNull();
      // Two owned recordings existed, neither matched → new recording of an owned title.
      expect(res.hasIncumbent).toBe(true);
    });
  });

  describe('findPathOwners — cardinality', () => {
    it('returns 0 owners when no row claims the path', async () => {
      expect(await service.findPathOwners('/library/Nobody/Book')).toEqual([]);
    });

    it('returns exactly 1 owner', async () => {
      const id = await seed({ title: 'Owned', author: 'A', path: '/library/A/Owned' });
      const owners = await service.findPathOwners('/library/A/Owned');
      expect(owners.map((o) => o.id)).toEqual([id]);
    });

    it('returns 2+ owners for a data anomaly (two rows on one path)', async () => {
      const a = await seed({ title: 'Dup A', author: 'A', path: '/library/shared' });
      const b = await seed({ title: 'Dup B', author: 'B', path: '/library/shared' });
      const owners = await service.findPathOwners('/library/shared');
      expect(owners.map((o) => o.id).sort()).toEqual([a, b].sort());
    });
  });

  describe('create() same-ASIN race', () => {
    it('throws OwnedRecordingError carrying the incumbent on a duplicate ASIN', async () => {
      const id = await seed({ title: 'First', author: 'A', asin: 'B0UNIQUE' });
      await expect(
        service.create({ title: 'Second', authors: [{ name: 'B' }], asin: 'B0UNIQUE' }),
      ).rejects.toMatchObject({ name: 'OwnedRecordingError', existingBookId: id, reason: 'asin-owned' });
      await expect(
        service.create({ title: 'Third', authors: [{ name: 'C' }], asin: 'B0UNIQUE' }),
      ).rejects.toBeInstanceOf(OwnedRecordingError);
    });

    it('allows a create with a free (null) ASIN to coexist (NULL ≠ NULL under the partial index)', async () => {
      await seed({ title: 'NoAsin One', author: 'A' });
      const second = await service.create({ title: 'NoAsin Two', authors: [{ name: 'B' }] });
      expect(second.id).toBeGreaterThan(0);
    });
  });
});
