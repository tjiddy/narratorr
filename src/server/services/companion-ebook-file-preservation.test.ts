import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../../db/index.js';
import { createMockDb, createMockLogger, inject, mockDbChain, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { BookService, type BookWithAuthor } from './book.service.js';
import { BookRejectionService } from './book-rejection.service.js';
import { RenameService } from './rename.service.js';
import type { BlacklistService } from './blacklist.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { RetrySearchDeps } from './retry-search.js';
import { cleanupOldBookPath } from '../utils/import-steps.js';
import { planFileRenames } from '../utils/paths.js';

vi.mock('./rejection-helpers.js', () => ({
  blacklistAndRetrySearch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../utils/cover-cache.js', () => ({
  preserveBookCover: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../config.js', () => ({
  config: { configPath: '/test-config' },
}));

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/**
 * #1960 AC32/AC33 — REGRESSION PINS ONLY, no new behaviour.
 *
 * Every path below already preserves foreign files through the shared classifier in
 * `delete-managed-files.ts` (#1589/#1598), and `planFileRenames` has always been audio-only.
 * What #1960 adds is the companion-ebook *contract*: an owner-placed `.epub` sitting beside the
 * audiobook is the whole feature's substrate, so each cleanup family gets an explicit
 * `.epub`-named pin. A future change that widens the managed-file classifier fails HERE with an
 * unambiguous cause, instead of silently deleting the file the feature is about.
 */
describe('companion .epub survives every file-cleanup path (#1960 AC32/AC33)', () => {
  let root: string;
  let bookDir: string;
  let log: FastifyBaseLogger;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = mkdtempSync(join(tmpdir(), 'narratorr-1960-preserve-'));
    bookDir = join(root, 'Author', 'A Book');
    await mkdir(bookDir, { recursive: true });
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedBookFolder(dir = bookDir) {
    await writeFile(join(dir, 'chapter1.mp3'), 'audio');
    await writeFile(join(dir, 'cover.jpg'), 'cover');
    await writeFile(join(dir, 'companion.epub'), 'EPUB BYTES');
  }

  it('book deletion with files: deleteBookFiles removes the audio and the cover sidecar, and keeps the .epub', async () => {
    await seedBookFolder();
    const bookService = new BookService(inject<Db>(createMockDb()), log);

    const result = await bookService.deleteBookFiles(bookDir, root);

    expect(await exists(join(bookDir, 'companion.epub'))).toBe(true);
    expect(await readFile(join(bookDir, 'companion.epub'), 'utf8')).toBe('EPUB BYTES');
    expect(await exists(join(bookDir, 'chapter1.mp3'))).toBe(false);
    expect(result.preservedForeign.map(p => p.split(/[\\/]/).pop())).toContain('companion.epub');
  });

  it('wrong-release cleanup: a real rejectAsWrongRelease run keeps the .epub', async () => {
    await seedBookFolder();
    const bookService = new BookService(inject<Db>(createMockDb()), log);
    const book = {
      ...createMockDbBook({ id: 42, status: 'imported' as const, path: bookDir }),
      lastGrabGuid: 'guid-abc',
      lastGrabInfoHash: 'hash-123',
    };
    vi.spyOn(bookService, 'getById').mockResolvedValue(book as unknown as BookWithAuthor);
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain());
    const service = new BookRejectionService(
      inject<Db>(db),
      log,
      bookService,
      inject<BlacklistService>({ create: vi.fn().mockResolvedValue({}) }),
      inject<SettingsService>({ get: vi.fn().mockResolvedValue({ path: root }) }),
      inject<EventHistoryService>({ create: vi.fn().mockResolvedValue({}) }),
      inject<RetrySearchDeps>({ log }),
    );

    await service.rejectAsWrongRelease(42);

    expect(await exists(join(bookDir, 'companion.epub'))).toBe(true);
    expect(await exists(join(bookDir, 'chapter1.mp3'))).toBe(false);
  });

  it('old-path cleanup after a re-import: cleanupOldBookPath keeps the .epub at the old path', async () => {
    await seedBookFolder();
    const newPath = join(root, 'Author', 'A Book (2026)');
    await mkdir(newPath, { recursive: true });

    await cleanupOldBookPath({ bookPath: bookDir, targetPath: newPath, libraryRoot: root, log });

    expect(await exists(join(bookDir, 'companion.epub'))).toBe(true);
    expect(await exists(join(bookDir, 'chapter1.mp3'))).toBe(false);
    // The folder is retained precisely BECAUSE the foreign file is still in it.
    expect(await exists(bookDir)).toBe(true);
  });

  describe('AC33 — a rename carries the .epub through unchanged', () => {
    function makeRenameService(settings: Record<string, unknown>) {
      const bookService = inject<BookService>({
        getById: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      });
      const service = new RenameService(
        inject<Db>(createMockDb()),
        bookService,
        inject<SettingsService>(createMockSettingsService({ library: settings })),
        log,
      );
      return { service, bookService };
    }

    it('a folder move carries the .epub into the new folder, byte-for-byte', async () => {
      await seedBookFolder();
      const { service, bookService } = makeRenameService({
        path: root, folderFormat: '{author}/{title} ({year})', fileFormat: '',
      });
      (bookService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1, title: 'A Book', path: bookDir, publishedDate: '2026-01-01',
        authors: [{ name: 'Author' }], narrators: [], seriesName: null, seriesPosition: null,
      });

      const result = await service.renameBook(1);

      expect(result.newPath).not.toBe(result.oldPath);
      const moved = join(root, 'Author', 'A Book (2026)');
      expect(await readFile(join(moved, 'companion.epub'), 'utf8')).toBe('EPUB BYTES');
      expect(await exists(join(bookDir, 'companion.epub'))).toBe(false);
    });

    it('an in-place file-template rename leaves the .epub basename untouched', async () => {
      await seedBookFolder();
      const { service, bookService } = makeRenameService({
        path: root, folderFormat: '{author}/{title}', fileFormat: '{author} - {title}',
      });
      (bookService.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1, title: 'A Book', path: bookDir, publishedDate: null,
        authors: [{ name: 'Author' }], narrators: [], seriesName: null, seriesPosition: null,
      });

      await service.renameBook(1);

      const names = (await readdir(bookDir)).sort();
      expect(names).toContain('companion.epub');
      expect(names).toContain('Author - A Book.mp3');
      expect(await readFile(join(bookDir, 'companion.epub'), 'utf8')).toBe('EPUB BYTES');
    });

    it('planFileRenames never includes the .epub in its plan', async () => {
      await seedBookFolder();

      const plan = await planFileRenames(
        bookDir,
        '{author} - {title}',
        { title: 'A Book', seriesName: null, seriesPosition: null, publishedDate: null, narrators: [] },
        'Author',
      );

      expect(plan.map(p => p.from)).toEqual(['chapter1.mp3']);
      expect(plan.flatMap(p => [p.from, p.to]).join('\n')).not.toContain('.epub');
    });
  });
});
