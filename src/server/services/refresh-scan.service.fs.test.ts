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
 * #2172 — the real-filesystem half of the single-file pointer fix.
 *
 * The service suite (`refresh-scan.service.test.ts`) decides the root kind from a fully mocked
 * `node:fs/promises`, so no case there can observe the actual `ENOTDIR: not a directory, scandir`
 * that made "Refresh from files" fail outright for a pointer book. This file runs `refreshScanBook`
 * against a genuine tmpdir with the REAL filesystem, the REAL `scanAudioDirectory` (music-metadata
 * parsing the tracked `e2e/assets/silent.m4b` fixture, the pattern already in service in
 * `../__tests__/import-flow-real-scanner.e2e.test.ts`), the real visible-size walk and the real OPF
 * reader. Restoring the unconditional `readdir` makes exactly this test red with the reported errno.
 *
 * The one mock isolates an ambient input: whether ffmpeg/ffprobe happens to be installed on the host
 * would otherwise change which duration source the scan uses. music-metadata is the primary source
 * and ffprobe only arbitrates, so pinning it absent keeps the run deterministic without weakening
 * anything this test asserts.
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

  /** Seed a book row whose `path` is `path` and run the real refresh over it. */
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
    // A loose file adopted in place — what `ManualImportAdapter`'s pointer mode persists verbatim.
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
      // Proves the real scanner ran rather than a stub — the fixture is a genuine AAC/MPEG-4 file.
      audioFileCount: 1,
      enrichmentStatus: 'file-enriched',
    }));
  });

  // The root probe must FOLLOW symlinks, matching `walkSize`'s root `stat`. Only a real link can
  // observe that: under the mocked suite the root kind is dictated by the double, and `stat` vs
  // `lstat` are indistinguishable. Swap the production `stat` for `lstat` and this is the one case
  // that reds — `isFile()` goes false for the link, the root falls through to `readdir`, and a
  // supported pointer shape fails with the very ENOTDIR this PR set out to fix.
  //
  // Capability-probed rather than gated on `process.platform` (`windows-hostile-test-primitives`):
  // Windows needs Developer Mode for `symlink()`, but a box that has it should still run this.
  it.skipIf(!CAN_SYMLINK)('follows a symlink whose target is an audio file into the file branch', async () => {
    const { result, update } = await refreshBookAt(symlinkedPointerPath);

    expect(result.bookId).toBe(7);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toEqual(expect.objectContaining({
      topLevelAudioFileCount: 1,
      // The link resolves to the same fixture, so size and scanner output match the direct case.
      size: fixtureSize,
      audioFileCount: 1,
      enrichmentStatus: 'file-enriched',
    }));
  });
});
