import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

// STATEFUL guarded-revert integration (#1857 F22): unlike download-replace-workflow.test.ts,
// this suite does NOT mock ../utils/book-status.js — the REAL guardedRevertBookStatus +
// transitionBookStatus run against a mutable book row, so we assert the ACTUAL persisted
// book status and the SSE gated by the real `landed` result. Only the SSE emitters are
// mocked (to observe them).
vi.mock('../utils/download-side-effects.js', () => ({
  emitDownloadStatusChange: vi.fn(),
  emitBookStatusChange: vi.fn(),
  recordDownloadFailedEvent: vi.fn(),
}));

import { runReplaceWorkflow, type ReplaceCtx } from './download-replace-workflow.js';
import { emitBookStatusChange } from '../utils/download-side-effects.js';
import { REVERT_FALLBACK_STATUS } from '../utils/book-status.js';
import { createMockDb, mockDbChain, createMockLogger, inject } from '../__tests__/helpers.js';
import { books } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import type { BookStatus } from '../../shared/schemas/book.js';
import type { DownloadService } from './download.service.js';
import type { FastifyBaseLogger } from 'fastify';
import type { GrabParams } from './download-orchestrator.js';
import type { DownloadRow } from './types.js';

const emitBookStatus = emitBookStatusChange as unknown as Mock;

function replaceableRow(over: Partial<DownloadRow> = {}): DownloadRow {
  return {
    id: 10, title: 'Old Grab', clientStatus: 'downloading', pipelineStage: 'idle',
    externalId: 'ext-old', downloadClientId: 1, bookId: 5, bookStatusAtGrab: 'wanted',
    infoHash: 'h', guid: 'g', addedAt: new Date('2026-01-01'), ...over,
  } as DownloadRow;
}

/**
 * A stateful db whose `books` writes model the REAL guarded transition: the guarded
 * `transitionBookStatus(..., expected: { status: 'downloading' })` lands (and mutates
 * the tracked status) ONLY while the book is still 'downloading'; `downloads` writes
 * (the claim) always land. Exposes the live book status so tests assert the persisted
 * value after the workflow's guarded revert.
 */
function statefulDb(bookStatus: BookStatus) {
  const state = { bookStatus };
  const db = createMockDb();
  (db.update as Mock).mockImplementation((table: unknown) => ({
    set: (payload: Record<string, unknown>) => ({
      where: () => ({
        returning: async () => {
          if (table === books) {
            // Guarded revert: expected status is 'downloading'.
            if (state.bookStatus === 'downloading') {
              state.bookStatus = payload.status as BookStatus;
              return [{ id: 1 }];
            }
            return []; // guard miss — status preserved
          }
          return [{ id: 1 }]; // downloads claim lands
        },
      }),
    }),
  }));
  return { db: db as unknown as Db, state };
}

const params: GrabParams = { downloadUrl: 'magnet:?new', title: 'The New Release', bookId: 5, replace: true };

/** Drive the FAILED-GRAB revert path with the given tracked book status + snapshot. */
async function runFailedGrabRevert(bookStatus: BookStatus, snapshot: BookStatus | null) {
  const { db, state } = statefulDb(bookStatus);
  // gather (replaceable), in-tx recheck (clear), late-blocker (clear).
  (db as unknown as ReturnType<typeof createMockDb>).select
    .mockReturnValueOnce(mockDbChain([replaceableRow({ bookStatusAtGrab: snapshot })]))
    .mockReturnValue(mockDbChain([]));
  const grab = vi.fn().mockRejectedValue(new Error('client offline')); // fails → triggers revert
  const ctx: ReplaceCtx = {
    db,
    log: inject<FastifyBaseLogger>(createMockLogger()),
    downloadService: inject<DownloadService>({ removeExternalItem: vi.fn().mockResolvedValue(undefined) }),
    blacklistService: inject({ create: vi.fn().mockResolvedValue(undefined) }),
    broadcaster: inject({}),
    eventHistory: inject({}),
    grab,
    safe: (fn) => fn(),
  };
  await expect(runReplaceWorkflow(ctx, params)).rejects.toThrow('client offline');
  return state;
}

describe('runReplaceWorkflow — persisted guarded-revert matrix (#1857 F22)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downloading → reverts to the in-memory snapshot and emits the SSE', async () => {
    const state = await runFailedGrabRevert('downloading', 'wanted');
    expect(state.bookStatus).toBe('wanted'); // actual persisted value
    expect(emitBookStatus).toHaveBeenCalledWith(expect.objectContaining({ bookId: 5, newStatus: 'wanted' }));
  });

  it('importing → guard MISS, status preserved, NO SSE (covers both pending-job origins — disposition keys off book status)', async () => {
    const state = await runFailedGrabRevert('importing', 'wanted');
    expect(state.bookStatus).toBe('importing'); // a late import promotion is not clobbered
    expect(emitBookStatus).not.toHaveBeenCalled();
  });

  it('any other non-downloading status → guard MISS, status preserved, NO SSE', async () => {
    const state = await runFailedGrabRevert('missing', 'wanted');
    expect(state.bookStatus).toBe('missing');
    expect(emitBookStatus).not.toHaveBeenCalled();
  });

  it('null snapshot → reverts to REVERT_FALLBACK_STATUS when the book is still downloading', async () => {
    const state = await runFailedGrabRevert('downloading', null);
    expect(state.bookStatus).toBe(REVERT_FALLBACK_STATUS);
    expect(REVERT_FALLBACK_STATUS).toBe('imported');
    expect(emitBookStatus).toHaveBeenCalledWith(expect.objectContaining({ bookId: 5, newStatus: 'imported' }));
  });
});
