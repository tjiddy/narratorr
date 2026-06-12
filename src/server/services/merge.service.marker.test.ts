import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockLogger, createMockDb, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { MergeService } from './merge.service.js';
import { findCommitPendingMarkers } from '../utils/import-staging.js';
import { processAudioFiles } from '../../core/utils/audio-processor.js';
import { scanAudioDirectory } from '../../core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { Db } from '../../db/index.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * #1418 — `executeMerge` is a mid-uptime writer that must converge a stranded
 * `.import-commit-pending` marker on `bookPath` BEFORE writing the merged output, or a
 * later import/boot recovery silently reverts the merge by restoring `.import-bak`. These
 * tests run the REAL recovery sequence over a real tmpdir (the marker machinery
 * short-circuits to "marker present" under mocked fs, #1391); only the ffmpeg engine and
 * enrichment are stubbed.
 */

// Only the audio engine + enrichment are mocked — fs and the recovery sequence are real.
vi.mock('../../core/utils/audio-processor.js', () => ({ processAudioFiles: vi.fn() }));
vi.mock('../../core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('./enrichment-utils.js', () => ({ enrichBookFromAudio: vi.fn() }));

const SCAN_RESULT = {
  codec: 'aac', bitrate: 128000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr' as const,
  fileFormat: 'm4b', fileCount: 1, totalSize: 500, totalDuration: 36000, hasCoverArt: false,
};
const OUTPUT = 'The Way of Kings.m4b';

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
async function listFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name).sort();
}

describe('MergeService marker convergence (#1418, real tmpdir)', () => {
  let libraryRoot: string;
  let bookPath: string;
  let bookService: { getById: Mock; update: Mock };
  let db: ReturnType<typeof createMockDb>;
  let log: FastifyBaseLogger;
  let emit: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-1418-merge-'));
    bookPath = join(libraryRoot, 'Author', 'The Way of Kings');
    const book = {
      ...createMockDbBook({ id: 42, title: 'The Way of Kings', path: bookPath, status: 'imported' }),
      authors: [createMockDbAuthor({ name: 'Brandon Sanderson' })],
      narrators: [],
    };
    bookService = { getById: vi.fn().mockResolvedValue(book), update: vi.fn().mockResolvedValue(undefined) };
    db = createMockDb();
    log = inject<FastifyBaseLogger>(createMockLogger());
    emit = vi.fn();

    // Engine stub: write a fake merged output into the staging dir so the post-process
    // readdir discovers it (real ffmpeg is unavailable in tests).
    (processAudioFiles as Mock).mockImplementation(async (stagingDir: string) => {
      await writeFile(join(stagingDir, OUTPUT), Buffer.alloc(500, 9));
      return { success: true };
    });
    (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
    (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
  });

  afterEach(async () => {
    await rm(libraryRoot, { recursive: true, force: true });
  });

  function buildService(): MergeService {
    const settingsService = createMockSettingsService({
      processing: { ffmpegPath: '/usr/bin/ffmpeg', outputFormat: 'm4b', bitrate: 128, keepOriginalBitrate: false, maxConcurrentProcessing: 1 },
      library: { path: libraryRoot },
    });
    return new MergeService(
      inject<Db>(db),
      inject<BookService>(bookService),
      inject<SettingsService>(settingsService),
      log,
      undefined,
      inject<EventBroadcasterService>({ emit }),
    );
  }

  /** Arrange a live marker (file) + populated .import-bak beside bookPath. */
  async function armMarker(originals: string[]): Promise<void> {
    await mkdir(`${bookPath}.import-bak`, { recursive: true });
    for (const name of originals) await writeFile(join(`${bookPath}.import-bak`, name), Buffer.alloc(150, 3));
    await writeFile(`${bookPath}.import-commit-pending`, '');
  }

  it('happy path: clean bookPath with no marker merges and resurrects nothing', async () => {
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));

    await buildService().enqueueMerge(42);
    await settle();

    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ book_id: 42, success: true }));
  });

  it('live marker recovered → merge output is committed and a later sweep cannot revert it', async () => {
    // bookPath currently holds 2 audio files (passes pre-enqueue validation); a killed import
    // left an armed marker + a populated .import-bak beside it.
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await armMarker(['orig.mp3']);

    await buildService().enqueueMerge(42);
    await settle();

    // Marker + backup were consumed before the output was written.
    expect(await pathExists(`${bookPath}.import-commit-pending`)).toBe(false);
    expect(await pathExists(`${bookPath}.import-bak`)).toBe(false);
    // Only the merged output remains — all originals (incl. the recovery-restored one) deleted.
    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    // No marker survives, so a subsequent import/boot recovery cannot revert the merge.
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ book_id: 42, success: true }));
  });

  it('F8: staging + originals-deletion operate on the post-recovery file set', async () => {
    // bookPath has 2 current files; recovery restores a THIRD original (orig.mp3) that did not
    // exist pre-recovery. Because the merge re-reads bookPath after recovery, orig.mp3 must be
    // staged and then deleted as an original — leaving only the merged output.
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await armMarker(['orig.mp3']);

    await buildService().enqueueMerge(42);
    await settle();

    // The recovery-restored original was merged in and deleted, not left behind as a stale file.
    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await pathExists(join(bookPath, 'orig.mp3'))).toBe(false);
  });

  it('recovery failure (#1341 marker-path collision) aborts the merge with state intact', async () => {
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await mkdir(`${bookPath}.import-bak`, { recursive: true });
    // A directory occupies the marker path → MarkerPathConflictError from the preflight.
    await mkdir(`${bookPath}.import-commit-pending`, { recursive: true });

    await buildService().enqueueMerge(42);
    await settle();

    // No ffmpeg work ran; no output committed; the originals + collision are untouched.
    expect(processAudioFiles).not.toHaveBeenCalled();
    expect(await listFiles(bookPath)).toEqual(['01.mp3', '02.mp3']);
    expect(await pathExists(`${bookPath}.import-bak`)).toBe(true);
    expect(await pathExists(`${bookPath}.merge-tmp`)).toBe(false);
    expect(emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
  });
});
