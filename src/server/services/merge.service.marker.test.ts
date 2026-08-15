import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dotPrefixBasename } from '@core/utils/hidden-staging.js';
import { removeTree } from '@core/utils/remove-tree.js';
import { createMockLogger, createMockDb, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook, createMockDbAuthor } from '../__tests__/factories.js';
import { MergeService } from './merge.service.js';
import { findCommitPendingMarkers } from '../utils/import-marker-sweep.js';
import { deriveImportSiblings } from '../utils/import-sibling-paths.js';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudio } from './enrichment-utils.js';
import type { BookService } from './book.service.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Run real marker recovery on a temp filesystem before merge; otherwise later recovery could
 * restore a backup over committed output. Only the audio engine and enrichment are stubbed.
 */
vi.mock('@core/utils/audio-processor.js', () => ({ processAudioFiles: vi.fn(), resolveFfmpegPath: () => Promise.resolve('/usr/bin/ffmpeg') }));
vi.mock('@core/utils/audio-scanner.js', () => ({ scanAudioDirectory: vi.fn() }));
vi.mock('./enrichment-utils.js', () => ({ enrichBookFromAudio: vi.fn() }));

const SCAN_RESULT = {
  codec: 'aac', bitrate: 128000, sampleRate: 44100, channels: 2, bitrateMode: 'cbr' as const,
  fileFormat: 'm4b', fileCount: 1, totalSize: 500, totalDuration: 36000, hasCoverArt: false,
};
const OUTPUT = 'The Way of Kings.m4b';

const pathExists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);

/** Wait on terminal SSE instead of racing fire-and-forget execution with a fixed sleep. */
async function waitForMergeSettled(emit: Mock): Promise<void> {
  await vi.waitFor(
    () => expect(emit).toHaveBeenCalledWith(expect.stringMatching(/^merge_(complete|failed)$/), expect.anything()),
    { timeout: 5000, interval: 10 },
  );
}
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

    // Produce a staged output without ffmpeg.
    (processAudioFiles as Mock).mockImplementation(async (stagingDir: string) => {
      await writeFile(join(stagingDir, OUTPUT), Buffer.alloc(500, 9));
      return { success: true };
    });
    (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
    (enrichBookFromAudio as Mock).mockResolvedValue({ enriched: true });
  });

  afterEach(async () => {
    await removeTree(libraryRoot);
  });

  function buildService(): MergeService {
    const settingsService = createMockSettingsService({
      processing: { outputFormat: 'm4b', bitrate: 128, keepOriginalBitrate: false, maxConcurrentProcessing: 1 },
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

  /** Create a legacy marker and populated backup beside bookPath. */
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
    await waitForMergeSettled(emit);

    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ book_id: 42, success: true }));
  });

  it('live marker recovered → merge output is committed and a later sweep cannot revert it', async () => {
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await armMarker(['orig.mp3']);

    await buildService().enqueueMerge(42);
    await waitForMergeSettled(emit);

    expect(await pathExists(`${bookPath}.import-commit-pending`)).toBe(false);
    expect(await pathExists(`${bookPath}.import-bak`)).toBe(false);
    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ book_id: 42, success: true }));
  });

  it('#1911: recovery through the unified seam consumes an ACTIVE `.import-backup` before committing the merge', async () => {
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    const activeBackup = deriveImportSiblings(bookPath).backupPath;
    await mkdir(activeBackup, { recursive: true });
    await writeFile(join(activeBackup, 'orig.mp3'), Buffer.alloc(150, 3));
    await writeFile(`${bookPath}.import-commit-pending`, '');

    await buildService().enqueueMerge(42);
    await waitForMergeSettled(emit);

    expect(await pathExists(`${bookPath}.import-commit-pending`)).toBe(false);
    expect(await pathExists(activeBackup)).toBe(false);
    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await findCommitPendingMarkers(libraryRoot)).toEqual([]);
    expect(emit).toHaveBeenCalledWith('merge_complete', expect.objectContaining({ book_id: 42, success: true }));
  });

  it('F8: staging + originals-deletion operate on the post-recovery file set', async () => {
    // Recovery adds orig.mp3; merge must re-read inputs afterward and consume it.
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await armMarker(['orig.mp3']);

    await buildService().enqueueMerge(42);
    await waitForMergeSettled(emit);

    expect(await listFiles(bookPath)).toEqual([OUTPUT]);
    expect(await pathExists(join(bookPath, 'orig.mp3'))).toBe(false);
  });

  it('recovery failure (#1341 marker-path collision) aborts the merge with state intact', async () => {
    await mkdir(bookPath, { recursive: true });
    await writeFile(join(bookPath, '01.mp3'), Buffer.alloc(300, 1));
    await writeFile(join(bookPath, '02.mp3'), Buffer.alloc(300, 2));
    await mkdir(`${bookPath}.import-bak`, { recursive: true });
    await mkdir(`${bookPath}.import-commit-pending`, { recursive: true });

    await buildService().enqueueMerge(42);
    await waitForMergeSettled(emit);

    expect(processAudioFiles).not.toHaveBeenCalled();
    expect(await listFiles(bookPath)).toEqual(['01.mp3', '02.mp3']);
    expect(await pathExists(`${bookPath}.import-bak`)).toBe(true);
    expect(await pathExists(dotPrefixBasename(`${bookPath}.merge-tmp`))).toBe(false);
    expect(emit).toHaveBeenCalledWith('merge_failed', expect.objectContaining({ book_id: 42, reason: 'error' }));
  });
});
