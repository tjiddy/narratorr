import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import type * as NetworkServiceModule from '@core/utils/network-service.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { generatePublicId } from '../utils/public-id.js';
import type { SettingsService } from '../services/settings.service.js';

// Only HTTP is stubbed: the cover write, its DB localization and the rename all run for real.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@core/utils/network-service.js', async (importActual) => {
  const actual = await importActual<typeof NetworkServiceModule>();
  return {
    ...actual,
    fetchWithSsrfRedirect: fetchMock,
    createSsrfSafeDispatcher: (() => ({ close: vi.fn().mockResolvedValue(undefined) })) as unknown as typeof actual.createSsrfSafeDispatcher,
  };
});

import { runCoverBackfill } from './cover-backfill.js';
import { BookService } from '../services/book.service.js';
import { RenameService } from '../services/rename.service.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const norm = (value: string | null) => value?.split('\\').join('/') ?? null;
const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

/**
 * #2369 AC12 / F14. The backfill re-reads each book's row inside its section because the batch
 * query is a pre-lock snapshot — but revalidation alone only proves the read is fresh. What closes
 * the window AC12 exists for is the acquisition AROUND it: with the row checked and the download in
 * flight, a rename must not be able to move the folder out from under the cover write.
 *
 * The download is parked at its HTTP fetch, which is after the revalidating read and before the
 * first byte reaches disk — exactly the interval a revalidation-only implementation leaves open.
 */
describe('cover backfill excludes renames from read to cover write (#2369 F14)', () => {
  let dir: string;
  let root: string;
  let db: Db;
  let log: ReturnType<typeof createMockLogger>;
  let bookService: BookService;
  let renameService: RenameService;

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockResolvedValue({ path: root, folderFormat: '{author}/{title}', fileFormat: '' }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), 'cover-backfill-admission-'));
    root = join(dir, 'library');
    await mkdir(root, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    log = createMockLogger();
    const logger = inject<FastifyBaseLogger>(log);
    bookService = new BookService(db, logger);
    renameService = new RenameService(db, bookService, settings(), logger);
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  const seedBook = async (title: string, folder: string): Promise<number> => {
    const path = join(root, folder);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, `${title}.m4b`), title);
    const [row] = await db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'), title, path, status: 'imported',
        coverUrl: 'https://cdn.example.com/cover.jpg',
      })
      .returning();
    return row!.id;
  };

  const rowOf = async (id: number) => {
    const [row] = await db.select({ path: books.path, coverUrl: books.coverUrl }).from(books).where(eq(books.id, id));
    return row!;
  };

  /** Park the fetch so the backfill sits inside its section, past the row re-read. */
  const gateFetch = () => {
    const gate = deferred();
    const entered = deferred();
    fetchMock.mockImplementationOnce(async () => {
      entered.resolve();
      await gate.promise;
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    });
    return { gate, entered };
  };

  it('holds a rename off from the revalidating read until the cover has landed', async () => {
    const bookId = await seedBook('Wanderer', join('Wrong', 'Old'));
    const oldPath = join(root, 'Wrong', 'Old');
    const target = join(root, 'Unknown Author', 'Wanderer');

    const { gate, entered } = gateFetch();
    const backfill = runCoverBackfill(db, inject<FastifyBaseLogger>(log));
    await entered.promise;

    const renameRun = renameService.renameBook(bookId);
    await settle();

    // The rename is queued on the book's section: nothing has moved and the row still names the
    // folder the download revalidated against.
    expect(norm((await rowOf(bookId)).path)).toBe(norm(oldPath));
    expect(await exists(oldPath)).toBe(true);
    expect(await exists(target)).toBe(false);

    gate.resolve();
    await backfill;
    const result = await renameRun;

    // The cover was written before the folder moved, so it travelled with it.
    expect(norm(result.newPath)).toBe(norm(target));
    expect(await exists(join(target, 'cover.jpg'))).toBe(true);
    expect(await exists(oldPath)).toBe(false);
    expect(await readdir(join(root, 'Wrong')).catch(() => [])).toEqual([]);

    const row = await rowOf(bookId);
    expect(norm(row.path)).toBe(norm(target));
    // Localization committed too: the row points at the local cover, not the remote URL.
    expect(row.coverUrl).toBe(`/api/books/${bookId}/cover`);
  });
});
