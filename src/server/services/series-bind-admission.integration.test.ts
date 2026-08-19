import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { authors, bookAuthors, books, seriesMembers } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { spyStatements, poolStatements } from '../__tests__/statement-spy.js';
import { SeriesCardService } from './series-card.service.js';
import { MAX_BIND_SET_REACQUIRES, SeriesBindChurnError } from './series-bind-admission.js';
import { BookService } from './book.service.js';
import { BookDeletionService } from './book-deletion.service.js';
import { refreshScanBook } from './refresh-scan.service.js';
import { runEnrichment } from '../jobs/enrichment.js';
import type { SettingsService } from './settings.service.js';
import type { MetadataService } from './metadata.service.js';
import type { DownloadService } from './download.service.js';
import type { DownloadOrchestrator } from './download-orchestrator.js';

vi.mock('../config.js', () => ({ config: { configPath: '/test-config' } }));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
  cleanCoverCache: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('@core/utils/audio-processor.js', () => ({ resolveFfmpegPath: vi.fn().mockResolvedValue(undefined) }));

/**
 * Wrapping both entry points (rather than replacing them) keeps the REAL registry in play, so an
 * ordering assertion still observes genuine mutual exclusion. `withBookAdmissionLocks` calls the
 * module-local `withBookAdmissionLock`, so the single-lock spy counts only external acquisitions —
 * which is exactly what the post-bind matrix and the "null arms take no lock" cases need.
 */
vi.mock('../utils/book-admission-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/book-admission-lock.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(actual.withBookAdmissionLock),
    withBookAdmissionLocks: vi.fn(actual.withBookAdmissionLocks),
  };
});

import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { hasPendingBookAdmission, withBookAdmissionLock, withBookAdmissionLocks } from './book-admission.js';

const actualLocks = await vi.importActual<typeof import('../utils/book-admission-lock.js')>('../utils/book-admission-lock.js');
const ORIGINAL_FETCH = globalThis.fetch;

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

/** Members are `[position, hardcoverBookId, title]`. */
function seriesPayload(id: number, name: string, author: string, members: readonly [number | null, number, string][]): unknown {
  return {
    data: {
      series: [{
        id, name, slug: `series-${id}`, author: { name: author },
        book_series: members.map(([position, bookId, title]) => ({
          position,
          book: { id: bookId, slug: `book-${bookId}`, title, image: null, users_count: 100 },
        })),
      }],
    },
  };
}

describe('series bind admission protocol (#2447)', () => {
  let dir: string;
  let root: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let logger: FastifyBaseLogger;
  let bookService: BookService;
  let deletionService: BookDeletionService;

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ path: root, folderFormat: '{author}/{title}', fileFormat: '' }),
  });

  const cardService = () => new SeriesCardService(db, logger, inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ hardcoverApiKey: 'TEST_KEY' }),
  }));

  const keylessCardService = () => new SeriesCardService(db, logger, inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ hardcoverApiKey: '' }),
  }));

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(withBookAdmissionLock).mockImplementation(actualLocks.withBookAdmissionLock);
    vi.mocked(withBookAdmissionLocks).mockImplementation(actualLocks.withBookAdmissionLocks);
    vi.mocked(scanAudioDirectory).mockResolvedValue({
      codec: 'aac', bitrate: 64000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr',
      fileFormat: 'M4B', fileCount: 1, totalSize: 1000, totalDuration: 600, hasCoverArt: false,
    } as never);

    dir = mkdtempSync(join(tmpdir(), 'series-bind-admission-'));
    root = join(dir, 'library');
    await mkdir(root, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    logger = inject<FastifyBaseLogger>(log);

    bookService = new BookService(db, logger);
    deletionService = new BookDeletionService(
      db,
      bookService,
      inject<DownloadService>({ getActiveByBookId: vi.fn().mockResolvedValue([]) }),
      inject<DownloadOrchestrator>({ cancel: vi.fn() }),
      settings(),
      logger,
    );
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  async function seedBook(opts: {
    title: string;
    seriesName: string | null;
    seriesPosition?: number | null;
    author?: string;
    withFolder?: boolean;
  }): Promise<number> {
    const values: Record<string, unknown> = {
      publicId: generatePublicId('bk'),
      title: opts.title,
      seriesName: opts.seriesName,
      seriesPosition: opts.seriesPosition ?? null,
    };
    if (opts.withFolder) {
      const folder = join(root, opts.title.replace(/[^a-z0-9]+/gi, '-'));
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'part1.m4b'), 'audio');
      values.path = folder;
      values.status = 'imported';
    }
    const [book] = await db.insert(books).values(values as never).returning();
    const name = opts.author ?? 'Ursula K. Le Guin';
    const slug = name.toLowerCase().replace(/\s+/g, '-');
    const existing = await db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id
      ?? (await db.insert(authors).values({ publicId: generatePublicId('au'), name, slug }).returning())[0]!.id;
    await db.insert(bookAuthors).values({ bookId: book!.id, authorId, position: 0 });
    return book!.id;
  }

  function mockHardcover(payload: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    return fetchMock;
  }

  const rowFor = async (id: number) => (await db.select().from(books).where(eq(books.id, id)))[0];

  /**
   * Park AFTER the pre-lock enumeration and BEFORE the first acquisition. `onParked` runs while the
   * bind holds nothing, so a contender it issues completes freely.
   */
  function parkBeforeAcquisition(): { gate: { resolve: () => void }; entered: Promise<void> } {
    const gate = deferred();
    const entered = deferred();
    vi.mocked(withBookAdmissionLocks).mockImplementationOnce(async (ids, fn) => {
      entered.resolve();
      await gate.promise;
      return actualLocks.withBookAdmissionLocks(ids, fn);
    });
    return { gate, entered: entered.promise };
  }

  /**
   * Park AFTER acquisition and the in-lock snapshot, BEFORE `db.transaction` opens — the only moment
   * at which the admission locks alone are held. Parking inside the transaction instead would let
   * the serialized-transaction lane produce the asserted ordering on its own, leaving the
   * acquisition-deletion counterfactual green (layered-lock-boundary-park-point).
   */
  function parkBeforeBindTransaction(): { gate: { resolve: () => void }; entered: Promise<void>; restore: () => void } {
    const gate = deferred();
    const entered = deferred();
    type TxFn = Db['transaction'];
    const original = db.transaction.bind(db) as TxFn;
    let armed = true;
    (db as { transaction: TxFn }).transaction = (async (cb: never) => {
      if (armed) {
        armed = false;
        entered.resolve();
        await gate.promise;
      }
      return original(cb);
    }) as TxFn;
    return { gate, entered: entered.promise, restore: () => { (db as { transaction: TxFn }).transaction = original; } };
  }

  // ── AC4: the initiator's controlling snapshot is the in-lock read ────────────────────────────

  describe('the stale controlling snapshot (AC4)', () => {
    it('writes the seriesPosition the initiator carries at lock time, not the one read before the fetch', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Old Cycle', seriesPosition: 3 });
      mockHardcover(seriesPayload(4242, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'Some Other Book']]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4242);
      await park.entered;

      await withBookAdmissionLock(initiator, () =>
        bookService.update(initiator, { seriesPosition: 9 }, { userAsserted: true }));
      park.gate.resolve();
      await bind;

      // The unmatched-initiator arm re-asserts seriesPosition; reading it before the fetch would
      // resurrect 3 over the 9 an enrolled mutator had just committed.
      expect((await rowFor(initiator))!.seriesPosition).toBe(9);
      expect((await rowFor(initiator))!.seriesName).toBe('Earthsea Quartet');
    });

    it('builds the match-set targets from the in-lock prior name, so a stale sibling is not swept in', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Old Name', seriesPosition: 1 });
      const sibling = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Old Name', seriesPosition: 2 });
      mockHardcover(seriesPayload(4243, 'Canonical Name', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'],
        [2, 5002, 'The Tombs of Atuan'],
      ]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4243);
      await park.entered;

      const before = await rowFor(sibling);
      await bookService.fixMatch(initiator, {
        asin: 'B0000001', title: 'A Wizard of Earthsea', authors: [{ name: 'Ursula K. Le Guin' }],
        seriesName: 'Other Name', seriesPosition: 1,
      });
      park.gate.resolve();
      const bound = await bind;

      // 'Old Name' is no longer the initiator's prior name, so the sibling that only carries it is
      // outside the targets and outside the batch.
      expect(bound!.syncedIds).toEqual([initiator]);
      const after = await rowFor(sibling);
      expect(after!.seriesName).toBe('Old Name');
      expect(after!.seriesPosition).toBe(before!.seriesPosition);
      expect(after!.updatedAt).toEqual(before!.updatedAt);
    });

    it('returns null and writes nothing when the initiator is deleted under the fetch', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Old Name', seriesPosition: 1 });
      const bystander = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Old Name', seriesPosition: 2 });
      mockHardcover(seriesPayload(4244, 'Old Name', 'Ursula K. Le Guin', [[2, 5002, 'The Tombs of Atuan']]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4244);
      await park.entered;

      const before = await rowFor(bystander);
      expect(await deletionService.deleteBook(initiator, { deleteFiles: false })).toMatchObject({ outcome: 'deleted' });
      park.gate.resolve();

      expect(await bind).toBeNull();
      expect(await rowFor(initiator)).toBeUndefined();
      expect(await rowFor(bystander)).toEqual(before);
    });

    it('honours a seriesPosition tombstone a concurrent mutator wrote while the bind was parked', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea', seriesPosition: 1 });
      const sibling = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Earthsea', seriesPosition: 2 });
      mockHardcover(seriesPayload(4245, 'Earthsea', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'],
        [7, 5002, 'The Tombs of Atuan'],
      ]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4245);
      await park.entered;

      await withBookAdmissionLock(sibling, () =>
        bookService.update(sibling, { seriesPosition: null }, { userAsserted: true }));
      park.gate.resolve();
      await bind;

      const row = await rowFor(sibling);
      expect(JSON.parse(row!.userClearedFields ?? '[]')).toContain('seriesPosition');
      // The column is omitted entirely for a tombstoned book, so position 7 never lands.
      expect(row!.seriesPosition).toBeNull();
      expect(row!.seriesName).toBe('Earthsea');
    });
  });

  // ── AC2: ordered boundary against every enrolled contender ───────────────────────────────────

  describe('ordered boundary against enrolled contenders (AC2)', () => {
    async function twoBookSeries(): Promise<{ initiator: number; sibling: number }> {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea', seriesPosition: 1, withFolder: true });
      const sibling = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Earthsea', seriesPosition: 2, withFolder: true });
      mockHardcover(seriesPayload(4250, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'],
        [2, 5002, 'The Tombs of Atuan'],
      ]));
      return { initiator, sibling };
    }

    /** Every contender is issued against a book IN the batch while the bind holds the locks only. */
    async function assertContenderWaits(
      sibling: number,
      issue: () => Promise<unknown>,
      park: ReturnType<typeof parkBeforeBindTransaction>,
    ): Promise<void> {
      const getById = vi.spyOn(bookService, 'getById');
      const before = await rowFor(sibling);
      const contender = issue();
      let done = false;
      void contender.then(() => { done = true; }, () => { done = true; });
      await settle();

      // It has not reached its own first read, and the durable row still shows pre-bind state.
      expect(getById).not.toHaveBeenCalled();
      expect(done).toBe(false);
      expect((await rowFor(sibling))!.seriesName).toBe(before!.seriesName);

      park.gate.resolve();
      await contender;
      getById.mockRestore();
    }

    it('makes Fix Match on a matched sibling wait for the bind, then land over it', async () => {
      const { initiator, sibling } = await twoBookSeries();
      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4250);
      await park.entered;

      await assertContenderWaits(sibling, () => bookService.fixMatch(sibling, {
        asin: 'B0000009', title: 'Replaced Tombs', authors: [{ name: 'Ursula K. Le Guin' }],
        seriesName: 'Fix Match Series', seriesPosition: 42,
      }), park);
      await bind;
      park.restore();

      const row = await rowFor(sibling);
      // Deterministic and un-mixed: Fix Match committed second, so its identity wholly stands.
      expect(row!.seriesName).toBe('Fix Match Series');
      expect(row!.seriesPosition).toBe(42);
      expect(row!.title).toBe('Replaced Tombs');
    });

    it('makes a bind wait for a Fix Match that acquired first, then commit over it', async () => {
      const { initiator, sibling } = await twoBookSeries();
      // Park Fix Match inside its OWN section, holding the sibling's admission lock and nothing
      // else — the mirror of the bind's park point, and the only place the ordering is attributable
      // to admission rather than to the serialized-transaction lane.
      const gate = deferred();
      const entered = deferred();
      vi.mocked(withBookAdmissionLock).mockImplementationOnce((id, fn) =>
        actualLocks.withBookAdmissionLock(id, async () => {
          entered.resolve();
          await gate.promise;
          return fn();
        }));
      // Keeps the sibling inside the bind's targets, so the bind genuinely commits OVER the
      // identity Fix Match landed rather than merely observing it out of the pool.
      const fixMatch = bookService.fixMatch(sibling, {
        asin: 'B0000010', title: 'The Tombs of Atuan', authors: [{ name: 'Ursula K. Le Guin' }],
        seriesName: 'Earthsea', seriesPosition: 42,
      });
      await entered.promise;

      let bindDone = false;
      const bind = cardService().bindHardcoverSeries(initiator, 4250).then((r) => { bindDone = true; return r; });
      await settle();
      expect(bindDone).toBe(false);
      expect((await rowFor(sibling))!.seriesName).toBe('Earthsea');

      gate.resolve();
      await fixMatch;
      const bound = await bind;

      expect([...bound!.syncedIds].sort((a, b) => a - b)).toEqual([initiator, sibling]);
      const row = await rowFor(sibling);
      // Wholly the bind's series identity, not a mix of 42 and 'Earthsea Quartet'.
      expect(row!.seriesName).toBe('Earthsea Quartet');
      expect(row!.seriesPosition).toBe(2);
      // Fix Match's own scalars survive: the bind writes series identity, nothing else.
      expect(row!.asin).toBe('B0000010');
    });

    it('makes a user-asserted update on a matched sibling wait for the bind', async () => {
      const { initiator, sibling } = await twoBookSeries();
      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4250);
      await park.entered;

      await assertContenderWaits(sibling, () => withBookAdmissionLock(sibling, () =>
        bookService.update(sibling, { seriesPosition: 77 }, { userAsserted: true })), park);
      await bind;
      park.restore();

      const row = await rowFor(sibling);
      expect(row!.seriesName).toBe('Earthsea Quartet');
      expect(row!.seriesPosition).toBe(77);
    });

    it('makes a refresh scan on a matched sibling wait for the bind', async () => {
      const { initiator, sibling } = await twoBookSeries();
      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4250);
      await park.entered;

      const contender = refreshScanBook(sibling, bookService, settings(), logger);
      await settle();
      expect(vi.mocked(scanAudioDirectory)).not.toHaveBeenCalled();

      park.gate.resolve();
      await contender;
      await bind;
      park.restore();

      expect(vi.mocked(scanAudioDirectory)).toHaveBeenCalledTimes(1);
      expect((await rowFor(sibling))!.seriesName).toBe('Earthsea Quartet');
    });

    it('makes the enrichment writeback on a matched sibling wait for the bind', async () => {
      const { initiator, sibling } = await twoBookSeries();
      await db.update(books).set({ asin: 'B0000001', enrichmentStatus: 'pending', publisher: null })
        .where(eq(books.id, sibling));
      // Only the sibling is a sweep candidate, so the writeback contends on exactly the book in the batch.
      await db.update(books).set({ enrichmentStatus: 'enriched' }).where(eq(books.id, initiator));
      const metadata = inject<MetadataService>({
        resolveBook: vi.fn().mockResolvedValue({ asin: 'B0000001', publisher: 'Provider Publisher' }),
      });

      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4250);
      await park.entered;

      const sweep = runEnrichment(db, metadata, bookService, logger);
      await settle();
      expect((await rowFor(sibling))!.publisher).toBeNull();

      park.gate.resolve();
      await sweep;
      await bind;
      park.restore();

      const row = await rowFor(sibling);
      expect(row!.publisher).toBe('Provider Publisher');
      expect(row!.seriesName).toBe('Earthsea Quartet');
    });

    it('makes a deletion on a matched sibling wait, and leaves no dangling member row', async () => {
      const { initiator, sibling } = await twoBookSeries();
      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4250);
      await park.entered;

      await assertContenderWaits(sibling, () => deletionService.deleteBook(sibling, { deleteFiles: false }), park);
      const bound = await bind;
      park.restore();

      expect(bound!.syncedIds).toContain(sibling);
      expect(await rowFor(sibling)).toBeUndefined();
      const rows = await db.select().from(seriesMembers);
      // ON DELETE SET NULL: the member row survives with a null link rather than dangling.
      expect(rows.some((r) => r.bookId === sibling)).toBe(false);
      expect(rows.some((r) => r.hardcoverBookId === 5002 && r.bookId === null)).toBe(true);
    });

    it('lets two binds with overlapping match sets both complete, with one winner per shared book', async () => {
      const shared = await seedBook({ title: 'The Farthest Shore', seriesName: 'Shared', seriesPosition: 3 });
      const onlyA = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Shared', seriesPosition: 1 });
      const onlyB = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Shared', seriesPosition: 2 });

      let call = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        const payload = (call++ % 2 === 0)
          ? seriesPayload(9101, 'Alpha Series', 'Ursula K. Le Guin', [
            [3, 6001, 'The Farthest Shore'], [1, 6002, 'A Wizard of Earthsea'],
          ])
          : seriesPayload(9102, 'Beta Series', 'Ursula K. Le Guin', [
            [3, 6003, 'The Farthest Shore'], [2, 6004, 'The Tombs of Atuan'],
          ]);
        return Promise.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }) as typeof globalThis.fetch;

      const [first, second] = await Promise.all([
        cardService().bindHardcoverSeries(onlyA, 9101),
        cardService().bindHardcoverSeries(onlyB, 9102),
      ]);

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      const sharedRow = await rowFor(shared);
      expect(['Alpha Series', 'Beta Series']).toContain(sharedRow!.seriesName);
      // Never a mix: the position must belong to the same bind as the name.
      expect(sharedRow!.seriesPosition).toBe(3);
      expect((await rowFor(onlyA))!.seriesName).toBe('Alpha Series');
      expect((await rowFor(onlyB))!.seriesName).toBe('Beta Series');
    });
  });

  // ── AC3 / AC3a: one authoritative snapshot ───────────────────────────────────────────────────

  describe('snapshot authority, validation and re-acquisition (AC3, AC3a)', () => {
    it('issues zero pool reads inside the bind transaction: every pool read is client-scoped', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Old Name', seriesPosition: 1 });
      await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Earthsea Quartet', seriesPosition: 2 });
      mockHardcover(seriesPayload(4260, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
      ]));

      const spy = spyStatements(db);
      await cardService().bindHardcoverSeries(initiator, 4260);
      spy.restore();

      const pool = poolStatements(spy.executed);
      expect(pool.filter((s) => s.scope !== 'client')).toEqual([]);
      // Enumeration, S, and the post-commit render — and exactly one transaction, the bind's own.
      expect(pool).toHaveLength(3);
      expect(spy.transactions).toHaveLength(1);
    });

    it('does not write a book that acquired the target name after the snapshot was taken', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const latecomer = await seedBook({ title: 'Tehanu', seriesName: 'Unrelated', seriesPosition: 9 });
      mockHardcover(seriesPayload(4261, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [4, 5004, 'Tehanu'],
      ]));

      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4261);
      await park.entered;

      // A real Fix Match on an UNHELD book, committed entirely inside the gap.
      await bookService.fixMatch(latecomer, {
        asin: 'B000000Z', title: 'Tehanu', authors: [{ name: 'Ursula K. Le Guin' }],
        seriesName: 'Earthsea Quartet', seriesPosition: 9,
      });
      const afterFixMatch = await rowFor(latecomer);

      park.gate.resolve();
      const bound = await bind;
      park.restore();

      expect(bound!.syncedIds).not.toContain(latecomer);
      expect(await rowFor(latecomer)).toEqual(afterFixMatch);
    });

    it('re-acquires exactly once when a newcomer appears between the enumeration and the snapshot', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      mockHardcover(seriesPayload(4262, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [4, 5004, 'Tehanu'],
      ]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4262);
      await park.entered;

      const newcomer = await seedBook({ title: 'Tehanu', seriesName: 'Earthsea Quartet', seriesPosition: null });
      park.gate.resolve();
      const bound = await bind;

      expect(vi.mocked(withBookAdmissionLocks)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(withBookAdmissionLocks).mock.calls[1]![0]).toContain(newcomer);
      expect(bound!.syncedIds).toContain(newcomer);
      expect((await rowFor(newcomer))!.seriesPosition).toBe(4);
    });

    it('acquires exactly once when nothing changes under the enumeration', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      mockHardcover(seriesPayload(4263, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      const before = vi.mocked(withBookAdmissionLocks).mock.calls.length;
      await cardService().bindHardcoverSeries(initiator, 4263);

      // The delta, not a suite-wide total: the lock registry and DB are shared across cases.
      expect(vi.mocked(withBookAdmissionLocks).mock.calls.length - before).toBe(1);
    });

    it('AC10 arm A — a late book pairing with a Hardcover member renders in-library but gets no write and no link', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const latecomer = await seedBook({ title: 'Tehanu', seriesName: 'Unrelated', seriesPosition: 9 });
      mockHardcover(seriesPayload(4264, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [4, 5004, 'Tehanu'],
      ]));

      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4264);
      await park.entered;
      await db.update(books).set({ seriesName: 'Earthsea Quartet' }).where(eq(books.id, latecomer));
      const before = await rowFor(latecomer);

      const spy = spyStatements(db);
      park.gate.resolve();
      const bound = await bind;
      spy.restore();
      park.restore();

      expect(await rowFor(latecomer)).toEqual(before);
      const member = bound!.card.members.find((m) => m.title === 'Tehanu')!;
      expect(member.inLibrary).toBe(true);
      expect(member.libraryBookId).toBe(latecomer);
      // persistMembers sourced the link from S, and the latecomer was not in S.
      const rows = await db.select().from(seriesMembers);
      expect(rows.some((r) => r.bookId === latecomer)).toBe(false);
      expect(rows.find((r) => r.hardcoverBookId === 5004)!.bookId).toBeNull();
      // The initiator is the only other owned book and it IS claimed, so nothing is unclaimed and
      // reconcileUnclaimedMembers opens no transaction of its own.
      expect(spy.transactions).toHaveLength(1);
    });

    it('AC10 arm B — a late book pairing with no Hardcover member renders library-only and is seeded locally', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const latecomer = await seedBook({ title: 'An Entirely Unrelated Work', seriesName: 'Unrelated', seriesPosition: 9 });
      mockHardcover(seriesPayload(4265, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      const park = parkBeforeBindTransaction();
      const bind = cardService().bindHardcoverSeries(initiator, 4265);
      await park.entered;
      await db.update(books).set({ seriesName: 'Earthsea Quartet' }).where(eq(books.id, latecomer));
      const before = await rowFor(latecomer);

      park.gate.resolve();
      const bound = await bind;
      park.restore();

      expect(await rowFor(latecomer)).toEqual(before);
      const member = bound!.card.members.find((m) => m.title === 'An Entirely Unrelated Work')!;
      expect(member).toMatchObject({ inLibrary: true, hardcoverBookId: null, libraryBookId: latecomer });
      const local = (await db.select().from(seriesMembers)).filter((r) => r.source === 'local');
      expect(local.map((r) => r.bookId)).toEqual([latecomer]);
    });

    it('treats a narrowing prior-name change as no error: one acquisition, and the extra locks release', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Old Name', seriesPosition: 1 });
      const oldNameSibling = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Old Name', seriesPosition: 2 });
      mockHardcover(seriesPayload(4266, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
      ]));

      const park = parkBeforeAcquisition();
      const before = vi.mocked(withBookAdmissionLocks).mock.calls.length;
      const bind = cardService().bindHardcoverSeries(initiator, 4266);
      await park.entered;

      await db.update(books).set({ seriesName: 'Narrow Name' }).where(eq(books.id, initiator));
      const siblingBefore = await rowFor(oldNameSibling);
      park.gate.resolve();
      const bound = await bind;

      expect(vi.mocked(withBookAdmissionLocks).mock.calls.length - before).toBe(1);
      // held ⊋ ids(S) is safe, not an error arm.
      expect(vi.mocked(withBookAdmissionLocks).mock.calls[before]![0]).toContain(oldNameSibling);
      expect(bound!.syncedIds).toEqual([initiator]);
      expect(await rowFor(oldNameSibling)).toEqual(siblingBefore);
      await settle();
      expect([initiator, oldNameSibling].map((id) => hasPendingBookAdmission(id))).toEqual([false, false]);
    });

    it('throws SeriesBindChurnError after the bounded re-acquisitions, writing nothing and opening no transaction', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      mockHardcover(seriesPayload(4267, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      const acquired: number[] = [];
      // A fresh matching book lands before EVERY acquisition, so S outgrows the held set each time.
      vi.mocked(withBookAdmissionLocks).mockImplementation(async (ids, fn) => {
        acquired.push(...ids);
        await seedBook({ title: `Churn ${acquired.length}`, seriesName: 'Earthsea Quartet', seriesPosition: null });
        return actualLocks.withBookAdmissionLocks(ids, fn);
      });

      const before = await db.select().from(books);
      const spy = spyStatements(db);
      const error = await cardService().bindHardcoverSeries(initiator, 4267).catch((e: unknown) => e);
      spy.restore();

      expect(error).toBeInstanceOf(SeriesBindChurnError);
      expect(vi.mocked(withBookAdmissionLocks)).toHaveBeenCalledTimes(MAX_BIND_SET_REACQUIRES + 1);
      expect(spy.transactions).toHaveLength(0);
      // Every pre-existing row is byte-unchanged; only the churn fixture's own inserts are new.
      for (const row of before) expect(await rowFor(row.id)).toEqual(row);
      await settle();
      expect([...new Set(acquired)].map((id) => hasPendingBookAdmission(id))).not.toContain(true);
    });

    it('drops a book that left the pool before the snapshot rather than writing it', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const departing = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Earthsea Quartet', seriesPosition: 2 });
      mockHardcover(seriesPayload(4268, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
      ]));

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4268);
      await park.entered;

      await db.update(books).set({ seriesName: 'Somewhere Else' }).where(eq(books.id, departing));
      const before = await rowFor(departing);
      park.gate.resolve();
      const bound = await bind;

      expect(bound!.syncedIds).toEqual([initiator]);
      expect(await rowFor(departing)).toEqual(before);
      expect((await db.select().from(seriesMembers)).some((r) => r.bookId === departing)).toBe(false);
    });

    it('leaves persistMembers loading on the transaction handle for the unlocked refresh paths', async () => {
      const anchor = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      mockHardcover(seriesPayload(4269, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      const spy = spyStatements(db);
      await cardService().getSeriesForBook(anchor);
      await cardService().refreshSeriesForBook(anchor);
      spy.restore();

      // The exact inverse of the bind case: these paths hold no locks, so their pool read stays
      // inside their own transaction. `lockedPool` must not become mandatory.
      expect(poolStatements(spy.executed).filter((s) => s.scope.startsWith('tx')).length).toBeGreaterThanOrEqual(1);
      expect(vi.mocked(withBookAdmissionLocks)).not.toHaveBeenCalled();
    });
  });

  // ── AC5 / AC6: no I/O inside the lock; release before post-commit work ───────────────────────

  describe('the held span (AC5, AC6)', () => {
    it('completes the Hardcover fetch before the first acquisition and issues none inside it', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const fetchMock = mockHardcover(seriesPayload(4270, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      const order: string[] = [];
      fetchMock.mockImplementation(() => {
        order.push('fetch');
        return Promise.resolve(new Response(JSON.stringify(
          seriesPayload(4270, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]),
        ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      });

      const park = parkBeforeAcquisition();
      const bind = cardService().bindHardcoverSeries(initiator, 4270);
      await park.entered;
      order.push('acquire');
      const fetchesBeforeLock = fetchMock.mock.calls.length;

      park.gate.resolve();
      await bind;

      expect(order).toEqual(['fetch', 'acquire']);
      // Frozen across the whole held span: nothing outbound happens under the locks.
      expect(fetchMock.mock.calls.length).toBe(fetchesBeforeLock);
    });

    it('releases every lock before the card render that follows the commit', async () => {
      const initiator = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      const sibling = await seedBook({ title: 'The Tombs of Atuan', seriesName: 'Earthsea Quartet', seriesPosition: 2 });
      mockHardcover(seriesPayload(4271, 'Earthsea Quartet', 'Ursula K. Le Guin', [
        [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
      ]));

      const bound = await cardService().bindHardcoverSeries(initiator, 4271);

      expect([...bound!.syncedIds].sort((a, b) => a - b)).toEqual([initiator, sibling]);
      // A retag reached with the bind still holding would hang forever, not fail: the lock is not
      // re-entrant. Proving release is therefore the only safe assertion available post-hoc.
      for (const id of bound!.syncedIds) expect(hasPendingBookAdmission(id)).toBe(false);
      // …and the same ids can be acquired again immediately, as the post-bind refresh does.
      await Promise.all(bound!.syncedIds.map((id) => withBookAdmissionLock(id, async () => id)));
    });
  });

  // ── AC9 / AC11: the unchanged surface ────────────────────────────────────────────────────────

  describe('the unchanged surface (AC9, AC11)', () => {
    it.each([
      ['no such book', async () => ({ svc: cardService(), id: 987_654 })],
      ['no API key', async () => ({ svc: keylessCardService(), id: await seedBook({ title: 'Anchor', seriesName: 'Earthsea' }) })],
    ])('takes zero admission locks on the %s null arm', async (_label, build) => {
      mockHardcover(seriesPayload(4280, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'Anchor']]));
      const { svc, id } = await build();

      expect(await svc.bindHardcoverSeries(id, 4280)).toBeNull();
      expect(vi.mocked(withBookAdmissionLocks)).not.toHaveBeenCalled();
      expect(vi.mocked(withBookAdmissionLock)).not.toHaveBeenCalled();
    });

    it('takes zero admission locks when Hardcover cannot resolve the series', async () => {
      const id = await seedBook({ title: 'Anchor', seriesName: 'Earthsea' });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"data":{"series":[]}}', {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })) as typeof globalThis.fetch;

      expect(await cardService().bindHardcoverSeries(id, 4281)).toBeNull();
      expect(vi.mocked(withBookAdmissionLocks)).not.toHaveBeenCalled();
    });

    it('takes zero admission locks when the resolved name is whitespace-only', async () => {
      const id = await seedBook({ title: 'Anchor', seriesName: 'Earthsea' });
      mockHardcover(seriesPayload(4282, '   ', 'Ursula K. Le Guin', [[1, 5001, 'Anchor']]));

      expect(await cardService().bindHardcoverSeries(id, 4282)).toBeNull();
      expect(vi.mocked(withBookAdmissionLocks)).not.toHaveBeenCalled();
    });

    it('takes zero admission locks on the read, refresh and scheduled-refresh paths', async () => {
      const anchor = await seedBook({ title: 'A Wizard of Earthsea', seriesName: 'Earthsea Quartet', seriesPosition: 1 });
      await seedBook({ title: 'Unclaimed Sibling', seriesName: 'Earthsea Quartet', seriesPosition: 7 });
      mockHardcover(seriesPayload(4283, 'Earthsea Quartet', 'Ursula K. Le Guin', [[1, 5001, 'A Wizard of Earthsea']]));

      // getSeriesForBook leaves an unclaimed owned book, so reconcileUnclaimedMembers runs too.
      expect(await cardService().getSeriesForBook(anchor)).not.toBeNull();
      expect(await cardService().refreshSeriesForBook(anchor)).not.toBeNull();
      await db.update(seriesMembers).set({ updatedAt: new Date() });
      expect(await cardService().runScheduledRefresh()).toEqual({ refreshed: 0, skipped: 0 });

      expect(vi.mocked(withBookAdmissionLocks)).not.toHaveBeenCalled();
      expect(vi.mocked(withBookAdmissionLock)).not.toHaveBeenCalled();
    });

    it('is the only books writer in the service, and both write sites sit inside the acquired span', async () => {
      const source = await import('node:fs/promises').then((fs) =>
        fs.readFile(new URL('./series-card.service.ts', import.meta.url), 'utf8'));

      const sites = source.match(/\.update\(books\)/g) ?? [];
      expect(sites).toHaveLength(2);
      // Both sites live in commitBind, which withValidatedBindSet only reaches under the locks.
      const commitBind = source.slice(source.indexOf('private async commitBind'), source.indexOf('async bindHardcoverSeries'));
      expect(commitBind.match(/\.update\(books\)/g) ?? []).toHaveLength(2);
    });
  });
});
