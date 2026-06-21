import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockLogger, createMockDb, mockDbChain, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { RenameService } from './rename.service.js';
import { findCommitPendingMarkers } from '../utils/import-staging.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * #1418 — `renameBook` is a mid-uptime writer that must converge a stranded
 * `.import-commit-pending` marker on `oldPath` BEFORE any destructive mutation, so it
 * neither orphans the marker beside the vacated old path (folder move) nor renames files
 * in place while a marker is still armed (file-template rename). These tests use a REAL
 * tmpdir so the marker machinery runs against actual disk state (it short-circuits to
 * "marker present" under mocked fs, #1391).
 */

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

async function listFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
}

describe('RenameService marker convergence (#1418, real tmpdir)', () => {
  let libraryRoot: string;
  let bookService: { getById: ReturnType<typeof vi.fn>; getAll: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  let db: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let service: RenameService;

  beforeEach(() => {
    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-1418-rename-'));
    bookService = { getById: vi.fn(), getAll: vi.fn(), update: vi.fn().mockResolvedValue(undefined) };
    db = createMockDb();
    db.select.mockReturnValue(mockDbChain([])); // no conflicting book
    log = inject<FastifyBaseLogger>(createMockLogger());
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  function buildService(fileFormat: string): void {
    const settingsService = createMockSettingsService({
      library: { path: libraryRoot, folderFormat: '{author}/{title}', fileFormat },
    });
    service = new RenameService(
      inject<Db>(db),
      inject<BookService>(bookService),
      inject<SettingsService>(settingsService),
      log,
    );
  }

  function bookAt(path: string) {
    return {
      ...createMockDbBook({ id: 1, title: 'The Way of Kings', path, status: 'imported' }),
      authors: [createMockDbAuthor({ name: 'Brandon Sanderson' })],
    };
  }

  /** Arrange a live marker (file) + populated .import-bak beside `oldPath`. */
  async function armMarker(oldPath: string, originalAudio: string): Promise<void> {
    await mkdir(`${oldPath}.import-bak`, { recursive: true });
    await writeFile(join(`${oldPath}.import-bak`, originalAudio), Buffer.alloc(200, 7));
    await writeFile(`${oldPath}.import-commit-pending`, '');
  }

  it('happy path: clean oldPath with no marker moves the folder and resurrects nothing on a sweep', async () => {
    buildService('');
    const oldPath = join(libraryRoot, 'Wrong Author', 'Old Title');
    const target = join(libraryRoot, 'Brandon Sanderson', 'The Way of Kings');
    await mkdir(oldPath, { recursive: true });
    await writeFile(join(oldPath, 'book.mp3'), Buffer.alloc(300, 1));
    bookService.getById.mockResolvedValue(bookAt(oldPath));

    await service.renameBook(1);

    expect(await pathExists(oldPath)).toBe(false);
    expect(await listFiles(target)).toEqual(['book.mp3']);
    // No marker/backup resurrected anywhere.
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
  });

  it('folder move with a live marker: recovery restores .import-bak, consumes the marker, then moves', async () => {
    buildService('');
    const oldPath = join(libraryRoot, 'Wrong Author', 'Old Title');
    const target = join(libraryRoot, 'Brandon Sanderson', 'The Way of Kings');
    await mkdir(oldPath, { recursive: true });
    await armMarker(oldPath, 'original.mp3');
    bookService.getById.mockResolvedValue(bookAt(oldPath));

    await service.renameBook(1);

    // The marker + backup were consumed before the move; the recovered audio rode along.
    expect(await pathExists(`${oldPath}.import-commit-pending`)).toBe(false);
    expect(await pathExists(`${oldPath}.import-bak`)).toBe(false);
    expect(await pathExists(oldPath)).toBe(false);
    expect(await listFiles(target)).toContain('original.mp3');
    // renameBook stores the new path POSIX-normalized (DB paths are POSIX; consumed in Docker);
    // `target` is a native tmpdir path, so normalize before matching on a Windows dev box.
    expect(bookService.update).toHaveBeenCalledWith(1, { path: target.split('\\').join('/') });
    // A subsequent boot sweep finds nothing to recover at the old path.
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
  });

  it('F5 path-unchanged file rename with a live marker: recovery runs before the in-place rename', async () => {
    buildService('{author} - {title}');
    const path = join(libraryRoot, 'Brandon Sanderson', 'The Way of Kings');
    await mkdir(path, { recursive: true });
    await armMarker(path, 'original.mp3');
    bookService.getById.mockResolvedValue(bookAt(path));

    const result = await service.renameBook(1);

    // Folder name already matched the target — no move, but file-template rename ran on the
    // converged folder after recovery restored the original audio.
    expect(result.filesRenamed).toBe(1);
    expect(await pathExists(`${path}.import-commit-pending`)).toBe(false);
    expect(await listFiles(path)).toEqual(['Brandon Sanderson - The Way of Kings.mp3']);
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
  });

  it('MarkerPathConflictError (#1341): a directory at the marker path aborts with state intact', async () => {
    buildService('');
    const oldPath = join(libraryRoot, 'Wrong Author', 'Old Title');
    await mkdir(oldPath, { recursive: true });
    await writeFile(join(oldPath, 'book.mp3'), Buffer.alloc(300, 1));
    await mkdir(`${oldPath}.import-bak`, { recursive: true });
    // A DIRECTORY (not a file) occupies the marker path → MarkerPathConflictError.
    await mkdir(`${oldPath}.import-commit-pending`, { recursive: true });
    bookService.getById.mockResolvedValue(bookAt(oldPath));

    await expect(service.renameBook(1)).rejects.toMatchObject({ code: 'MARKER_PATH_CONFLICT' });

    // No destructive mutation ran: the folder, its backup, and the marker collision are intact.
    expect(await pathExists(oldPath)).toBe(true);
    expect(await listFiles(oldPath)).toEqual(['book.mp3']);
    expect(await pathExists(`${oldPath}.import-bak`)).toBe(true);
    expect(bookService.update).not.toHaveBeenCalled();
  });
});
