import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { importListExclusions, importLists } from '@db/schema.js';
import { NestedTransactionError } from '@db/serial-transactions.js';
import type { ImportListExclusionKind } from '@shared/schemas/import-list-exclusion.js';
import { ImportListExclusionService } from './import-list-exclusion.service.js';
import { createMockLogger } from '../__tests__/helpers.js';

// Real libSQL throughout: the SQL narrowing must be a superset of `matchesLibraryIdentity`, and a
// mocked db cannot fail that way — the predicate alone always says yes.

const NO_PROVENANCE = { importListId: null, importListName: null };

describe('ImportListExclusionService (DB-backed, #2305)', () => {
  let dir: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let service: ImportListExclusionService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'excl-svc-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    service = new ImportListExclusionService(db, log as unknown as FastifyBaseLogger);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // libsql can retain Windows handles; cleanup is best-effort.
    }
  });

  const exclude = async (
    identity: { title: string; asin?: string | null; authorName?: string | null },
    kind: ImportListExclusionKind = 'deleted',
  ) => (await service.recordExclusion(identity, NO_PROVENANCE, kind)).row;

  describe('identity — the ASIN arm', () => {
    it('refuses a candidate whose ASIN differs only by case and padding', async () => {
      await exclude({ title: 'Stored Title', asin: 'B0ABC12345', authorName: 'Jane Doe' });

      const match = await service.isExcluded({ title: 'Anything Else', asin: ' b0abc12345 ' });

      expect(match?.title).toBe('Stored Title');
    });

    it('admits a candidate carrying a different ASIN and no other shared identity', async () => {
      await exclude({ title: 'Stored Title', asin: 'B0ABC12345', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'Other Book', asin: 'B0ZZZ99999', authorName: 'Someone Else' })).toBeNull();
    });
  });

  describe('identity — the author + title fall-through', () => {
    it('refuses a DIFFERENT-ASIN re-narration by the same author: an ASIN miss does not short-circuit', async () => {
      await exclude({ title: 'The Reckoning', asin: 'B0AAA11111', authorName: 'Jane Doe' });

      const match = await service.isExcluded({
        title: 'The Reckoning',
        asin: 'B0BBB22222',
        authorName: 'Jane Doe',
      });

      expect(match?.asin).toBe('B0AAA11111');
    });

    it('refuses the subtitle-stripped form of an excluded title by the same author', async () => {
      await exclude({ title: 'Foo: The Reckoning', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'Foo', authorName: 'Jane Doe' })).not.toBeNull();
    });

    it('admits when BOTH sides stripped a subtitle — the title rule is non-transitive', async () => {
      await exclude({ title: 'Foo: The Reckoning', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'Foo: A Different Story', authorName: 'Jane Doe' })).toBeNull();
    });

    it('admits a genuinely different title by the same primary author', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'The Awakening', authorName: 'Jane Doe' })).toBeNull();
    });

    it('admits the same title by a different author', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: 'John Roe' })).toBeNull();
    });

  });

  describe('identity — one-sided and absent authors', () => {
    it('admits an authored candidate against an authorless exclusion', async () => {
      await exclude({ title: 'The Reckoning' });

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBeNull();
    });

    it('admits an authorless candidate against an authored exclusion', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(await service.isExcluded({ title: 'The Reckoning' })).toBeNull();
    });

    it('refuses an authorless candidate on exact title when both sides lack an author', async () => {
      await exclude({ title: 'The Reckoning' });

      expect(await service.isExcluded({ title: 'The Reckoning' })).not.toBeNull();
    });

    it('admits an authorless candidate whose title differs by one character', async () => {
      await exclude({ title: 'The Reckoning' });

      expect(await service.isExcluded({ title: 'The Reckonings' })).toBeNull();
    });

    it('refuses an authorless candidate with a DIFFERENT ASIN and an equal title (the candidate-read divergence)', async () => {
      // A `gatherIncumbentIds`-shaped `!canonicalAsin` gate would suppress the authorless-title
      // query because the candidate carries an ASIN, never fetch this row, and admit the item.
      await exclude({ title: 'The Reckoning', asin: 'B0AAA11111' });

      const match = await service.isExcluded({ title: 'The Reckoning', asin: 'B0BBB22222' });

      expect(match?.asin).toBe('B0AAA11111');
    });

    it('fetches both the ASIN arm and the authorless-title arm for one authorless candidate', async () => {
      const byAsin = await exclude({ title: 'Unrelated Title', asin: 'B0AAA11111' });
      await exclude({ title: 'The Reckoning', asin: 'B0CCC33333' });

      // Same query, two contributing disjuncts: the ASIN hit wins on the first arm.
      expect((await service.isExcluded({ title: 'The Reckoning', asin: 'B0AAA11111' }))?.id).toBe(byAsin.id);
      expect((await service.isExcluded({ title: 'The Reckoning', asin: 'B0DDD44444' }))?.title).toBe('The Reckoning');
    });

    it('refuses a whitespace-only-author book carrying a DIFFERENT ASIN', async () => {
      // `slugify('   ')` is `''`, and an empty derived slug must reach the DB as NULL: stored as
      // `''` the row sits outside the `author_slug IS NULL` disjunct the same identity queries on,
      // so the exclusion would be written and then never fetched again.
      await exclude({ title: 'The Reckoning', asin: 'B0AAA11111', authorName: '   ' });

      const match = await service.isExcluded({ title: 'The Reckoning', asin: 'B0BBB22222', authorName: '   ' });

      expect(match?.asin).toBe('B0AAA11111');
    });

    it('refuses a whitespace-only-author book carrying no ASIN on either side', async () => {
      await exclude({ title: 'The Reckoning', authorName: '   ' });

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: '   ' })).not.toBeNull();
    });

    it('refuses a punctuation-only-author book, which also slugs to an empty string', async () => {
      await exclude({ title: 'The Reckoning', authorName: '???' });

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: '!!!' })).not.toBeNull();
    });

    it('stores NULL, not an empty string, for an author name that slugs to nothing', async () => {
      const row = await exclude({ title: 'The Reckoning', authorName: '   ' });

      expect(row.authorSlug).toBeNull();
      // The raw name is still kept for display; only the derived key is normalized.
      expect(row.authorName).toBe('   ');
    });

    it('admits everything when the table is empty', async () => {
      expect(await service.isExcluded({ title: 'Anything', asin: 'B0ABC12345', authorName: 'Jane Doe' })).toBeNull();
    });
  });

  describe('recordExclusion — stored shape', () => {
    it('canonicalizes the ASIN and derives the author slug', async () => {
      const row = await exclude({ title: 'The Reckoning', asin: ' b0abc12345 ', authorName: 'Jane Doe' });

      expect(row.asin).toBe('B0ABC12345');
      expect(row.authorName).toBe('Jane Doe');
      expect(row.authorSlug).toBe('jane-doe');
    });

    it('stores a whitespace-only ASIN as null rather than an empty string', async () => {
      const row = await exclude({ title: 'The Reckoning', asin: '   ' });

      expect(row.asin).toBeNull();
    });

    it('stores null author columns for an authorless book without crashing', async () => {
      const row = await exclude({ title: 'The Reckoning', authorName: null });

      expect(row.authorName).toBeNull();
      expect(row.authorSlug).toBeNull();
    });

    it('populates createdAt from the database rather than the caller', async () => {
      const row = await exclude({ title: 'The Reckoning' });

      expect(row.createdAt).toBeInstanceOf(Date);
      expect(row.createdAt.getTime()).toBeGreaterThan(0);
    });

    it('records the originating list for display', async () => {
      const [list] = await db.insert(importLists).values({ name: 'Bestsellers', type: 'nyt', settings: {} }).returning();

      const { row } = await service.recordExclusion(
        { title: 'The Reckoning', authorName: 'Jane Doe' },
        { importListId: list!.id, importListName: 'Bestsellers' },
        'deleted',
      );

      expect(row.importListId).toBe(list!.id);
      expect(row.importListName).toBe('Bestsellers');
    });
  });

  describe('recordExclusion — convergence', () => {
    it('returns the pre-existing row and inserts nothing for an already-covered identity', async () => {
      const first = await exclude({ title: 'The Reckoning', asin: 'B0AAA11111', authorName: 'Jane Doe' });

      const insertSpy = vi.spyOn(db, 'insert');
      const second = await exclude({ title: 'The Reckoning', asin: 'B0BBB22222', authorName: 'Jane Doe' });

      expect(second.id).toBe(first.id);
      expect(insertSpy).not.toHaveBeenCalled();
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });

    it('converges two concurrent recordExclusion calls on one row and one id', async () => {
      const identity = { title: 'The Reckoning', asin: 'B0AAA11111', authorName: 'Jane Doe' };

      const [a, b] = await Promise.all([
        service.recordExclusion(identity, NO_PROVENANCE, 'added'),
        service.recordExclusion(identity, NO_PROVENANCE, 'added'),
      ]);

      expect(a.row.id).toBe(b.row.id);
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });

    it('converges with the completion order reversed', async () => {
      const identity = { title: 'The Reckoning', authorName: 'Jane Doe' };

      const second = service.recordExclusion(identity, NO_PROVENANCE, 'added');
      const first = service.recordExclusion(identity, NO_PROVENANCE, 'added');
      const [b, a] = await Promise.all([second, first]);

      expect(a.row.id).toBe(b.row.id);
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });

    it('rejects with NestedTransactionError when called inside an open transaction', async () => {
      await expect(
        db.transaction(async () => {
          await service.recordExclusion({ title: 'The Reckoning' }, NO_PROVENANCE, 'added');
        }),
      ).rejects.toBeInstanceOf(NestedTransactionError);
    });
  });

  describe('getAll / getById / delete', () => {
    async function seedAt(title: string, createdAt: Date): Promise<number> {
      const [row] = await db.insert(importListExclusions).values({ title, createdAt }).returning();
      return row!.id;
    }

    it('orders newest first and breaks a shared timestamp by descending id', async () => {
      const shared = new Date(1_700_000_000_000);
      const older = await seedAt('Older', new Date(1_699_000_000_000));
      const tieLow = await seedAt('Tie Low', shared);
      const tieHigh = await seedAt('Tie High', shared);

      const { data } = await service.getAll();

      expect(data.map((r) => r.id)).toEqual([tieHigh, tieLow, older]);
    });

    it('returns a full page with the true total at exactly the limit', async () => {
      for (const title of ['A', 'B', 'C']) await exclude({ title });

      const { data, total } = await service.getAll({ limit: 2, offset: 0 });

      expect(data).toHaveLength(2);
      expect(total).toBe(3);
    });

    it('returns an empty page with the true total when offset is past the end', async () => {
      for (const title of ['A', 'B', 'C']) await exclude({ title });

      const { data, total } = await service.getAll({ limit: 2, offset: 10 });

      expect(data).toEqual([]);
      expect(total).toBe(3);
    });

    it('returns exactly the second and third rows of its own ordering for limit 2 offset 1', async () => {
      const ids: number[] = [];
      for (let i = 1; i <= 5; i++) ids.push(await seedAt(`E${i}`, new Date(1_700_000_000_000 + i * 60_000)));

      const { data, total } = await service.getAll({ limit: 2, offset: 1 });

      expect(data.map((r) => r.id)).toEqual([ids[3], ids[2]]);
      expect(total).toBe(5);
    });

    it('getById returns null for an unknown id', async () => {
      expect(await service.getById(4242)).toBeNull();
    });

    it('delete removes the row and reports true; a second delete reports false', async () => {
      const row = await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(await service.delete(row.id)).toBe(true);
      expect(await service.delete(row.id)).toBe(false);
      expect(await db.select().from(importListExclusions)).toHaveLength(0);
    });

    it('stops refusing the item once its exclusion is deleted', async () => {
      const row = await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' });
      expect(await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' })).not.toBeNull();

      await service.delete(row.id);

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBeNull();
    });
  });

  describe('kind — the write boundary (#2530)', () => {
    it('rejects a kind outside the shared vocabulary and persists nothing', async () => {
      // The cast is what makes the guard observable: every production writer passes a literal from
      // the union, so without defeating the compile-time check this call would not compile at all.
      await expect(
        service.recordExclusion(
          { title: 'The Reckoning' },
          NO_PROVENANCE,
          'archived' as unknown as ImportListExclusionKind,
        ),
      ).rejects.toThrow();

      expect(await db.select().from(importListExclusions)).toHaveLength(0);
    });

    it('builds every writer’s value object through buildExclusionValues, normalizing ASIN and slug', () => {
      const values = service.buildExclusionValues(
        { title: 'The Reckoning', asin: ' b0abc12345 ', authorName: '   ' },
        { importListId: 3, importListName: 'Bestsellers' },
        'added',
      );

      expect(values).toEqual({
        asin: 'B0ABC12345',
        title: 'The Reckoning',
        authorName: '   ',
        authorSlug: null,
        importListId: 3,
        importListName: 'Bestsellers',
        kind: 'added',
      });
    });
  });

  describe('kind — the gate reads both, the writer scopes to one (#2530)', () => {
    it('refuses on an added row and reports its kind', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');

      const match = await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(match?.kind).toBe('added');
    });

    it('refuses on a deleted row and reports its kind', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'deleted');

      const match = await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' });

      expect(match?.kind).toBe('deleted');
    });

    it('still refuses when both kinds cover the same identity', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'deleted');

      expect(await service.isExcluded({ title: 'The Reckoning', authorName: 'Jane Doe' })).not.toBeNull();
    });

    it('INSERTS a deleted tombstone over an identity that only has an added row', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');

      const result = await service.recordExclusion(
        { title: 'The Reckoning', authorName: 'Jane Doe' },
        NO_PROVENANCE,
        'deleted',
      );

      expect(result.inserted).toBe(true);
      expect(await db.select().from(importListExclusions)).toHaveLength(2);
    });

    it('converges a repeated added record on one row', async () => {
      const first = await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');

      const second = await service.recordExclusion(
        { title: 'The Reckoning', authorName: 'Jane Doe' },
        NO_PROVENANCE,
        'added',
      );

      expect(second.inserted).toBe(false);
      expect(second.row.id).toBe(first.id);
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });

    it('recordAdded writes the added arm', async () => {
      const { row } = await service.recordAdded({ title: 'The Reckoning', authorName: 'Jane Doe' }, NO_PROVENANCE);

      expect(row.kind).toBe('added');
    });

    it('stores NULL for an added row whose author slugs to nothing, and finds it again', async () => {
      const row = await exclude({ title: 'The Reckoning', authorName: ' ?? ' }, 'added');

      expect(row.authorSlug).toBeNull();
      expect((await service.isExcluded({ title: 'The Reckoning', authorName: '!!!' }))?.id).toBe(row.id);
    });
  });

  describe('removeAdded (#2530)', () => {
    it('deletes the matching added rows and reports the count', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');

      expect(await service.removeAdded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBe(1);
      expect(await db.select().from(importListExclusions)).toHaveLength(0);
    });

    it('leaves a matching deleted tombstone untouched', async () => {
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'deleted');
      await exclude({ title: 'The Reckoning', authorName: 'Jane Doe' }, 'added');

      expect(await service.removeAdded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBe(1);

      const remaining = await db.select().from(importListExclusions);
      expect(remaining.map((r) => r.kind)).toEqual(['deleted']);
    });

    it('leaves a non-matching added row alone', async () => {
      await exclude({ title: 'The Awakening', authorName: 'Jane Doe' }, 'added');

      expect(await service.removeAdded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBe(0);
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });

    it('reports 0 against an empty table', async () => {
      expect(await service.removeAdded({ title: 'The Reckoning', authorName: 'Jane Doe' })).toBe(0);
    });

    it('honours the tolerant title arm — a subtitle-stripped form by the same author', async () => {
      await exclude({ title: 'Foo: The Reckoning', authorName: 'Jane Doe' }, 'added');

      expect(await service.removeAdded({ title: 'Foo', authorName: 'Jane Doe' })).toBe(1);
    });

    it('honours the non-transitivity rule — both sides stripped a subtitle', async () => {
      await exclude({ title: 'Foo: The Reckoning', authorName: 'Jane Doe' }, 'added');

      expect(await service.removeAdded({ title: 'Foo: A Different Story', authorName: 'Jane Doe' })).toBe(0);
      expect(await db.select().from(importListExclusions)).toHaveLength(1);
    });
  });

  describe('getAll — the kind filter (#2530)', () => {
    async function seedBoth(): Promise<void> {
      for (let i = 1; i <= 5; i++) {
        await db.insert(importListExclusions).values({
          title: `D${i}`, kind: 'deleted', createdAt: new Date(1_700_000_000_000 + i * 60_000),
        });
        await db.insert(importListExclusions).values({
          title: `A${i}`, kind: 'added', createdAt: new Date(1_700_000_000_000 + i * 60_000),
        });
      }
    }

    it('scopes both data and total to the requested kind', async () => {
      await seedBoth();

      const { data, total } = await service.getAll({ kind: 'added' });

      expect(total).toBe(5);
      expect(data.every((r) => r.kind === 'added')).toBe(true);
    });

    it('reports the unfiltered total when no kind is given', async () => {
      await seedBoth();

      expect((await service.getAll()).total).toBe(10);
    });

    it('applies the filter before pagination and keeps newest-first with a descending id tiebreak', async () => {
      await seedBoth();
      const added = (await service.getAll({ kind: 'added' })).data;

      const { data, total } = await service.getAll({ kind: 'added', limit: 2, offset: 1 });

      expect(total).toBe(5);
      expect(data.map((r) => r.id)).toEqual([added[1]!.id, added[2]!.id]);
      // Newest first, and the shared-timestamp pair below proves the id tiebreak survives the filter.
      expect(added.map((r) => r.title)).toEqual(['A5', 'A4', 'A3', 'A2', 'A1']);
    });

    it('breaks a shared timestamp by descending id under the filter', async () => {
      const shared = new Date(1_700_000_000_000);
      await db.insert(importListExclusions).values({ title: 'Tie Low', kind: 'added', createdAt: shared });
      await db.insert(importListExclusions).values({ title: 'Tie High', kind: 'added', createdAt: shared });
      await db.insert(importListExclusions).values({ title: 'Deleted Tie', kind: 'deleted', createdAt: shared });

      const { data } = await service.getAll({ kind: 'added' });

      expect(data.map((r) => r.title)).toEqual(['Tie High', 'Tie Low']);
    });
  });
});
