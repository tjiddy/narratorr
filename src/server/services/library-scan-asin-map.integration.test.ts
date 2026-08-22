import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { createMockLogger, createMockSettingsService, inject } from '../__tests__/helpers.js';
import { LibraryScanService } from './library-scan.service.js';
import type { BookService } from './book.service.js';
import type { BookImportService } from './book-import.service.js';
import type { MetadataService } from './metadata.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';

/**
 * #2435 AC12 — the ASIN map must SEE `books.path`.
 *
 * Deliberately DB-backed against real migrated libSQL: the projection is the thing under test, and
 * a suite that hands `scanDirectory` a hand-built row shape passes just as happily against the old
 * query that never selected `path`.
 */
describe('library scan ASIN map carries the file-holding fact (DB-backed, #2435)', () => {
  let dir: string;
  let scanRoot: string;
  let db: Db;
  let service: LibraryScanService;
  const log = createMockLogger();

  function seedFolder(name: string): void {
    const folder = join(scanRoot, 'Author', name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'book.m4b'), Buffer.alloc(2048));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'scan-asin-'));
    scanRoot = join(dir, 'scan');
    mkdirSync(scanRoot, { recursive: true });
    await runMigrations(join(dir, 'narratorr.db'));
    db = createDb(join(dir, 'narratorr.db'));

    service = new LibraryScanService(
      db,
      inject<BookService>({ findDuplicate: vi.fn(), create: vi.fn(), update: vi.fn() }),
      inject<BookImportService>({ enqueue: vi.fn() }),
      inject<MetadataService>({ searchBooks: vi.fn(), getBook: vi.fn(), enrichBook: vi.fn() }),
      inject<SettingsService>(createMockSettingsService({ library: { path: join(dir, 'library') } })),
      inject<FastifyBaseLogger>(log),
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
    );
  });

  afterEach(() => {
    db.$client.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows keeps libSQL handles open */ }
  });

  it('separates a fileless ASIN row from a file-holding one in the same scan', async () => {
    await db.insert(books).values([
      { publicId: 'bk_wanted_00000000000', title: 'Wanted One', asin: 'B0WANTED01', status: 'wanted', path: null },
      { publicId: 'bk_owned_000000000000', title: 'Owned One', asin: 'B0OWNED001', status: 'imported', path: join(dir, 'library', 'Owned One') },
    ]);
    seedFolder('Wanted One [B0WANTED01]');
    seedFolder('Owned One [B0OWNED001]');

    const { discoveries } = await service.scanDirectory(scanRoot);

    const wanted = discoveries.find((d) => d.parsedTitle === 'Wanted One');
    const owned = discoveries.find((d) => d.parsedTitle === 'Owned One');

    // The fileless row survives selection and still names its incumbent.
    expect(wanted?.isDuplicate).toBe(false);
    expect(wanted?.existingBookId).toBeGreaterThan(0);
    // The file-holding row is unchanged: still a decisive-ASIN duplicate.
    expect(owned?.isDuplicate).toBe(true);
    expect(owned?.duplicateReason).toBe('slug');
  });

  // #2091: the same projection must reach the review list, or the section cannot name the incumbent.
  it('carries the file-holding incumbent path onto the slug duplicate, and onto nothing else', async () => {
    const incumbentPath = join(dir, 'library', 'Owned One');
    await db.insert(books).values([
      { publicId: 'bk_wanted_00000000000', title: 'Wanted One', asin: 'B0WANTED01', status: 'wanted', path: null },
      { publicId: 'bk_owned_000000000000', title: 'Owned One', asin: 'B0OWNED001', status: 'imported', path: incumbentPath },
    ]);
    seedFolder('Wanted One [B0WANTED01]');
    seedFolder('Owned One [B0OWNED001]');

    const { discoveries } = await service.scanDirectory(scanRoot);

    const owned = discoveries.find((d) => d.parsedTitle === 'Owned One');
    expect(owned?.existingPath?.split('\\').join('/')).toBe(incumbentPath.split('\\').join('/'));
    // A fileless incumbent has no folder to name, and the row is not a duplicate anyway.
    expect(discoveries.find((d) => d.parsedTitle === 'Wanted One')?.existingPath).toBeUndefined();
  });

  it('leaves a path duplicate without existingPath — the folder IS the incumbent', async () => {
    const ownedFolder = join(scanRoot, 'Author', 'Owned One');
    await db.insert(books).values({
      publicId: 'bk_owned_000000000000', title: 'Owned One', asin: null, status: 'imported', path: ownedFolder,
    });
    seedFolder('Owned One');

    const { discoveries } = await service.scanDirectory(scanRoot);

    const owned = discoveries.find((d) => d.parsedTitle === 'Owned One');
    expect(owned?.duplicateReason).toBe('path');
    expect(owned?.existingPath).toBeUndefined();
  });
});
