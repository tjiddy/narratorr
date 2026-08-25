import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { eq } from 'drizzle-orm';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books, bookEvents, downloads } from '@db/schema.js';
import type { FastifyBaseLogger } from 'fastify';
import { DownloadOrchestrator } from './download-orchestrator.js';
import type { DownloadService } from './download.service.js';
import { BOOK_NOT_FOUND_MESSAGE } from './download-errors.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { LEAKY_DOWNLOAD_URL } from '../__tests__/drizzle-error.fixture.js';

/**
 * T26 (#2604). Against a real migrated database — libSQL enables `PRAGMA foreign_keys` itself, so
 * the FK that produced the incident is genuinely enforced here. The point is that the refusal now
 * fires above the insert, making that FK unreachable through the grab paths rather than merely
 * better-rendered.
 */
describe('a grab at a deleted book id, against a migrated DB', () => {
  let dir: string;
  let db: Db;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'grab-book-missing-'));
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
  });

  afterEach(() => {
    // Windows keeps the file locked until the client closes (#2599).
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  /** Flatten the chain: the constraint text lives on `.cause`, never on a DrizzleQueryError's message. */
  const flatten = (caught: unknown): string => {
    const parts: string[] = [];
    let current: unknown = caught;
    while (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    }
    return parts.join(' | ');
  };

  const seedThenDeleteBook = async (): Promise<number> => {
    const [row] = await db
      .insert(books)
      .values({ publicId: generatePublicId('bk'), title: 'Doomed Book', status: 'wanted' })
      .returning({ id: books.id });
    const bookId = row!.id;
    await db.delete(books).where(eq(books.id, bookId));
    return bookId;
  };

  it('refuses the grab and writes no downloads or book_events row', async () => {
    const bookId = await seedThenDeleteBook();
    const downloadService = inject<DownloadService>({ grab: vi.fn() });
    const log = inject<FastifyBaseLogger>(createMockLogger());
    const orchestrator = new DownloadOrchestrator(downloadService, db, log);

    await expect(
      orchestrator.grab({ downloadUrl: LEAKY_DOWNLOAD_URL, title: 'Doomed Book', bookId }),
    ).rejects.toMatchObject({ code: 'BOOK_NOT_FOUND', message: BOOK_NOT_FOUND_MESSAGE });

    expect(downloadService.grab).not.toHaveBeenCalled();
    expect(await db.select().from(downloads)).toHaveLength(0);
    expect(await db.select().from(bookEvents)).toHaveLength(0);
  });

  it('the FK it now avoids is real — a direct insert at the dead id still fails', async () => {
    const bookId = await seedThenDeleteBook();

    const caught = await db
      .insert(downloads)
      .values({
        publicId: generatePublicId('dl'),
        bookId,
        title: 'Doomed Book',
        downloadUrl: LEAKY_DOWNLOAD_URL,
        protocol: 'torrent',
      })
      .then(() => null, (error: unknown) => error);

    expect(caught).not.toBeNull();
    expect(flatten(caught)).toContain('FOREIGN KEY constraint failed');
  });
});
