import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, copyFile, rm, stat, symlink } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { inject } from '../__tests__/helpers.js';
import { CAN_SYMLINK } from '../__tests__/windows-fs.js';
import type { BookService, BookDetail } from './book.service.js';
import type { SettingsService } from './settings.service.js';

/**
 * Real filesystem/scanner regression for single-file pointers: mocked fs cannot surface ENOTDIR or
 * stat-vs-lstat behavior. Stub ffmpeg discovery only so host tools cannot change the duration source.
 */
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  resolveFfmpegPath: () => Promise.resolve(null),
}));

const { refreshScanBook } = await import('./refresh-scan.service.js');

const FIXTURE_PATH = join(import.meta.dirname, '..', '..', '..', 'e2e', 'assets', 'silent.m4b');

function makeLog(): FastifyBaseLogger {
  return inject<FastifyBaseLogger>({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
    silent: vi.fn(), level: 'info',
  });
}

describe('refreshScanBook against a real single-file pointer', () => {
  let libraryDir: string;
  let pointerPath: string;
  let symlinkedPointerPath: string;
  let fixtureSize: number;

  async function refreshBookAt(path: string) {
    const update = vi.fn().mockResolvedValue(null);
    const bookService = inject<BookService>({
      getById: vi.fn().mockResolvedValue(inject<BookDetail>({
        id: 7,
        title: 'Doctor Sleep',
        path,
        status: 'imported',
        userClearedFields: [],
        narrators: [],
        authors: [],
      })),
      update,
    });
    const result = await refreshScanBook(7, bookService, inject<SettingsService>({}), makeLog());
    return { result, update };
  }

  beforeAll(async () => {
    libraryDir = await mkdtemp(join(tmpdir(), 'narratorr-refresh-pointer-'));
    // ManualImportAdapter pointer mode stores this loose file path verbatim.
    pointerPath = join(libraryDir, 'Doctor Sleep.m4b');
    await copyFile(FIXTURE_PATH, pointerPath);
    fixtureSize = (await stat(pointerPath)).size;

    symlinkedPointerPath = join(libraryDir, 'Linked Doctor Sleep.m4b');
    if (CAN_SYMLINK) await symlink(pointerPath, symlinkedPointerPath);
  });

  afterAll(async () => {
    await rm(libraryDir, { recursive: true, force: true });
  });

  it('resolves instead of rejecting ENOTDIR, and persists a count of 1 with the file size', async () => {
    const { result, update } = await refreshBookAt(pointerPath);

    expect(result.bookId).toBe(7);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toEqual(expect.objectContaining({
      topLevelAudioFileCount: 1,
      size: fixtureSize,
      // The genuine AAC fixture proves the real scanner ran.
      audioFileCount: 1,
      enrichmentStatus: 'file-enriched',
    }));
  });

  // Root probing must follow symlinks like walkSize; lstat would fall through to readdir/ENOTDIR.
  // Capability-probe because Windows symlink support depends on Developer Mode.
  it.skipIf(!CAN_SYMLINK)('follows a symlink whose target is an audio file into the file branch', async () => {
    const { result, update } = await refreshBookAt(symlinkedPointerPath);

    expect(result.bookId).toBe(7);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toEqual(expect.objectContaining({
      topLevelAudioFileCount: 1,
      size: fixtureSize,
      audioFileCount: 1,
      enrichmentStatus: 'file-enriched',
    }));
  });
});
