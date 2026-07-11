import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// Mock the side-effect helpers + the guarded revert so per-target cleanup (F11)
// and status coordination (F9) are directly assertable.
vi.mock('../utils/download-side-effects.js', () => ({
  emitDownloadStatusChange: vi.fn(),
  emitBookStatusChange: vi.fn(),
  recordDownloadFailedEvent: vi.fn(),
}));
vi.mock('../utils/book-status.js', () => ({
  guardedRevertBookStatus: vi.fn().mockResolvedValue({ landed: true, status: 'wanted' }),
}));

import { runReplaceWorkflow, type ReplaceCtx } from './download-replace-workflow.js';
import { DuplicateDownloadError } from './download-errors.js';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import { emitDownloadStatusChange, emitBookStatusChange, recordDownloadFailedEvent } from '../utils/download-side-effects.js';
import { guardedRevertBookStatus } from '../utils/book-status.js';
import type { Db } from '../../db/index.js';
import type { DownloadService } from './download.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { GrabParams } from './download-orchestrator.js';
import type { DownloadRow } from './types.js';

const emitDlStatus = emitDownloadStatusChange as unknown as Mock;
const emitBookStatus = emitBookStatusChange as unknown as Mock;
const recordFailed = recordDownloadFailedEvent as unknown as Mock;
const guardedRevert = guardedRevertBookStatus as unknown as Mock;

function replaceableRow(over: Partial<DownloadRow> = {}): DownloadRow {
  return {
    id: 10,
    title: 'Old Grab',
    clientStatus: 'downloading',
    pipelineStage: 'idle',
    externalId: 'ext-old',
    downloadClientId: 1,
    bookId: 5,
    bookStatusAtGrab: 'wanted',
    infoHash: 'oldhash',
    guid: 'old-guid',
    addedAt: new Date('2026-01-01'),
    ...over,
  } as DownloadRow;
}

const params: GrabParams = { downloadUrl: 'magnet:?new', title: 'The New Release', bookId: 5, replace: true };

function makeCtx(over: Partial<ReplaceCtx> = {}): { ctx: ReplaceCtx; db: ReturnType<typeof createMockDb>; grab: Mock; removeExternalItem: Mock; blacklistCreate: Mock } {
  const db = createMockDb();
  const grab = vi.fn().mockResolvedValue({ id: 42, externalId: 'ext-new' });
  const removeExternalItem = vi.fn().mockResolvedValue(undefined);
  const blacklistCreate = vi.fn().mockResolvedValue(undefined);
  const downloadService = inject<DownloadService>({ removeExternalItem });
  const ctx: ReplaceCtx = {
    db: db as unknown as Db,
    log: inject<FastifyBaseLogger>(createMockLogger()),
    downloadService,
    blacklistService: inject({ create: blacklistCreate }),
    broadcaster: inject({}),
    eventHistory: inject({}),
    grab,
    safe: (fn) => fn(),
    ...over,
  };
  return { ctx, db, grab, removeExternalItem, blacklistCreate };
}

/** Queue N gatherBookBlockers results onto db.select (each gather = a rows select
 *  then a pending-auto-jobs select). Also queue the claim tx recheck's gather. */
function queueGathers(db: ReturnType<typeof createMockDb>, ...gathers: Array<{ rows?: DownloadRow[]; jobs?: Array<{ id: number }> }>) {
  for (const g of gathers) {
    db.select.mockReturnValueOnce(mockDbChain(g.rows ?? [])).mockReturnValueOnce(mockDbChain(g.jobs ?? []));
  }
}

describe('runReplaceWorkflow (#1857)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    guardedRevert.mockResolvedValue({ landed: true, status: 'wanted' });
  });

  it('PIPELINE_ACTIVE: a pipeline blocker throws and cancels nothing (no grab, no removal)', async () => {
    const { ctx, db, grab, removeExternalItem } = makeCtx();
    queueGathers(db, { rows: [replaceableRow({ clientStatus: 'completed', pipelineStage: 'importing' })] });

    await expect(runReplaceWorkflow(ctx, params)).rejects.toMatchObject({ code: 'PIPELINE_ACTIVE' });
    expect(grab).not.toHaveBeenCalled();
    expect(removeExternalItem).not.toHaveBeenCalled();
  });

  it('clear (nothing to replace): proceeds as an ordinary grab', async () => {
    const { ctx, db, grab } = makeCtx();
    queueGathers(db, {});
    const id = await runReplaceWorkflow(ctx, params);
    expect(id).toBe(42);
    expect(grab).toHaveBeenCalledWith(params, { classificationMode: 'gatherAllBlockers' });
  });

  it('replaceable: claims, cleans up the old row, then grabs the replacement inheriting the snapshot', async () => {
    const { ctx, db, grab, removeExternalItem } = makeCtx();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    queueGathers(db, { rows: [replaceableRow()] }, {}, {}); // gather, in-tx recheck, late-blocker

    const id = await runReplaceWorkflow(ctx, params);

    expect(id).toBe(42);
    expect(removeExternalItem).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }));
    expect(grab).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicateCheck: true, title: 'The New Release' }),
      { bookStatusAtGrabOverride: 'wanted', bestEffortBookStatus: true },
    );
  });

  // ── F11 — per-target cleanup side effects ────────────────────────────────
  describe('per-target cleanup side effects (F11)', () => {
    it('blacklists, emits download-status SSE, and records failed history with the exact replace reason for EVERY target', async () => {
      const targets = [
        replaceableRow({ id: 10, title: 'Old A' }),
        replaceableRow({ id: 11, title: 'Old B', clientStatus: 'queued' }),
      ];
      const { ctx, db, blacklistCreate } = makeCtx();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGathers(db, { rows: targets }, {}, {});

      await runReplaceWorkflow(ctx, params);

      // Every target permanently blacklisted.
      expect(blacklistCreate).toHaveBeenCalledTimes(2);
      expect(blacklistCreate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancelled', blacklistType: 'permanent' }));
      // download-status SSE per target → failed.
      expect(emitDlStatus).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 10, newStatus: 'failed' }));
      expect(emitDlStatus).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 11, newStatus: 'failed' }));
      // failed history with the exact replacement reason naming the new release.
      expect(recordFailed).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 10, errorMessage: 'Replaced by "The New Release"' }));
      expect(recordFailed).toHaveBeenCalledWith(expect.objectContaining({ downloadId: 11, errorMessage: 'Replaced by "The New Release"' }));
    });

    it('is best-effort: a blacklist failure for one target does not abort the grab', async () => {
      const { ctx, db, grab, blacklistCreate } = makeCtx();
      blacklistCreate.mockRejectedValue(new Error('blacklist db down'));
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGathers(db, { rows: [replaceableRow()] }, {}, {});

      const id = await runReplaceWorkflow(ctx, params);
      expect(id).toBe(42);
      expect(grab).toHaveBeenCalled();
    });
  });

  // ── F7 — deterministic inherited snapshot ────────────────────────────────
  describe('deterministic inherited snapshot (F7/F16)', () => {
    async function snapshotFor(rows: DownloadRow[]): Promise<unknown> {
      const { ctx, db, grab } = makeCtx();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGathers(db, { rows }, {}, {});
      await runReplaceWorkflow(ctx, params);
      return grab.mock.calls.at(-1)![1].bookStatusAtGrabOverride;
    }

    it('inherits a single wanted snapshot', async () => {
      expect(await snapshotFor([replaceableRow({ bookStatusAtGrab: 'wanted' })])).toBe('wanted');
    });

    it('inherits a single imported snapshot', async () => {
      expect(await snapshotFor([replaceableRow({ bookStatusAtGrab: 'imported' })])).toBe('imported');
    });

    it('passes null when ALL targets have a null snapshot (fallback resolved downstream)', async () => {
      expect(await snapshotFor([replaceableRow({ bookStatusAtGrab: null }), replaceableRow({ id: 11, bookStatusAtGrab: null })])).toBeNull();
    });

    it('picks the FIRST NON-NULL over the gathered (addedAt DESC, id DESC) cohort, skipping a leading null', async () => {
      // gather returns most-recent first; the most-recent has a null snapshot.
      const rows = [
        replaceableRow({ id: 20, bookStatusAtGrab: null, addedAt: new Date('2026-03-01') }),
        replaceableRow({ id: 10, bookStatusAtGrab: 'missing', addedAt: new Date('2026-01-01') }),
      ];
      expect(await snapshotFor(rows)).toBe('missing');
    });

    it('is invariant to cleanup order — same snapshot regardless of which row is removed first', async () => {
      const rows = [
        replaceableRow({ id: 20, bookStatusAtGrab: 'imported' }),
        replaceableRow({ id: 10, bookStatusAtGrab: 'wanted' }),
      ];
      const { ctx, db, grab, removeExternalItem } = makeCtx();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGathers(db, { rows }, {}, {});
      await runReplaceWorkflow(ctx, params);
      // Snapshot is chosen from the in-memory cohort BEFORE cleanup, so removal order is irrelevant.
      expect(grab.mock.calls.at(-1)![1].bookStatusAtGrabOverride).toBe('imported');
      expect(removeExternalItem).toHaveBeenCalledTimes(2);
    });
  });

  // ── F9 — synchronous status ownership + guarded revert ───────────────────
  describe('guarded book-status revert (F9)', () => {
    function setupLateBlocker(landed: boolean) {
      const ctx = makeCtx();
      ctx.db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      // gather (replaceable), recheck (clear), late-blocker (an auto job appeared)
      queueGathers(ctx.db, { rows: [replaceableRow()] }, {}, { jobs: [{ id: 99 }] });
      guardedRevert.mockResolvedValue({ landed, status: 'wanted' });
      return ctx;
    }

    it('late blocker → guarded revert to the snapshot on downloading; lands → emits book_status_change', async () => {
      const { ctx, grab } = setupLateBlocker(true);
      await expect(runReplaceWorkflow(ctx, params)).rejects.toBeInstanceOf(DuplicateDownloadError);
      expect(guardedRevert).toHaveBeenCalledWith(ctx.db, { id: 5 }, 'wanted', 'downloading');
      expect(emitBookStatus).toHaveBeenCalledWith(expect.objectContaining({ bookId: 5, newStatus: 'wanted' }));
      expect(grab).not.toHaveBeenCalled();
    });

    it('late blocker → guard MISS (book moved to importing) suppresses the SSE, preserving importing', async () => {
      const { ctx } = setupLateBlocker(false);
      await expect(runReplaceWorkflow(ctx, params)).rejects.toBeInstanceOf(DuplicateDownloadError);
      expect(guardedRevert).toHaveBeenCalled();
      expect(emitBookStatus).not.toHaveBeenCalled(); // landed=false → no SSE (F29/F61)
    });

    it('failed replacement grab → reverts from the same in-memory snapshot', async () => {
      const { ctx, db, grab } = makeCtx();
      db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
      queueGathers(db, { rows: [replaceableRow({ bookStatusAtGrab: 'missing' })] }, {}, {}); // no late blocker
      grab.mockRejectedValueOnce(new Error('client offline'));

      await expect(runReplaceWorkflow(ctx, params)).rejects.toThrow('client offline');
      expect(guardedRevert).toHaveBeenCalledWith(ctx.db, { id: 5 }, 'missing', 'downloading');
    });
  });

  // ── F8 — claim-miss disposition table ────────────────────────────────────
  describe('claim-miss dispositions (F8)', () => {
    it('post-miss pipeline blocker → PIPELINE_ACTIVE with ZERO external calls', async () => {
      const { ctx, db, grab, removeExternalItem, blacklistCreate } = makeCtx();
      db.update.mockReturnValue(mockDbChain([])); // claim guard-misses → ClaimMissError
      queueGathers(db,
        { rows: [replaceableRow()] },                                          // initial gather → replaceable
        { rows: [replaceableRow({ clientStatus: 'completed', pipelineStage: 'importing' })] }, // re-gather → pipeline
      );

      await expect(runReplaceWorkflow(ctx, params)).rejects.toMatchObject({ code: 'PIPELINE_ACTIVE' });
      expect(grab).not.toHaveBeenCalled();
      expect(removeExternalItem).not.toHaveBeenCalled();
      expect(blacklistCreate).not.toHaveBeenCalled();
    });

    it('post-miss no-blocker/no-active → proceeds as an ordinary grab', async () => {
      const { ctx, db, grab } = makeCtx();
      db.update.mockReturnValue(mockDbChain([])); // claim miss
      queueGathers(db, { rows: [replaceableRow()] }, {}); // initial replaceable, re-gather clear

      const id = await runReplaceWorkflow(ctx, params);
      expect(id).toBe(42);
      expect(grab).toHaveBeenCalledWith(params, { classificationMode: 'gatherAllBlockers' });
    });

    it('post-miss still-replaceable → bounded single retry, then ACTIVE_DOWNLOAD_EXISTS on a second miss', async () => {
      const { ctx, db, grab } = makeCtx();
      db.update.mockReturnValue(mockDbChain([])); // every claim misses
      queueGathers(db,
        { rows: [replaceableRow()] }, // initial gather → replaceable (attempt 0 claim miss)
        { rows: [replaceableRow()] }, // handleClaimMiss re-gather → still replaceable → retry (attempt 1)
        { rows: [replaceableRow()] }, // attempt-1 gather → replaceable (claim miss again)
        { rows: [replaceableRow()] }, // handleClaimMiss re-gather → still replaceable, attempt≥1 → surface
      );

      await expect(runReplaceWorkflow(ctx, params)).rejects.toMatchObject({ code: 'ACTIVE_DOWNLOAD_EXISTS' });
      expect(grab).not.toHaveBeenCalled();
    });

    it('DB/transaction error (non-ClaimMiss) propagates as a grab failure', async () => {
      const { ctx, db } = makeCtx();
      db.transaction.mockRejectedValue(new Error('database is locked'));
      queueGathers(db, { rows: [replaceableRow()] });

      await expect(runReplaceWorkflow(ctx, params)).rejects.toThrow('database is locked');
    });
  });
});
