import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { createDb, runMigrations, type Db } from '@db/index.js';
import { books } from '@db/schema.js';
import { BookService } from './book.service.js';
import { MergeService } from './merge.service.js';
import { withBookAdmissionLock, hasPendingBookAdmission } from './book-admission.js';
import { generatePublicId } from '../utils/public-id.js';
import { createMockLogger, inject } from '../__tests__/helpers.js';
import { deferred, SCAN_RESULT } from './__tests__/merge-fixtures.js';
import type { SettingsService } from './settings.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { EventHistoryService } from './event-history.service.js';

// Everything the merge would do to the disk stays REAL — that is the point of this suite. Only the
// encoder, the verification probe and the post-merge enrichment are doubled.
vi.mock('@core/utils/audio-processor.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  resolveFfmpegPath: vi.fn().mockResolvedValue('/usr/bin/ffmpeg'),
  processAudioFiles: vi.fn(),
}));

vi.mock('@core/utils/audio-scanner.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  scanAudioDirectory: vi.fn(),
}));

vi.mock('./enrichment-utils.js', () => ({ enrichBookFromAudioWithinAdmissionLock: vi.fn() }));

const actualRecovery = await vi.importActual<typeof import('../utils/recover-interrupted-commit.js')>('../utils/recover-interrupted-commit.js');
vi.mock('../utils/recover-interrupted-commit.js', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  recoverInterruptedCommit: vi.fn(),
}));

import { processAudioFiles } from '@core/utils/audio-processor.js';
import { scanAudioDirectory } from '@core/utils/audio-scanner.js';
import { enrichBookFromAudioWithinAdmissionLock } from './enrichment-utils.js';
import { recoverInterruptedCommit } from '../utils/recover-interrupted-commit.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };

/** Poll rather than guess a tick count: this suite awaits real filesystem and libSQL work. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * #2462. A merge that has been broadcast active but is still waiting for another mutator to release
 * the book's admission lock must be cancellable, and the merge that later wakes must run nothing.
 * The lock, the filesystem and the database are all real here, so "nothing ran" is observed as the
 * absence of a staging sibling on disk and an untouched row — not as an unfired mock.
 */
describe('cancelling a merge that is waiting for the admission lock (#2462)', () => {
  type Frame = { event: string; payload: Record<string, unknown> };
  type HistoryRow = { bookId: number; eventType: string; source: string };

  let dir: string;
  let root: string;
  let db: Db;
  let bookService: BookService;
  let mergeService: MergeService;
  let frames: Frame[];
  let historyRows: HistoryRow[];

  const settings = () => inject<SettingsService>({
    get: vi.fn().mockImplementation(async (category: string) => {
      if (category === 'library') return { path: root, folderFormat: '{author}/{title}', fileFormat: '' };
      if (category === 'processing') return { outputFormat: 'm4b', bitrate: 64, keepOriginalBitrate: true, maxConcurrentProcessing: 1 };
      return {};
    }),
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (recoverInterruptedCommit as Mock).mockImplementation(actualRecovery.recoverInterruptedCommit as never);
    // The default encode never succeeds; the cases that need a real merged file override it.
    (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'encode stopped for the test' });
    (scanAudioDirectory as Mock).mockResolvedValue(SCAN_RESULT);
    (enrichBookFromAudioWithinAdmissionLock as Mock).mockResolvedValue({ enriched: true });

    dir = mkdtempSync(join(tmpdir(), 'merge-cancel-wait-'));
    root = join(dir, 'library');
    await mkdir(root, { recursive: true });
    const dbFile = join(dir, 'narratorr.db');
    await runMigrations(dbFile);
    db = createDb(dbFile);
    const logger = inject<FastifyBaseLogger>(createMockLogger());

    frames = [];
    historyRows = [];
    bookService = new BookService(db, logger);
    mergeService = new MergeService(
      db, bookService, settings(), logger,
      inject<EventHistoryService>({ create: vi.fn(async (row: HistoryRow) => { historyRows.push(row); }) }),
      inject<EventBroadcasterService>({
        emit: vi.fn((event: string, payload: Record<string, unknown>) => { frames.push({ event, payload }); }),
      }),
    );
  });

  afterEach(() => {
    db.$client.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows keeps libSQL handles open; see windows-hostile-test-primitives.
    }
  });

  /** Merge needs at least two top-level audio files; the stale size/date make any write visible. */
  const seedMergeableBook = async (title: string): Promise<{ id: number; path: string }> => {
    const path = join(root, 'Author', title);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, '01.mp3'), 'a');
    await writeFile(join(path, '02.mp3'), 'b');
    const [row] = await db
      .insert(books)
      .values({
        publicId: generatePublicId('bk'), title, path, status: 'imported',
        size: 4242, updatedAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning();
    return { id: row!.id, path };
  };

  const readRow = async (id: number) => (await db.select().from(books).where(eq(books.id, id)))[0]!;
  const framesOf = (event: string, bookId: number) => frames.filter((f) => f.event === event && f.payload.book_id === bookId);
  const historyOf = (bookId: number, eventType: string) => historyRows.filter((r) => r.bookId === bookId && r.eventType === eventType);
  /** Staging is a dot-prefixed sibling of the book folder, so the parent listing is the observable. */
  const stagingSiblings = async (bookPath: string) =>
    (await readdir(dirname(bookPath))).filter((e) => e.endsWith('.merge-tmp') && e.includes(basename(bookPath)));
  const callsTouching = (mock: Mock, needle: string) =>
    mock.mock.calls.filter((call) => String(call[0]).split('\\').join('/').includes(needle));

  it('settles at cancel time and leaves the book untouched when the lock frees', async () => {
    const { id, path } = await seedMergeableBook('Wanderer');

    // The shape a real operator hits: an import copy or retag holding the book for minutes.
    const parked = deferred();
    const holder = withBookAdmissionLock(id, () => parked.promise);

    await mergeService.enqueueMerge(id);
    await settle();
    expect(mergeService.getMergeStateSnapshot().active).toEqual([
      { book_id: id, book_title: 'Wanderer', phase: 'starting' },
    ]);

    expect(await mergeService.cancelMerge(id)).toEqual({ status: 'cancelled' });

    // Observable while the lock is still held.
    expect(framesOf('merge_failed', id)).toHaveLength(1);
    expect(framesOf('merge_failed', id)[0]!.payload).toMatchObject({
      book_title: 'Wanderer', error: 'Cancelled by user', reason: 'cancelled',
    });
    expect(historyOf(id, 'merge_failed')).toHaveLength(1);
    expect(mergeService.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });

    parked.resolve();
    await holder;
    await settle();

    expect(framesOf('merge_started', id)).toHaveLength(0);
    expect(historyOf(id, 'merge_started')).toHaveLength(0);
    expect(recoverInterruptedCommit).not.toHaveBeenCalled();
    expect(processAudioFiles).not.toHaveBeenCalled();
    expect(scanAudioDirectory).not.toHaveBeenCalled();

    expect(await stagingSiblings(path)).toEqual([]);
    expect((await readdir(path)).sort()).toEqual(['01.mp3', '02.mp3']);

    const row = await readRow(id);
    expect(row.size).toBe(4242);
    expect(row.updatedAt).toEqual(new Date('2020-01-01T00:00:00Z'));

    expect(framesOf('merge_failed', id)).toHaveLength(1);
    expect(frames.filter((f) => f.event === 'merge_complete')).toHaveLength(0);
    await waitFor(() => !hasPendingBookAdmission(id), 'the admission chain to drain');
  });

  it('answers the same when the wait is reached through the queued promotion path', async () => {
    const blocker = await seedMergeableBook('Blocker');
    const target = await seedMergeableBook('Target');

    // Hold the target's lock before it is ever promoted, so its only wait is on admission.
    const parked = deferred();
    const holder = withBookAdmissionLock(target.id, () => parked.promise);

    const encode = deferred();
    (processAudioFiles as Mock).mockImplementation(async () => {
      await encode.promise;
      return { success: false, error: 'encode stopped for the test' };
    });

    await mergeService.enqueueMerge(blocker.id);
    expect(await mergeService.enqueueMerge(target.id)).toMatchObject({ status: 'queued' });
    await waitFor(() => (processAudioFiles as Mock).mock.calls.length === 1, 'the blocker to reach its encode');

    encode.resolve();
    await waitFor(
      () => mergeService.getMergeStateSnapshot().active.some((e) => e.book_id === target.id),
      'the target to be promoted to active',
    );
    expect(mergeService.getMergeStateSnapshot().active).toEqual([
      { book_id: target.id, book_title: 'Target', phase: 'starting' },
    ]);

    expect(await mergeService.cancelMerge(target.id)).toEqual({ status: 'cancelled' });
    expect(framesOf('merge_failed', target.id)).toHaveLength(1);
    expect(framesOf('merge_failed', target.id)[0]!.payload).toMatchObject({ error: 'Cancelled by user', reason: 'cancelled' });
    expect(mergeService.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });

    parked.resolve();
    await holder;
    await settle();

    expect(framesOf('merge_started', target.id)).toHaveLength(0);
    expect(callsTouching(recoverInterruptedCommit as Mock, 'Target')).toHaveLength(0);
    expect(callsTouching(processAudioFiles as Mock, 'Target')).toHaveLength(0);
    expect(await stagingSiblings(target.path)).toEqual([]);
    expect((await readdir(target.path)).sort()).toEqual(['01.mp3', '02.mp3']);
    expect((await readRow(target.id)).size).toBe(4242);
    expect(framesOf('merge_failed', target.id)).toHaveLength(1);
    expect(framesOf('merge_complete', target.id)).toHaveLength(0);
  });

  it('lets the same book merge to completion after a cancelled wait', async () => {
    const { id, path } = await seedMergeableBook('Wanderer');

    const parked = deferred();
    const holder = withBookAdmissionLock(id, () => parked.promise);
    await mergeService.enqueueMerge(id);
    await settle();
    expect(await mergeService.cancelMerge(id)).toEqual({ status: 'cancelled' });
    parked.resolve();
    await holder;
    await settle();

    // The flag did not outlive the merge that armed it: a fresh enqueue runs end to end.
    (processAudioFiles as Mock).mockImplementation(async (stagingDir: string) => {
      await writeFile(join(stagingDir, 'Wanderer.m4b'), 'merged output');
      return { success: true, outputFiles: [join(stagingDir, 'Wanderer.m4b')] };
    });

    await mergeService.enqueueMerge(id);
    await waitFor(() => framesOf('merge_complete', id).length === 1, 'the second merge to complete');

    expect(framesOf('merge_started', id)).toHaveLength(1);
    expect((await readdir(path)).sort()).toEqual(['Wanderer.m4b']);
    expect(await stagingSiblings(path)).toEqual([]);
    expect((await readRow(id)).size).toBe('merged output'.length);
  });
});
