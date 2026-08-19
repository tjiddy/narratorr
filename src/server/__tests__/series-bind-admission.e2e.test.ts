import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createE2EApp, type E2EApp } from './e2e-helpers.js';
import { authors, bookAuthors, books } from '@db/schema.js';
import { generatePublicId } from '../utils/public-id.js';

/**
 * Wrapping rather than replacing keeps the real registry in play. `withBookAdmissionLocks` calls the
 * module-local single-lock function, so the `withBookAdmissionLock` spy counts ONLY the post-bind
 * acquisitions — which is precisely what the AC6 matrix measures.
 */
vi.mock('../utils/book-admission-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/book-admission-lock.js')>();
  return {
    ...actual,
    withBookAdmissionLock: vi.fn(actual.withBookAdmissionLock),
    withBookAdmissionLocks: vi.fn(actual.withBookAdmissionLocks),
  };
});

import { hasPendingBookAdmission, withBookAdmissionLock, withBookAdmissionLocks } from '../services/book-admission.js';

const actualLocks = await vi.importActual<typeof import('../utils/book-admission-lock.js')>('../utils/book-admission-lock.js');
const ORIGINAL_FETCH = globalThis.fetch;

function seriesPayload(id: number, name: string, members: readonly [number | null, number, string][]): unknown {
  return {
    data: {
      series: [{
        id, name, slug: `series-${id}`, author: { name: 'Ursula K. Le Guin' },
        book_series: members.map(([position, bookId, title]) => ({
          position,
          book: { id: bookId, slug: `book-${bookId}`, title, image: null, users_count: 100 },
        })),
      }],
    },
  };
}

describe('POST /api/books/:id/series/bind — admission protocol at the route (#2447)', () => {
  let e2e: E2EApp;
  let libraryRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(withBookAdmissionLock).mockImplementation(actualLocks.withBookAdmissionLock);
    vi.mocked(withBookAdmissionLocks).mockImplementation(actualLocks.withBookAdmissionLocks);
    e2e = await createE2EApp();
    libraryRoot = join(e2e.dir, 'library');
    await mkdir(libraryRoot, { recursive: true });
    await e2e.services.settings.update({ metadata: { hardcoverApiKey: 'TEST_KEY' } });
  });

  afterEach(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    await e2e.cleanup();
  });

  /** `folder` null means never imported (no `books.path`); a `.m4b` folder name is a pointer import. */
  async function seedBook(title: string, seriesName: string, position: number | null, folder: string | null): Promise<number> {
    const values: Record<string, unknown> = {
      publicId: generatePublicId('bk'), title, seriesName, seriesPosition: position,
    };
    if (folder) {
      const path = join(libraryRoot, folder);
      if (folder.toLowerCase().endsWith('.m4b')) {
        await writeFile(path, 'audio');
      } else {
        await mkdir(path, { recursive: true });
        await writeFile(join(path, 'part1.m4b'), 'audio');
      }
      values.path = path;
      values.status = 'imported';
    }
    const [book] = await e2e.db.insert(books).values(values as never).returning();
    const slug = 'ursula-k-le-guin';
    const existing = await e2e.db.select().from(authors).where(eq(authors.slug, slug)).limit(1);
    const authorId = existing[0]?.id
      ?? (await e2e.db.insert(authors).values({ publicId: generatePublicId('au'), name: 'Ursula K. Le Guin', slug }).returning())[0]!.id;
    await e2e.db.insert(bookAuthors).values({ bookId: book!.id, authorId, position: 0 });
    return book!.id;
  }

  function mockHardcover(payload: unknown): void {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )) as typeof globalThis.fetch;
  }

  const bind = (id: number, hardcoverSeriesId: number) =>
    e2e.app.inject({ method: 'POST', url: `/api/books/${id}/series/bind`, payload: { hardcoverSeriesId } });

  const acquisitionsFor = (id: number) =>
    vi.mocked(withBookAdmissionLock).mock.calls.filter(([bookId]) => bookId === id).length;

  it('has released every synced book before the post-bind refresh acquires it', async () => {
    const initiator = await seedBook('A Wizard of Earthsea', 'Earthsea Quartet', 1, 'wizard');
    const sibling = await seedBook('The Tombs of Atuan', 'Earthsea Quartet', 2, 'tombs');
    await e2e.services.settings.update({ tagging: { enabled: true, writeOpf: true } });
    mockHardcover(seriesPayload(4301, 'Earthsea Quartet', [
      [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
    ]));

    // Positive control: prove `hasPendingBookAdmission` actually reports the held state, so the
    // "released" assertion below is not vacuously true of an observable that never says otherwise.
    let heldInsideSection: boolean | null = null;
    vi.mocked(withBookAdmissionLocks).mockImplementationOnce((ids, fn) =>
      actualLocks.withBookAdmissionLocks(ids, async () => {
        heldInsideSection = [initiator, sibling].every((id) => hasPendingBookAdmission(id));
        return fn();
      }));

    const observed: { id: number; heldByBind: boolean }[] = [];
    const retag = vi.spyOn(e2e.services.tagging, 'retagBook').mockImplementation(async (bookId: number) => {
      // The admission lock is not re-entrant, so a retag reached inside the bind's held span would
      // hang forever rather than fail — observing release from here is the only safe proof.
      observed.push({ id: bookId, heldByBind: [initiator, sibling].some((id) => hasPendingBookAdmission(id)) });
      return { tagged: 0, skipped: 0, failed: 0, refreshItem: null } as never;
    });

    expect((await bind(initiator, 4301)).statusCode).toBe(200);

    expect(heldInsideSection).toBe(true);
    expect(observed.map((o) => o.id)).toEqual([initiator, sibling]);
    expect(observed.some((o) => o.heldByBind)).toBe(false);
    // Ordering, not merely absence: the bind's own acquisition settled before the first post-bind one.
    expect(vi.mocked(withBookAdmissionLocks)).toHaveBeenCalledTimes(1);
    expect(retag).toHaveBeenCalledTimes(2);
  });

  describe('the post-bind acquisition matrix is unchanged (AC6)', () => {
    async function bindOneImported(tagging: { enabled: boolean; writeOpf: boolean }, folder: string | null): Promise<number> {
      const initiator = await seedBook('A Wizard of Earthsea', 'Earthsea Quartet', 1, folder);
      await e2e.services.settings.update({ tagging });
      mockHardcover(seriesPayload(4310, 'Earthsea Quartet', [[1, 5001, 'A Wizard of Earthsea']]));
      // The real retag would shell out to mutagen; the acquisition it takes first is the observable.
      vi.spyOn(e2e.services.tagging, 'retagBook').mockImplementation((bookId: number) =>
        withBookAdmissionLock(bookId, async () => ({ tagged: 0, skipped: 0, failed: 0, refreshItem: null }) as never));

      expect((await bind(initiator, 4310)).statusCode).toBe(200);
      return initiator;
    }

    it.each([
      ['both gates on, eligible folder', { enabled: true, writeOpf: true }, 'wizard', 2],
      ['retag only', { enabled: true, writeOpf: false }, 'wizard', 1],
      ['OPF only', { enabled: false, writeOpf: true }, 'wizard', 1],
      ['both gates off', { enabled: false, writeOpf: false }, 'wizard', 0],
      ['never imported (null path)', { enabled: true, writeOpf: true }, null, 0],
      ['pointer import, both gates on', { enabled: true, writeOpf: true }, 'wizard.m4b', 1],
    ])('%s → %i acquisitions', async (_label, tagging, folder, expected) => {
      const initiator = await bindOneImported(tagging, folder);
      expect(acquisitionsFor(initiator)).toBe(expected);
    });

    it('acquires nothing for a synced book whose row has vanished', async () => {
      const initiator = await seedBook('A Wizard of Earthsea', 'Earthsea Quartet', 1, 'wizard');
      const sibling = await seedBook('The Tombs of Atuan', 'Earthsea Quartet', 2, 'tombs');
      await e2e.services.settings.update({ tagging: { enabled: true, writeOpf: true } });
      mockHardcover(seriesPayload(4311, 'Earthsea Quartet', [
        [1, 5001, 'A Wizard of Earthsea'], [2, 5002, 'The Tombs of Atuan'],
      ]));
      vi.spyOn(e2e.services.tagging, 'retagBook').mockImplementation((bookId: number) =>
        withBookAdmissionLock(bookId, async () => ({ tagged: 0, skipped: 0, failed: 0, refreshItem: null }) as never));

      const realGetById = e2e.services.book.getById.bind(e2e.services.book);
      vi.spyOn(e2e.services.book, 'getById').mockImplementation(async (id: number) =>
        (id === sibling ? null : realGetById(id)));

      expect((await bind(initiator, 4311)).statusCode).toBe(200);

      expect(acquisitionsFor(sibling)).toBe(0);
      expect(acquisitionsFor(initiator)).toBe(2);
    });
  });
});
