import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { runReplaceWorkflow, type ReplaceCtx } from './download-replace-workflow.js';
import { DuplicateDownloadError } from './download-errors.js';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { DownloadService } from './download.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { GrabParams } from './download-orchestrator.js';
import type { DownloadRow } from './types.js';

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

function makeCtx(over: Partial<ReplaceCtx> = {}): { ctx: ReplaceCtx; db: ReturnType<typeof createMockDb>; grab: Mock; removeExternalItem: Mock } {
  const db = createMockDb();
  const grab = vi.fn().mockResolvedValue({ id: 42, externalId: 'ext-new' });
  const removeExternalItem = vi.fn().mockResolvedValue(undefined);
  const downloadService = inject<DownloadService>({ removeExternalItem });
  const ctx: ReplaceCtx = {
    db: db as unknown as Db,
    log: inject<FastifyBaseLogger>(createMockLogger()),
    downloadService,
    blacklistService: inject({ create: vi.fn().mockResolvedValue(undefined) }),
    grab,
    safe: (fn) => fn(),
    ...over,
  };
  return { ctx, db, grab, removeExternalItem };
}

describe('runReplaceWorkflow (#1857)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('PIPELINE_ACTIVE: a pipeline blocker throws and cancels nothing (no grab, no removal)', async () => {
    const { ctx, db, grab, removeExternalItem } = makeCtx();
    // gather: one importing (pipeline blocker) row + no jobs.
    db.select
      .mockReturnValueOnce(mockDbChain([replaceableRow({ clientStatus: 'completed', pipelineStage: 'importing' })]))
      .mockReturnValueOnce(mockDbChain([]));

    await expect(runReplaceWorkflow(ctx, params)).rejects.toMatchObject({ code: 'PIPELINE_ACTIVE' });
    expect(grab).not.toHaveBeenCalled();
    expect(removeExternalItem).not.toHaveBeenCalled();
  });

  it('clear (nothing to replace): proceeds as an ordinary grab', async () => {
    const { ctx, db, grab } = makeCtx();
    db.select.mockReturnValueOnce(mockDbChain([])).mockReturnValueOnce(mockDbChain([]));

    const id = await runReplaceWorkflow(ctx, params);

    expect(id).toBe(42);
    expect(grab).toHaveBeenCalledWith(params, { classificationMode: 'gatherAllBlockers' });
  });

  it('replaceable: claims, cleans up the old row, then grabs the replacement inheriting the snapshot', async () => {
    const { ctx, db, grab, removeExternalItem } = makeCtx();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }])); // claim lands
    db.select
      .mockReturnValueOnce(mockDbChain([replaceableRow()]))  // gather rows
      .mockReturnValueOnce(mockDbChain([]))                  // gather jobs
      .mockReturnValueOnce(mockDbChain([]))                  // in-tx recheck rows
      .mockReturnValueOnce(mockDbChain([]))                  // in-tx recheck jobs
      .mockReturnValueOnce(mockDbChain([]))                  // late-blocker rows
      .mockReturnValueOnce(mockDbChain([]));                 // late-blocker jobs

    const id = await runReplaceWorkflow(ctx, params);

    expect(id).toBe(42);
    // Old external item removed as part of post-commit cleanup.
    expect(removeExternalItem).toHaveBeenCalledWith(expect.objectContaining({ id: 10 }));
    // Replacement grabbed with skipDuplicateCheck + inherited snapshot + best-effort book-status.
    expect(grab).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicateCheck: true, title: 'The New Release' }),
      { bookStatusAtGrabOverride: 'wanted', bestEffortBookStatus: true },
    );
  });

  it('late blocker after claim commit: cancels the old row but returns PIPELINE_ACTIVE (no grab)', async () => {
    const { ctx, db, grab, removeExternalItem } = makeCtx();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }]));
    db.select
      .mockReturnValueOnce(mockDbChain([replaceableRow()]))  // gather rows
      .mockReturnValueOnce(mockDbChain([]))                  // gather jobs
      .mockReturnValueOnce(mockDbChain([]))                  // recheck rows
      .mockReturnValueOnce(mockDbChain([]))                  // recheck jobs
      .mockReturnValueOnce(mockDbChain([]))                  // late rows
      .mockReturnValueOnce(mockDbChain([{ id: 1 }]));        // late: a pending auto job appeared

    await expect(runReplaceWorkflow(ctx, params)).rejects.toBeInstanceOf(DuplicateDownloadError);
    // Old row WAS cleaned up (claim already committed), but the replacement is NOT grabbed.
    expect(removeExternalItem).toHaveBeenCalled();
    expect(grab).not.toHaveBeenCalled();
  });
});
