import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir, rm, realpath, symlink } from 'node:fs/promises';
import { createMockLogger, createMockDb, mockDbChain, inject } from '../__tests__/helpers.js';
import type { Db } from '@db/index.js';
import type { FastifyBaseLogger } from 'fastify';
import type { EventSource } from '@shared/schemas/event-history.js';
import { MergeError } from './merge.service.js';
import {
  settleInterruptedMerges,
  requeueRecoveredMerges,
  classifyStagingDir,
  type MergeRecoveryPlan,
  type SettleInterruptedMergesDeps,
} from './merge-boot-recovery.js';

/**
 * #2099 — boot settlement for merges interrupted by a process death.
 *
 * The filesystem is REAL (tmpdir): classification, the symlink-aware containment guard and the
 * recursive cleanup are the behaviors under test, and a mocked fs proves none of them. Only
 * `readdir` / `rm` / `realpath` are wrapped in spies over their real implementations, so the
 * transient-failure rows of D6's taxonomy (EACCES on any of the three) can be injected without
 * giving up real on-disk behavior everywhere else.
 *
 * The detection QUERY is out of scope here — a mocked drizzle chain cannot validate the
 * `MAX(id)`-per-book grouping. It is covered against real SQLite in
 * `merge-boot-recovery.integration.test.ts`; this suite stubs the query's result and exercises
 * everything downstream of it.
 */
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readdir: vi.fn(),
    rm: vi.fn(),
    realpath: vi.fn(),
  };
});

/** Windows raises EPERM on `symlink()` without Developer Mode — probe, don't assume (see the windows-hostile-test-primitives learning). */
const CAN_SYMLINK = await (async () => {
  const probe = await actualFs.mkdtemp(join(tmpdir(), 'merge-recovery-symlink-probe-'));
  try {
    const target = join(probe, 'target');
    await actualFs.writeFile(target, '');
    await actualFs.symlink(target, join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    await actualFs.rm(probe, { recursive: true, force: true });
  }
})();

interface CandidateRow {
  bookId: number;
  eventId: number;
  source: EventSource;
  bookTitle: string;
}

describe('#2099 merge boot recovery — settlement phase', () => {
  let libraryRoot: string;
  let db: ReturnType<typeof createMockDb>;
  let log: Record<string, Mock | string>;
  let eventHistory: { create: Mock };
  let bookService: { getById: Mock };
  let settingsService: { get: Mock };

  beforeEach(() => {
    vi.clearAllMocks();
    // Real fs behavior by default; individual tests inject a rejection with mockImplementationOnce.
    (readdir as Mock).mockImplementation(actualFs.readdir as never);
    (rm as Mock).mockImplementation(actualFs.rm as never);
    (realpath as Mock).mockImplementation(actualFs.realpath as never);

    libraryRoot = mkdtempSync(join(tmpdir(), 'narratorr-2099-merge-recovery-'));
    db = createMockDb();
    log = createMockLogger();
    eventHistory = { create: vi.fn().mockResolvedValue(undefined) };
    bookService = { getById: vi.fn() };
    settingsService = { get: vi.fn().mockResolvedValue({ path: libraryRoot }) };
  });

  afterEach(async () => {
    try {
      await actualFs.rm(libraryRoot, { recursive: true, force: true });
    } catch {
      // Windows can keep handles open — a leaked tmpdir is cheaper than a red suite.
    }
  });

  function deps(): SettleInterruptedMergesDeps {
    return {
      db: inject<Db>(db),
      log: inject<FastifyBaseLogger>(log),
      eventHistory: eventHistory as never,
      bookService: bookService as never,
      settingsService: settingsService as never,
    };
  }

  /** Stub the detection query's result — the query itself is covered by the integration suite. */
  function setCandidates(rows: CandidateRow[]): void {
    db.select.mockReturnValue(mockDbChain(rows));
  }

  /** Seed `<libraryRoot>/Author/<title>` with two originals; returns its path. */
  async function seedBook(title: string, id = 42, source: EventSource = 'auto'): Promise<string> {
    const bookPath = join(libraryRoot, 'Author', title);
    await actualFs.mkdir(bookPath, { recursive: true });
    await actualFs.writeFile(join(bookPath, '01.mp3'), 'a');
    await actualFs.writeFile(join(bookPath, '02.mp3'), 'b');
    bookService.getById.mockResolvedValue({ id, title, path: bookPath, status: 'imported' });
    setCandidates([{ bookId: id, eventId: 900 + id, source, bookTitle: title }]);
    return bookPath;
  }

  /** Create the derived staging sibling `<parent>/.<base>.merge-tmp` with the given entries. */
  async function seedStaging(bookPath: string, entries: string[]): Promise<string> {
    const stagingDir = join(libraryRoot, 'Author', `.${bookPath.split(/[/\\]/).pop()}.merge-tmp`);
    await actualFs.mkdir(stagingDir, { recursive: true });
    for (const entry of entries) await actualFs.writeFile(join(stagingDir, entry), 'x');
    return stagingDir;
  }

  const exists = (p: string): Promise<boolean> => actualFs.stat(p).then(() => true, () => false);

  const settlementFor = (bookId: number, source: EventSource) => expect.objectContaining({
    bookId,
    eventType: 'merge_failed',
    source,
    reason: { error: 'Interrupted by server restart', type: 'ProcessRestart' },
  });

  describe('classifyStagingDir', () => {
    it('classifies an absent path as no-staging, audio as pre-commit, and residue as ambiguous', async () => {
      const base = join(libraryRoot, 'Author');
      await actualFs.mkdir(base, { recursive: true });
      expect(await classifyStagingDir(join(base, 'nope'))).toBe('no-staging');

      const withAudio = join(base, 'audio');
      await actualFs.mkdir(withAudio);
      await actualFs.writeFile(join(withAudio, 'out.m4b'), 'x');
      expect(await classifyStagingDir(withAudio)).toBe('pre-commit');

      const empty = join(base, 'empty');
      await actualFs.mkdir(empty);
      expect(await classifyStagingDir(empty)).toBe('ambiguous');

      const residue = join(base, 'residue');
      await actualFs.mkdir(residue);
      await actualFs.writeFile(join(residue, 'notes.txt'), 'x');
      expect(await classifyStagingDir(residue)).toBe('ambiguous');
    });

    it('counts a dot-led half-written encode temp as audio (no isHiddenName filter)', async () => {
      const dir = join(libraryRoot, 'temp-encode');
      await actualFs.mkdir(dir, { recursive: true });
      await actualFs.writeFile(join(dir, '.The Book.tmp.m4b'), 'x');
      expect(await classifyStagingDir(dir)).toBe('pre-commit');
    });
  });

  it('pre-commit + auto: cleans the staging dir, settles, and lists the book for re-queue', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');
    const stagingDir = await seedStaging(bookPath, ['out.m4b']);

    const plan = await settleInterruptedMerges(deps());

    expect(await exists(stagingDir)).toBe(false);
    expect(eventHistory.create).toHaveBeenCalledTimes(1);
    expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
    expect(plan.requeue).toEqual([628]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    // AC4 — recovery never touches the sources.
    expect((await actualFs.readdir(bookPath)).sort()).toEqual(['01.mp3', '02.mp3']);
  });

  it('pre-commit + manual: settles and cleans but waits for the operator', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'manual');
    const stagingDir = await seedStaging(bookPath, ['out.m4b']);

    const plan = await settleInterruptedMerges(deps());

    expect(await exists(stagingDir)).toBe(false);
    expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'manual'));
    expect(plan.requeue).toEqual([]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    expect((await actualFs.readdir(bookPath)).sort()).toEqual(['01.mp3', '02.mp3']);
  });

  it('ambiguous (empty staging dir): removed and settled, never re-queued, warn names book.path', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');
    const stagingDir = await seedStaging(bookPath, []);

    const plan = await settleInterruptedMerges(deps());

    expect(await exists(stagingDir)).toBe(false);
    expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
    expect(plan.requeue).toEqual([]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ bookId: 628, bookPath }), expect.any(String));
    expect((await actualFs.readdir(bookPath)).sort()).toEqual(['01.mp3', '02.mp3']);
  });

  it('ambiguous (non-audio residue only): same outcome — residue is NOT pre-commit', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');
    const stagingDir = await seedStaging(bookPath, ['notes.txt']);

    const plan = await settleInterruptedMerges(deps());

    expect(await exists(stagingDir)).toBe(false);
    expect(plan.requeue).toEqual([]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ bookId: 628, bookPath }), expect.any(String));
  });

  it('no-staging: settles with no filesystem write and no re-queue', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');

    const plan = await settleInterruptedMerges(deps());

    expect(rm).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
    expect(plan.requeue).toEqual([]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
    expect((await actualFs.readdir(bookPath)).sort()).toEqual(['01.mp3', '02.mp3']);
  });

  it.each([
    ['the book row is gone', null],
    ['the book has no path', { id: 628, title: 'Stormrage', path: null }],
  ])('settles permanently without deriving a staging path when %s', async (_label, row) => {
    setCandidates([{ bookId: 628, eventId: 1, source: 'auto', bookTitle: 'Stormrage' }]);
    bookService.getById.mockResolvedValue(row);

    const plan = await settleInterruptedMerges(deps());

    expect(readdir).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
    expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
    expect(plan.requeue).toEqual([]);
    expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
  });

  it('order (D4): the staging rm completes before the settlement insert, which precedes the re-queue', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');
    await seedStaging(bookPath, ['out.m4b']);

    const order: string[] = [];
    (rm as Mock).mockImplementation(async (...args: Parameters<typeof actualFs.rm>) => {
      await (actualFs.rm as never as (...a: unknown[]) => Promise<void>)(...args);
      order.push('rm');
    });
    eventHistory.create.mockImplementation(async () => { order.push('create'); });
    const merge = { enqueueMerge: vi.fn(async () => { order.push('enqueue'); return { status: 'started' as const, bookId: 628 }; }) };

    const plan = await settleInterruptedMerges(deps());
    await requeueRecoveredMerges(merge as never, plan, inject<FastifyBaseLogger>(log));

    expect(order).toEqual(['rm', 'create', 'enqueue']);
  });

  describe('transient failures leave the candidate untouched for the next boot', () => {
    it('a non-ENOENT readdir failure skips the candidate, and the next pass settles it', async () => {
      const bookPath = await seedBook('Stormrage', 628, 'auto');
      const stagingDir = await seedStaging(bookPath, ['out.m4b']);
      (readdir as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })));

      const first = await settleInterruptedMerges(deps());

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(await exists(stagingDir)).toBe(true);
      expect(first.counters).toEqual({ candidates: 1, cleaned: 0, settled: 0, retryable: 1, failed: 0 });
      expect(log.warn).toHaveBeenCalled();

      // Second boot, transient condition cleared.
      const second = await settleInterruptedMerges(deps());
      expect(await exists(stagingDir)).toBe(false);
      expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
      expect(second.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
      expect(second.requeue).toEqual([628]);
    });

    it('a bookService.getById rejection has the identical shape', async () => {
      const bookPath = await seedBook('Stormrage', 628, 'auto');
      const stagingDir = await seedStaging(bookPath, ['out.m4b']);
      bookService.getById.mockRejectedValueOnce(new Error('DB read failed'));

      const first = await settleInterruptedMerges(deps());

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(await exists(stagingDir)).toBe(true);
      expect(first.counters.retryable).toBe(1);
      expect(first.counters.settled).toBe(0);

      const second = await settleInterruptedMerges(deps());
      expect(second.counters.settled).toBe(1);
      expect(second.requeue).toEqual([628]);
    });

    it('an rm failure leaves the staging dir AND the dangling event, and the next pass settles it', async () => {
      const bookPath = await seedBook('Stormrage', 628, 'auto');
      const stagingDir = await seedStaging(bookPath, ['out.m4b']);
      (rm as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })));

      const first = await settleInterruptedMerges(deps());

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(await exists(stagingDir)).toBe(true);
      expect(first.counters).toEqual({ candidates: 1, cleaned: 0, settled: 0, retryable: 1, failed: 0 });

      const second = await settleInterruptedMerges(deps());
      expect(await exists(stagingDir)).toBe(false);
      expect(second.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    });

    it('a non-ENOENT realpath failure from the containment guard is transient too', async () => {
      const bookPath = await seedBook('Stormrage', 628, 'auto');
      const stagingDir = await seedStaging(bookPath, ['out.m4b']);
      (realpath as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })));

      const plan = await settleInterruptedMerges(deps());

      expect(rm).not.toHaveBeenCalled();
      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(await exists(stagingDir)).toBe(true);
      expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 0, retryable: 1, failed: 0 });
    });

    it('a realpath ENOENT is swallowed by the guard — the force:true rm is a harmless no-op and the candidate settles', async () => {
      const bookPath = await seedBook('Stormrage', 628, 'auto');
      await seedStaging(bookPath, ['out.m4b']);
      (realpath as Mock).mockImplementationOnce(() => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));

      const plan = await settleInterruptedMerges(deps());

      expect(rm).toHaveBeenCalled();
      expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
      expect(plan.counters).toEqual({ candidates: 1, cleaned: 1, settled: 1, retryable: 0, failed: 0 });
    });
  });

  describe('containment', () => {
    it('a lexically-escaping staging path is settled but never cleaned', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'narratorr-2099-outside-'));
      try {
        const bookPath = join(outside, 'Author', 'Stormrage');
        await actualFs.mkdir(bookPath, { recursive: true });
        const stagingDir = join(outside, 'Author', '.Stormrage.merge-tmp');
        await actualFs.mkdir(stagingDir, { recursive: true });
        await actualFs.writeFile(join(stagingDir, 'out.m4b'), 'x');
        bookService.getById.mockResolvedValue({ id: 628, title: 'Stormrage', path: bookPath });
        setCandidates([{ bookId: 628, eventId: 7, source: 'auto', bookTitle: 'Stormrage' }]);

        const plan = await settleInterruptedMerges(deps());

        expect(rm).not.toHaveBeenCalled();
        expect(await exists(stagingDir)).toBe(true);
        expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
        expect(plan.requeue).toEqual([]);
        expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
        expect(log.warn).toHaveBeenCalledTimes(1);
      } finally {
        await actualFs.rm(outside, { recursive: true, force: true });
      }
    });

    // A PARENT-directory symlink is the case the lexical guard cannot see: `<root>/Author` is
    // lexically inside the root, so only the realpath-canonicalized re-check catches that the
    // recursive delete would land outside the library. The fixture must make the DERIVED
    // staging path itself resolvable outside the root, or the guard is never reached — creating
    // only `<external>` would ENOENT the classification into `no-staging`, and even reaching the
    // guard, its non-strict variant swallows a realpath ENOENT.
    it.skipIf(!CAN_SYMLINK)('a parent-directory symlink escape is caught by the realpath re-check', async () => {
      const external = mkdtempSync(join(tmpdir(), 'narratorr-2099-external-'));
      try {
        const externalStaging = join(external, '.Stormrage.merge-tmp');
        await actualFs.mkdir(externalStaging, { recursive: true });
        await actualFs.writeFile(join(externalStaging, 'out.m4b'), 'sentinel');
        await symlink(external, join(libraryRoot, 'Author'), 'dir');

        const bookPath = join(libraryRoot, 'Author', 'Stormrage');
        bookService.getById.mockResolvedValue({ id: 628, title: 'Stormrage', path: bookPath });
        setCandidates([{ bookId: 628, eventId: 7, source: 'auto', bookTitle: 'Stormrage' }]);

        // The derived path resolves THROUGH the symlink, so classification sees the audio —
        // this is the branch that would otherwise clean *and* re-queue, the most dangerous one.
        expect(await classifyStagingDir(join(libraryRoot, 'Author', '.Stormrage.merge-tmp'))).toBe('pre-commit');

        const plan = await settleInterruptedMerges(deps());

        expect(rm).not.toHaveBeenCalled();
        expect(await exists(externalStaging)).toBe(true);
        expect(await exists(join(externalStaging, 'out.m4b'))).toBe(true);
        expect(eventHistory.create).toHaveBeenCalledWith(settlementFor(628, 'auto'));
        expect(plan.requeue).toEqual([]);
        expect(plan.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
        expect(log.warn).toHaveBeenCalledTimes(1);
      } finally {
        await actualFs.rm(external, { recursive: true, force: true });
      }
    });
  });

  describe('pass-level skip when no library root resolves', () => {
    it('an empty library path skips the whole pass with one warn and zero filesystem calls', async () => {
      await seedBook('Stormrage', 628, 'auto');
      settingsService.get.mockResolvedValue({ path: '' });

      const plan = await settleInterruptedMerges(deps());

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(plan).toEqual({ requeue: [], counters: { candidates: 0, cleaned: 0, settled: 0, retryable: 0, failed: 0 } });
      // Same single record as the rejecting-read branch, but with no cause to attach.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith({}, expect.any(String));
    });

    it('a rejecting settings read skips the pass with ONE warn carrying the cause', async () => {
      await seedBook('Stormrage', 628, 'auto');
      settingsService.get.mockRejectedValue(new Error('settings unavailable'));

      const plan = await settleInterruptedMerges(deps());

      expect(eventHistory.create).not.toHaveBeenCalled();
      expect(readdir).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
      expect(plan.counters).toEqual({ candidates: 0, cleaned: 0, settled: 0, retryable: 0, failed: 0 });
      // D6 gives the pass-level skip a SINGLE record — a throwing read must not warn twice.
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(
        { error: expect.objectContaining({ message: 'settings unavailable' }) },
        expect.any(String),
      );
    });
  });

  it('per-candidate isolation: a rejected settlement for one candidate still settles the next', async () => {
    const first = join(libraryRoot, 'Author', 'One');
    const second = join(libraryRoot, 'Author', 'Two');
    await actualFs.mkdir(first, { recursive: true });
    await actualFs.mkdir(second, { recursive: true });
    setCandidates([
      { bookId: 1, eventId: 10, source: 'auto', bookTitle: 'One' },
      { bookId: 2, eventId: 11, source: 'auto', bookTitle: 'Two' },
    ]);
    bookService.getById.mockImplementation(async (id: number) =>
      id === 1 ? { id: 1, title: 'One', path: first } : { id: 2, title: 'Two', path: second });
    eventHistory.create.mockImplementation(async (input: { bookId: number }) => {
      if (input.bookId === 1) throw new Error('DB write failed');
    });

    const plan = await settleInterruptedMerges(deps());

    expect(eventHistory.create).toHaveBeenCalledTimes(2);
    expect(plan.counters).toEqual({ candidates: 2, cleaned: 0, settled: 1, retryable: 0, failed: 1 });
  });

  it('a settlement rejection after a successful clean counts as failed, and the next pass settles via no-staging', async () => {
    const bookPath = await seedBook('Stormrage', 628, 'auto');
    const stagingDir = await seedStaging(bookPath, ['out.m4b']);
    eventHistory.create.mockRejectedValueOnce(new Error('DB write failed'));

    const first = await settleInterruptedMerges(deps());

    // The clean landed; only the insert failed. `cleaned` is a STEP counter, so the removal the
    // operator can see on disk stays reported even though the candidate's outcome is `failed`.
    expect(await exists(stagingDir)).toBe(false);
    expect(first.counters).toEqual({ candidates: 1, cleaned: 1, settled: 0, retryable: 0, failed: 1 });
    expect(first.requeue).toEqual([]);

    const second = await settleInterruptedMerges(deps());

    expect(second.counters).toEqual({ candidates: 1, cleaned: 0, settled: 1, retryable: 0, failed: 0 });
    expect(second.requeue).toEqual([]); // no-staging forfeits the re-queue, by design
  });
});

describe('#2099 merge boot recovery — re-queue phase', () => {
  let log: Record<string, Mock | string>;

  beforeEach(() => {
    vi.clearAllMocks();
    log = createMockLogger();
  });

  const planWith = (requeue: number[], counters: Partial<MergeRecoveryPlan['counters']> = {}): MergeRecoveryPlan => ({
    requeue,
    counters: { candidates: requeue.length, cleaned: 0, settled: 0, retryable: 0, failed: 0, ...counters },
  });

  it('swallows a MergeError at info and keeps enqueueing the rest', async () => {
    const merge = {
      enqueueMerge: vi.fn()
        .mockRejectedValueOnce(new MergeError('No top-level audio files to merge (requires ≥2)', 'NO_TOP_LEVEL_FILES'))
        .mockResolvedValueOnce({ status: 'started', bookId: 2 }),
    };

    await requeueRecoveredMerges(merge as never, planWith([1, 2]), inject<FastifyBaseLogger>(log));

    expect(merge.enqueueMerge).toHaveBeenNthCalledWith(1, 1, 'auto');
    expect(merge.enqueueMerge).toHaveBeenNthCalledWith(2, 2, 'auto');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1, code: 'NO_TOP_LEVEL_FILES' }), expect.any(String));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns on a non-MergeError, folds it into failed, and still enqueues the next book', async () => {
    const merge = {
      enqueueMerge: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ status: 'started', bookId: 2 }),
    };

    await requeueRecoveredMerges(merge as never, planWith([1, 2]), inject<FastifyBaseLogger>(log));

    expect(merge.enqueueMerge).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ bookId: 1 }), expect.any(String));
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ failed: 1, requeued: 1 }), 'Merge boot recovery complete');
  });

  it('logs exactly one summary line carrying the full six-key object', async () => {
    const merge = {
      enqueueMerge: vi.fn()
        .mockResolvedValueOnce({ status: 'started', bookId: 1 })
        .mockRejectedValueOnce(new MergeError('Merge already queued for this book', 'ALREADY_QUEUED'))
        .mockRejectedValueOnce(new Error('boom')),
    };
    const plan = planWith([1, 2, 3], { candidates: 5, cleaned: 3, settled: 4, retryable: 1, failed: 2 });

    await requeueRecoveredMerges(merge as never, plan, inject<FastifyBaseLogger>(log));

    expect(log.info).toHaveBeenCalledTimes(2); // one summary + the swallowed MergeError record
    const summaryCalls = (log.info as Mock).mock.calls.filter((c) => c[1] === 'Merge boot recovery complete');
    expect(summaryCalls).toHaveLength(1);
    // requeued counts ONLY the success; failed = settlement failures + the raw-Error rejection;
    // the MergeError increments nothing.
    expect(summaryCalls[0]![0]).toEqual({ candidates: 5, cleaned: 3, settled: 4, requeued: 1, retryable: 1, failed: 3 });
  });

  it('a zero-candidate plan logs the same single line at debug, never at info', async () => {
    const merge = { enqueueMerge: vi.fn() };

    await requeueRecoveredMerges(merge as never, planWith([], { candidates: 0 }), inject<FastifyBaseLogger>(log));

    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    expect(log.debug).toHaveBeenCalledWith(
      { candidates: 0, cleaned: 0, settled: 0, requeued: 0, retryable: 0, failed: 0 },
      'Merge boot recovery complete',
    );
  });
});
