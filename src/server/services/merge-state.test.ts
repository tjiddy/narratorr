import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createMockLogger, createMockDb, inject, createMockSettingsService } from '../__tests__/helpers.js';
import { createMockDbBook } from '../__tests__/factories.js';
import { MergeService } from './merge.service.js';
import { processAudioFiles } from '@core/utils/audio-processor.js';
import type { BookService } from './book.service.js';
import type { EventHistoryService } from './event-history.service.js';
import type { EventBroadcasterService } from './event-broadcaster.service.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { MergeStateSnapshot } from '@shared/schemas/sse-events.js';
import { readdir, rename } from 'node:fs/promises';
import {
  BOOK_PATH, STAGING_DIR, mockAuthor, mockBook, processingOverrides,
  settle, setupHappyPath, setupBlockingMerge,
} from './__tests__/merge-fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    mkdir: vi.fn(),
    cp: vi.fn(),
    unlink: vi.fn(),
    stat: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
  };
});

const { ffmpegState } = vi.hoisted(() => ({ ffmpegState: { resolves: true } }));
vi.mock('@core/utils/audio-processor.js', () => ({
  processAudioFiles: vi.fn(),
  // A hoisted toggle survives mock resets for the disappearing-ffmpeg test.
  resolveFfmpegPath: () => Promise.resolve(ffmpegState.resolves ? '/usr/bin/ffmpeg' : null),
}));

vi.mock('@core/utils/audio-scanner.js', () => ({
  scanAudioDirectory: vi.fn(),
}));

vi.mock('./enrichment-utils.js', () => ({
  enrichBookFromAudioWithinAdmissionLock: vi.fn(),
}));

// Marker recovery touches real fs and short-circuits incorrectly under this suite's fs mocks.
vi.mock('../utils/recover-interrupted-commit.js', () => ({
  recoverInterruptedCommit: vi.fn().mockResolvedValue(undefined),
}));

describe('#2129 merge_state snapshot', () => {
  type Frame = { event: string; payload: unknown };

  /** Capture state during terminal emit; final state alone cannot prove delete-before-emit ordering. */
  function createSnapshotHarness(opts?: {
    books?: Array<{ id: number; title: string; path?: string }>;
    maxConcurrentProcessing?: number;
  }) {
    const bookRows = (opts?.books ?? [{ id: 42, title: 'Dogs of War' }]).map((b) => ({
      ...createMockDbBook({ id: b.id, title: b.title, path: b.path ?? `/lib/${b.id}`, status: 'imported' }),
      authors: [mockAuthor], narrators: [],
    }));

    const frames: Frame[] = [];
    const stateAtTerminal = new Map<number, MergeStateSnapshot>();
    const holder: { service?: MergeService } = {};

    const eventBroadcaster = {
      emit: vi.fn((event: string, payload: unknown) => {
        frames.push({ event, payload });
        if (event === 'merge_complete' || event === 'merge_failed') {
          stateAtTerminal.set((payload as { book_id: number }).book_id, holder.service!.getMergeStateSnapshot());
        }
      }),
    } as unknown as EventBroadcasterService;

    const bookService = {
      getById: vi.fn(async (id: number) => bookRows.find((b) => b.id === id) ?? null),
      update: vi.fn().mockResolvedValue(undefined),
    };

    const historyRows: Array<{ bookId: number; eventType: string }> = [];
    const eventHistory = {
      create: vi.fn(async (input: { bookId: number; eventType: string }) => { historyRows.push(input); }),
    } as unknown as EventHistoryService;

    const service = new MergeService(
      inject<Db>(createMockDb()),
      inject<BookService>(bookService),
      createMockSettingsService({
        processing: { ...processingOverrides.processing, ...(opts?.maxConcurrentProcessing !== undefined && { maxConcurrentProcessing: opts.maxConcurrentProcessing }) },
      }),
      inject<FastifyBaseLogger>(createMockLogger()),
      eventHistory,
      eventBroadcaster,
    );
    holder.service = service;

    const snapshots = () => frames.filter((f) => f.event === 'merge_state').map((f) => f.payload as MergeStateSnapshot);
    const events = () => frames.map((f) => f.event);
    const framesAfter = (event: string, bookId: number) =>
      frames.slice(frames.findIndex((f) => f.event === event && (f.payload as { book_id?: number }).book_id === bookId) + 1);

    const historyFor = (bookId: number, eventType: string) => historyRows.filter((r) => r.bookId === bookId && r.eventType === eventType);

    return { service, bookService, frames, snapshots, events, framesAfter, stateAtTerminal, historyFor };
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is empty with nothing in flight', () => {
    const { service } = createSnapshotHarness();
    expect(service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
  });

  it('is built synchronously, without a book read', () => {
    setupBlockingMerge();
    const { service, bookService } = createSnapshotHarness();

    const readsBefore = bookService.getById.mock.calls.length;
    const snapshot = service.getMergeStateSnapshot();

    expect(snapshot).not.toBeInstanceOf(Promise);
    expect(snapshot).toEqual({ active: [], queued: [] });
    expect(bookService.getById.mock.calls.length).toBe(readsBefore);
  });

  it('installs nothing and broadcasts nothing when pre-flight validation rejects', async () => {
    (readdir as Mock).mockResolvedValue(['01.mp3', '02.mp3']);
    const { service, bookService, frames } = createSnapshotHarness({
      books: [{ id: 42, title: 'Dogs of War' }],
    });

    bookService.getById.mockResolvedValue(null);
    await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    bookService.getById.mockResolvedValue({ ...createMockDbBook({ id: 42, title: 'Dogs of War', path: null, status: 'imported' }), authors: [], narrators: [] });
    await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_PATH' });

    bookService.getById.mockResolvedValue({ ...createMockDbBook({ id: 42, title: 'Dogs of War', path: '/lib/42', status: 'wanted' }), authors: [], narrators: [] });
    await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'NO_STATUS' });

    expect(service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
    expect(frames).toEqual([]);
  });

  it('reports an admitted merge as `starting` before its first progress emit', async () => {
    setupBlockingMerge();
    const { service, snapshots } = createSnapshotHarness();

    await service.enqueueMerge(42);

    expect(snapshots()[0]).toEqual({
      active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'starting' }],
      queued: [],
    });
  });

  it('carries the running merge in `active` and the waiting one in `queued`, with titles', async () => {
    setupBlockingMerge();
    const { service } = createSnapshotHarness({
      books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
    });

    await service.enqueueMerge(42);
    await settle(); // 42 reaches the blocked encode
    await service.enqueueMerge(43);

    expect(service.getMergeStateSnapshot()).toEqual({
      active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing' }],
      queued: [{ book_id: 43, book_title: 'The Shining' }],
    });
  });

  it('preserves FIFO order across three queued books', async () => {
    setupBlockingMerge();
    const { service } = createSnapshotHarness({
      books: [42, 43, 44, 45].map((id) => ({ id, title: `Book ${id}` })),
    });

    await service.enqueueMerge(42);
    await service.enqueueMerge(43);
    await service.enqueueMerge(44);
    await service.enqueueMerge(45);

    expect(service.getMergeStateSnapshot().queued).toEqual([
      { book_id: 43, book_title: 'Book 43' },
      { book_id: 44, book_title: 'Book 44' },
      { book_id: 45, book_title: 'Book 45' },
    ]);
  });

  it('promotes a queued book in a single frame — never in both lists, never in neither', async () => {
    const { release } = setupBlockingMerge();
    const { service, snapshots } = createSnapshotHarness({
      books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
    });

    await service.enqueueMerge(42);
    await service.enqueueMerge(43);
    const beforePromotion = snapshots().length;

    release();
    await settle();

    const promotionFrames = snapshots().slice(beforePromotion);
    const flipIndex = promotionFrames.findIndex((f) => f.active.some((e) => e.book_id === 43));
    expect(flipIndex).toBeGreaterThan(-1);

    for (const frame of promotionFrames.slice(0, flipIndex)) {
      expect(frame.queued.some((e) => e.book_id === 43)).toBe(true);
      expect(frame.active.some((e) => e.book_id === 43)).toBe(false);
    }
    const flip = promotionFrames[flipIndex]!;
    expect(flip.active.find((e) => e.book_id === 43)).toEqual({ book_id: 43, book_title: 'The Shining', phase: 'starting' });
    expect(flip.queued.some((e) => e.book_id === 43)).toBe(false);
    expect(promotionFrames.slice(flipIndex).some((f) => f.queued.some((e) => e.book_id === 43))).toBe(false);
  });

  it('promotion and queued-cancel read no other book rows (#2142 — the per-book position reads are gone)', async () => {
    const { release } = setupBlockingMerge();
    const harness = createSnapshotHarness({
      books: [42, 43, 44].map((id) => ({ id, title: `Book ${id}` })),
    });

    await harness.service.enqueueMerge(42);
    await harness.service.enqueueMerge(43);
    await harness.service.enqueueMerge(44);
    const readsBeforeCancel = harness.bookService.getById.mock.calls.length;
    const snapshotsBeforeCancel = harness.snapshots().length;

    await harness.service.cancelMerge(44);
    expect(harness.bookService.getById.mock.calls.length).toBe(readsBeforeCancel);
    expect(harness.snapshots().length).toBe(snapshotsBeforeCancel + 1);

    const readsBeforePromotion = harness.bookService.getById.mock.calls.length;
    release();
    await settle();
    const promotionReads = harness.bookService.getById.mock.calls.slice(readsBeforePromotion);
    expect(promotionReads.length).toBeGreaterThan(0);
    expect(promotionReads.every(([id]) => id === 43)).toBe(true);
  });

  it('reflects and broadcasts every in-flight phase transition', async () => {
    setupHappyPath();
    const { service, frames, snapshots } = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

    await service.enqueueMerge(42);
    await settle();

    // Include `verifying`, the easy-to-miss phase between encoding and commit.
    const phasesSeen = snapshots().flatMap((s) => s.active.map((e) => e.phase));
    expect(phasesSeen).toContain('starting');
    expect(phasesSeen).toContain('staging');
    expect(phasesSeen).toContain('processing');
    expect(phasesSeen).toContain('verifying');
    expect(phasesSeen).toContain('committing');

    // Snapshot is the only wire form; retired incremental events must stay absent.
    const eventNames = new Set(frames.map((f) => f.event));
    expect(eventNames.has('merge_progress')).toBe(false);
    expect(eventNames.has('merge_queued')).toBe(false);
    expect(eventNames.has('merge_queue_updated')).toBe(false);
  });

  it('each progress tick emits exactly one wire frame — the snapshot (#2142)', async () => {
    setupHappyPath();
    const harness = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });
    let tickDelta = -1;
    let tickEvent: string | undefined;
    (processAudioFiles as Mock).mockImplementation(async (_dir: unknown, _cfg: unknown, _ctx: unknown, callbacks: { onProgress?: (phase: string, percentage: number) => void }) => {
      const before = harness.frames.length;
      callbacks.onProgress?.('processing', 0.5);
      tickDelta = harness.frames.length - before;
      tickEvent = harness.frames[before]?.event;
      return { success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] };
    });

    await harness.service.enqueueMerge(42);
    await settle();

    expect(tickDelta).toBe(1);
    expect(tickEvent).toBe('merge_state');
  });

  it('retains the last percentage between progress ticks', async () => {
    // A mid-encode client must get the current percentage before another tick arrives.
    setupHappyPath();
    let emitTick!: (percentage: number) => void;
    (processAudioFiles as Mock).mockImplementation(async (_dir: string, _cfg: unknown, _ctx: unknown, callbacks: { onProgress?: (phase: string, percentage: number) => void }) => {
      emitTick = (percentage) => callbacks.onProgress?.('processing', percentage);
      emitTick(0.35);
      return { success: true, outputFiles: [STAGING_DIR + '/The Way of Kings.m4b'] };
    });
    const { service, snapshots } = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

    await service.enqueueMerge(42);
    await settle();

    const tickFrame = snapshots().find((s) => s.active[0]?.percentage !== undefined);
    expect(tickFrame!.active[0]).toEqual({ book_id: 42, book_title: 'The Way of Kings', phase: 'processing', percentage: 0.35 });
  });

  it('runs every merge in `active` when maxConcurrentProcessing is raised', async () => {
    setupBlockingMerge();
    const { service } = createSnapshotHarness({
      books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
      maxConcurrentProcessing: 2,
    });

    await service.enqueueMerge(42);
    const ack = await service.enqueueMerge(43);

    expect(ack).toEqual({ status: 'started', bookId: 43 });
    expect(service.getMergeStateSnapshot().queued).toEqual([]);
    expect(service.getMergeStateSnapshot().active.map((e) => e.book_id).sort()).toEqual([42, 43]);
    // Higher global concurrency must not weaken per-book single-flight.
    await expect(service.enqueueMerge(42)).rejects.toMatchObject({ code: 'ALREADY_IN_PROGRESS' });
  });

  it('does not fail the merge when the broadcaster throws on a snapshot frame', async () => {
    setupHappyPath();
    const log = createMockLogger();
    const eventBroadcaster = {
      emit: vi.fn((event: string) => { if (event === 'merge_state') throw new Error('SSE broken'); }),
    } as unknown as EventBroadcasterService;
    const service = new MergeService(
      inject<Db>(createMockDb()),
      inject<BookService>({ getById: vi.fn().mockResolvedValue(mockBook), update: vi.fn() } as unknown as BookService),
      createMockSettingsService(processingOverrides),
      inject<FastifyBaseLogger>(log),
      undefined,
      eventBroadcaster,
    );

    await service.enqueueMerge(42);
    await settle();

    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 42 }), 'Book merged');
    expect(rename).toHaveBeenCalled();
  });

  describe('terminal transitions', () => {
    /** Assert delete → one terminal event → one cleared snapshot, with nothing between. */
    function expectTerminalOrder(harness: ReturnType<typeof createSnapshotHarness>, bookId: number, terminalEvent: string) {
      // Count the event too: duplicate terminals create duplicate toasts/history even if snapshots coalesce.
      expect(harness.frames.filter((f) => f.event === terminalEvent && (f.payload as { book_id: number }).book_id === bookId)).toHaveLength(1);

      const atTerminal = harness.stateAtTerminal.get(bookId);
      expect(atTerminal).toBeDefined();
      expect(atTerminal!.active.some((e) => e.book_id === bookId)).toBe(false);
      expect(atTerminal!.queued.some((e) => e.book_id === bookId)).toBe(false);

      const after = harness.framesAfter(terminalEvent, bookId);
      expect(after[0]!.event).toBe('merge_state');
      expect(after[1]?.event).not.toBe('merge_state');

      for (const frame of after.filter((f) => f.event === 'merge_state')) {
        const snapshot = frame.payload as MergeStateSnapshot;
        expect(snapshot.active.some((e) => e.book_id === bookId)).toBe(false);
        expect(snapshot.queued.some((e) => e.book_id === bookId)).toBe(false);
      }
    }

    it('a successful merge: state dropped, merge_complete, then one cleared snapshot', async () => {
      setupHappyPath();
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

      await harness.service.enqueueMerge(42);
      await settle();

      expect(harness.events()).toContain('merge_complete');
      expectTerminalOrder(harness, 42, 'merge_complete');
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
    });

    it('a failed merge: state dropped, merge_failed, then one cleared snapshot', async () => {
      setupHappyPath();
      (processAudioFiles as Mock).mockResolvedValue({ success: false, error: 'ffmpeg error' });
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

      await harness.service.enqueueMerge(42);
      await settle();

      expectTerminalOrder(harness, 42, 'merge_failed');
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
    });

    it('an in-flight cancel: state dropped, merge_failed(cancelled), then one cleared snapshot', async () => {
      setupBlockingMerge();
      (processAudioFiles as Mock).mockImplementation(async (_dir: string, _cfg: unknown, _ctx: unknown, _cb: unknown, signal?: AbortSignal) => {
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }));
        return { success: false, error: 'Processing aborted' };
      });
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'Dogs of War' }] });

      await harness.service.enqueueMerge(42);
      await settle();
      expect(harness.service.getMergeStateSnapshot().active).toHaveLength(1);

      expect(await harness.service.cancelMerge(42)).toEqual({ status: 'cancelled' });
      await settle();

      expectTerminalOrder(harness, 42, 'merge_failed');
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
    });

    it('a queued cancel: state dropped, merge_failed(cancelled), then one cleared snapshot', async () => {
      setupBlockingMerge();
      const harness = createSnapshotHarness({
        books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
      });

      await harness.service.enqueueMerge(42);
      await harness.service.enqueueMerge(43);

      expect(await harness.service.cancelMerge(43)).toEqual({ status: 'cancelled' });

      const failed = harness.frames.find((f) => f.event === 'merge_failed');
      expect(failed!.payload).toMatchObject({ book_id: 43, book_title: 'The Shining', reason: 'cancelled' });
      expectTerminalOrder(harness, 43, 'merge_failed');
      expect(harness.service.getMergeStateSnapshot().queued).toEqual([]);
      expect(harness.service.getMergeStateSnapshot().active.map((e) => e.book_id)).toEqual([42]);
    });

    it('reports a queued merge that fails INSIDE executeMerge exactly once (F1)', async () => {
      // The inner MergeError already emits; the dequeue wrapper must not duplicate terminal/history.
      const { release } = setupBlockingMerge();
      const harness = createSnapshotHarness({
        books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
      });

      await harness.service.enqueueMerge(42);
      await harness.service.enqueueMerge(43);

      // Pass dequeue revalidation, then fail executeMerge's live minimum check.
      let reads43 = 0;
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir.endsWith('.merge-tmp')) return ['out.m4b'];
        if (dir !== '/lib/43') return ['01.mp3', '02.mp3'];
        reads43 += 1;
        return reads43 === 1 ? ['01.mp3', '02.mp3'] : ['01.mp3'];
      });

      release();
      await settle();

      expect(harness.frames.some((f) => f.event === 'merge_started' && (f.payload as { book_id: number }).book_id === 43)).toBe(true);
      const failures = harness.frames.filter((f) => f.event === 'merge_failed' && (f.payload as { book_id: number }).book_id === 43);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ book_id: 43, book_title: 'The Shining', error: expect.stringContaining('No top-level audio files') });
      expect(harness.historyFor(43, 'merge_failed')).toHaveLength(1);

      expectTerminalOrder(harness, 43, 'merge_failed');
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
    });

    it('does not add a second, backstop-driven frame on the normal terminal path', async () => {
      setupHappyPath();
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'The Way of Kings', path: BOOK_PATH }] });

      await harness.service.enqueueMerge(42);
      await settle();

      expect(harness.framesAfter('merge_complete', 42).filter((f) => f.event === 'merge_state')).toHaveLength(1);
    });
  });

  describe('pre-flight failures inside executeMerge (#2142 — terminal-reported, not silent)', () => {
    it('reports merge_failed and clears the chip when executeMerge finds the book gone', async () => {
      setupBlockingMerge();
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'Dogs of War' }] });
      const row = await harness.bookService.getById(42);
      // Pass pre-flight, then vanish before executeMerge's live read.
      harness.bookService.getById.mockResolvedValueOnce(row).mockResolvedValue(null);

      await harness.service.enqueueMerge(42);
      await settle();

      const failures = harness.frames.filter((f) => f.event === 'merge_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ book_id: 42, book_title: 'Dogs of War', error: 'Book not found' });
      expect(harness.events()).not.toContain('merge_complete');
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
      expect(harness.snapshots()).toHaveLength(2);
      expect(harness.snapshots()[1]).toEqual({ active: [], queued: [] });
    });

    it('reports merge_failed when ffmpeg disappears between validation and execution', async () => {
      setupBlockingMerge();
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'Dogs of War' }] });
      const row = await harness.bookService.getById(42);
      // Flip ffmpeg off at executeMerge's first await, after pre-flight has passed.
      let reads = 0;
      harness.bookService.getById.mockImplementation(async () => {
        reads += 1;
        if (reads >= 2) ffmpegState.resolves = false;
        return row;
      });

      try {
        await harness.service.enqueueMerge(42);
        await settle();
      } finally {
        ffmpegState.resolves = true;
      }

      expect(harness.events()).not.toContain('merge_started');
      const failures = harness.frames.filter((f) => f.event === 'merge_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ book_id: 42, book_title: 'Dogs of War', error: 'ffmpeg is not available' });
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
      expect(harness.snapshots()).toHaveLength(2);
      expect(harness.snapshots()[1]).toEqual({ active: [], queued: [] });
    });

    it('reports merge_failed and cleans up when the book read itself REJECTS', async () => {
      // A rejected live read must remain inside catch/finally or its AbortController leaks.
      setupBlockingMerge();
      const harness = createSnapshotHarness({ books: [{ id: 42, title: 'Dogs of War' }] });
      const row = await harness.bookService.getById(42);
      harness.bookService.getById.mockResolvedValueOnce(row).mockRejectedValue(new Error('DB transport died'));

      await harness.service.enqueueMerge(42);
      await settle();

      const failures = harness.frames.filter((f) => f.event === 'merge_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]!.payload).toMatchObject({ book_id: 42, book_title: 'Dogs of War', error: 'DB transport died' });
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
      expect(await harness.service.cancelMerge(42)).toEqual({ status: 'not-found' });
    });
  });

  describe('backstop for the exits that emit no terminal event', () => {
    it('clears the chip when dequeue-time validation throws a non-MergeError', async () => {
      const { release } = setupBlockingMerge();
      const harness = createSnapshotHarness({
        books: [{ id: 42, title: 'Dogs of War' }, { id: 43, title: 'The Shining' }],
      });

      await harness.service.enqueueMerge(42);
      await harness.service.enqueueMerge(43);

      // A raw fs failure emits no terminal, so only the cleanup backstop can clear state.
      (readdir as Mock).mockImplementation(async (dir: string) => {
        if (dir === '/lib/43') throw new Error('EIO: filesystem is on fire');
        return dir.endsWith('.merge-tmp') ? ['out.m4b'] : ['01.mp3', '02.mp3'];
      });

      release();
      await settle();

      expect(harness.snapshots().some((s) => s.active.some((e) => e.book_id === 43))).toBe(true);
      expect(harness.frames.filter((f) => f.event === 'merge_failed' && (f.payload as { book_id: number }).book_id === 43)).toEqual([]);
      expect(harness.service.getMergeStateSnapshot()).toEqual({ active: [], queued: [] });
      expect(harness.snapshots().at(-1)).toEqual({ active: [], queued: [] });
    });
  });
});
