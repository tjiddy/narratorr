import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDb, runMigrations, type Db } from '../../db/index.js';
import { books } from '../../db/schema.js';
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
    productionType?: 'unabridged' | 'abridged';
  }): Promise<number> {
    const book = await service.create({
      title: opts.title,
      authors: opts.author ? [{ name: opts.author }] : [],
      ...(opts.narrators && { narrators: opts.narrators }),
      ...(opts.asin && { asin: opts.asin }),
      ...(opts.duration !== undefined && { duration: opts.duration }),
      ...(opts.productionType && { productionType: opts.productionType }),
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

  // ─── Resolver-boundary coverage over real hydrated rows (#1729) ───
  describe('resolver boundaries (DB-backed, #1729)', () => {
    it('single-sided ASIN: null-ASIN incumbent, ASIN-bearing candidate, equal narrator → same-recording', async () => {
      // Incumbent has no ASIN, so the ASIN gather branch cannot find it — it is
      // gathered via title/author, and the resolver's both-present ASIN guard is
      // not satisfied, so the verdict comes from the title/author/narrator path.
      const id = await seed({ title: 'Single Sided', author: 'Author X', narrators: ['Jim Dale'] });
      const res = await service.findDuplicate({
        title: 'Single Sided', authors: [{ name: 'Author X' }], narrators: ['Jim Dale'], asin: 'B0SINGLE01',
      });
      expect(res.verdict).toBe('same-recording');
      expect(res.book?.id).toBe(id);
      expect(res.hasIncumbent).toBe(true);
    });

    it('padded candidate ASIN, ISOLATED to the gather path → same-recording (canonicalize, #1729 gap b)', async () => {
      // Incumbent's title/author are deliberately DIFFERENT from the candidate's, so
      // the title/author gather branch (and the resolver's title/author scope) cannot
      // match — the ASIN gather branch is the ONLY way the incumbent can be found.
      // This passes ONLY if `gatherIncumbentIds` canonicalizes the padded candidate
      // (so the incumbent is gathered) AND the resolver's ASIN short-circuit
      // canonicalizes (so it returns same-recording). A non-trimming gather → no
      // incumbent → different-recording, so this fixture cannot go falsely green via
      // a title/author fallback.
      const id = await seed({ title: 'Gather Only Title', author: 'Gather Author', narrators: ['Reader A'], asin: 'B0PADTEST1' });
      const res = await service.findDuplicate({
        title: 'Totally Different', authors: [{ name: 'Other Author' }], narrators: ['Reader B'], asin: ' b0padtest1 ',
      });
      expect(res.verdict).toBe('same-recording');
      expect(res.book?.id).toBe(id);
      expect(res.hasIncumbent).toBe(true);
    });

    it('exact 15% duration boundary over equal narrators → same-recording (inclusive)', async () => {
      // Library 36000, candidate 30600 → distance == 0.15, inclusive edge.
      const id = await seed({ title: 'Boundary Book', author: 'Dur Author', narrators: ['Jim Dale'], duration: 36000 });
      const res = await service.findDuplicate({
        title: 'Boundary Book', authors: [{ name: 'Dur Author' }], narrators: ['Jim Dale'], duration: 30600,
      });
      expect(res.verdict).toBe('same-recording');
      expect(res.book?.id).toBe(id);
    });

    it('one tick beyond the 15% duration boundary over equal narrators → review', async () => {
      // Library 36000, candidate 30599 → distance > 0.15, downgrades an equal-narrator
      // match to review over real hydrated rows.
      const id = await seed({ title: 'Beyond Boundary', author: 'Dur Author', narrators: ['Jim Dale'], duration: 36000 });
      const res = await service.findDuplicate({
        title: 'Beyond Boundary', authors: [{ name: 'Dur Author' }], narrators: ['Jim Dale'], duration: 30599,
      });
      expect(res.verdict).toBe('review');
      expect(res.book?.id).toBe(id);
      expect(res.hasIncumbent).toBe(true);
    });

    // ─── Production-type veto over real hydrated rows (#1728) ───
    it('equal narrators, no duration, known production-type mismatch → review + recordingReviewReason', async () => {
      // Abridged incumbent vs unabridged candidate, same narrator, NO duration on
      // either side: without the veto this collapses to same-recording (silent
      // skip). The veto downgrades it to review and the machine reason surfaces on
      // DuplicateResolution end-to-end.
      const id = await seed({ title: 'Veto Book', author: 'Veto Author', narrators: ['Jim Dale'], productionType: 'abridged' });
      const res = await service.findDuplicate({
        title: 'Veto Book', authors: [{ name: 'Veto Author' }], narrators: ['Jim Dale'], productionType: 'unabridged',
      });
      expect(res.verdict).toBe('review');
      expect(res.recordingReviewReason).toBe('production-type-mismatch');
      expect(res.book?.id).toBe(id);
      expect(res.hasIncumbent).toBe(true);
    });

    it('equal production type, no duration → same-recording (no veto, no reason)', async () => {
      const id = await seed({ title: 'No Veto Book', author: 'Veto Author', narrators: ['Jim Dale'], productionType: 'unabridged' });
      const res = await service.findDuplicate({
        title: 'No Veto Book', authors: [{ name: 'Veto Author' }], narrators: ['Jim Dale'], productionType: 'unabridged',
      });
      expect(res.verdict).toBe('same-recording');
      expect(res.recordingReviewReason).toBeUndefined();
      expect(res.book?.id).toBe(id);
    });

    it('author-less candidate with a whitespace-only ASIN still gathers the author-less title-only incumbent (#1729 F1)', async () => {
      // The author-less title-only gather guard (book-dedup.ts branch 3) keys off
      // `!canonicalAsin`, not raw `!candidate.asin`. `canonicalizeAsin('   ')` → null,
      // so a candidate with no authors and a whitespace-only ASIN enters branch (3)
      // and gathers the author-less incumbent. Reverting the guard to `!candidate.asin`
      // would treat '   ' as present, SKIP branch (3), gather nothing, and report
      // `hasIncumbent: false` — so the hasIncumbent assertion is the load-bearing pin.
      await seed({ title: 'Author Less Title' }); // no author, no ASIN
      const res = await service.findDuplicate({ title: 'Author Less Title', asin: '   ' });
      // Incumbent WAS gathered via the author-less title-only branch.
      expect(res.hasIncumbent).toBe(true);
      // An author-less candidate never passes the resolver's author scope (#1722),
      // so the gathered incumbent resolves to different-recording, book null.
      expect(res.verdict).toBe('different-recording');
      expect(res.book).toBeNull();
    });
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

  // ─── ASIN case-insensitivity at the write boundary + durable constraint (#1733) ───
  describe('ASIN case-insensitivity (#1733)', () => {
    it('create() rejects a case-drifted duplicate ASIN and inserts no second row', async () => {
      const id = await seed({ title: 'First', author: 'A', asin: 'B003P2WO5E' });
      await expect(
        service.create({ title: 'Second', authors: [{ name: 'B' }], asin: 'b003p2wo5e' }),
      ).rejects.toMatchObject({ name: 'OwnedRecordingError', existingBookId: id, reason: 'asin-owned' });
      // No second owned row slipped through under the case-drifted ASIN.
      const rows = await db.select({ id: books.id }).from(books);
      expect(rows).toHaveLength(1);
    });

    it('create() canonicalizes a lowercase ASIN to UPPERCASE on persist', async () => {
      const id = await seed({ title: 'Lower', author: 'A', asin: 'b003p2wo5e' });
      expect((await service.getById(id))?.asin).toBe('B003P2WO5E');
    });

    it('update() canonicalizes a lowercase ASIN to UPPERCASE on persist (direct service call)', async () => {
      const id = await seed({ title: 'ToUpdate', author: 'A' });
      await service.update(id, { asin: 'b0newvalue' });
      expect((await service.getById(id))?.asin).toBe('B0NEWVALUE');
    });

    it('fixMatch() canonicalizes a lowercase ASIN to UPPERCASE on persist', async () => {
      const id = await seed({ title: 'Original', author: 'A', asin: 'B0ORIGINAL' });
      await service.fixMatch(id, { title: 'Replaced', authors: [{ name: 'A' }], asin: 'b0replaced' });
      expect((await service.getById(id))?.asin).toBe('B0REPLACED');
    });

    describe('findAsinCollision', () => {
      it('finds a case-drifted incumbent', async () => {
        const id = await seed({ title: 'Incumbent', author: 'A', asin: 'B003P2WO5E' });
        expect(await service.findAsinCollision(-1, 'b003p2wo5e')).toMatchObject({ conflictBookId: id });
      });

      it('returns null when no row matches', async () => {
        await seed({ title: 'Incumbent', author: 'A', asin: 'B003P2WO5E' });
        expect(await service.findAsinCollision(-1, 'B0NONEXISTENT')).toBeNull();
      });

      it('excludes the source book itself (self-match is not a conflict)', async () => {
        const id = await seed({ title: 'Self', author: 'A', asin: 'B0SELF' });
        expect(await service.findAsinCollision(id, 'b0self')).toBeNull();
      });

      it('handles a null/empty argument without throwing', async () => {
        await seed({ title: 'Incumbent', author: 'A', asin: 'B0SELF' });
        expect(await service.findAsinCollision(-1, '')).toBeNull();
        expect(await service.findAsinCollision(-1, '   ')).toBeNull();
      });
    });

    describe('durable unique constraint', () => {
      it('rejects a case-drifted duplicate inserted directly (bypassing the service guard)', async () => {
        await db.insert(books).values({ publicId: 'bk_dur_1', title: 'A', asin: 'B003P2WO5E' });
        // Drizzle wraps the SQLite error; the UNIQUE message lives under `.cause`.
        const err = await db
          .insert(books)
          .values({ publicId: 'bk_dur_2', title: 'B', asin: 'b003p2wo5e' })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Error);
        expect(String((err as Error).cause ?? err)).toMatch(/UNIQUE constraint failed/);
      });

      it('tolerates multiple null-ASIN rows (partial index predicate preserved)', async () => {
        await db.insert(books).values({ publicId: 'bk_null_1', title: 'A' });
        await expect(
          db.insert(books).values({ publicId: 'bk_null_2', title: 'B' }),
        ).resolves.not.toThrow();
      });
    });
  });
});
