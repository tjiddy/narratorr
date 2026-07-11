import { describe, it, expect } from 'vitest';
import {
  isClientStageReplaceable,
  isPipelineBlocker,
  classifyBlockers,
  pipelineActiveReason,
  hasNonReplaceableBlocker,
  claimReplaceableTargets,
  type BookBlockers,
} from './download-blockers.js';
import { ClaimMissError } from './download-errors.js';
import { createMockDb } from '../__tests__/helpers.js';
import { and, eq } from 'drizzle-orm';
import { downloads } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import type { DownloadRow } from './types.js';

function dl(partial: Partial<DownloadRow>): DownloadRow {
  return {
    id: 1,
    title: 'A Book',
    clientStatus: 'downloading',
    pipelineStage: 'idle',
    externalId: 'ext-1',
    ...partial,
  } as DownloadRow;
}

describe('isClientStageReplaceable (#1857)', () => {
  it.each(['queued', 'downloading', 'paused'] as const)('is replaceable for idle + %s', (clientStatus) => {
    expect(isClientStageReplaceable(dl({ clientStatus, pipelineStage: 'idle' }))).toBe(true);
  });

  it('is NOT replaceable once the pipeline is non-idle (checking)', () => {
    expect(isClientStageReplaceable(dl({ clientStatus: 'completed', pipelineStage: 'checking' }))).toBe(false);
  });

  it('is NOT replaceable for a completed client-stage row', () => {
    expect(isClientStageReplaceable(dl({ clientStatus: 'completed', pipelineStage: 'idle' }))).toBe(false);
  });
});

describe('isPipelineBlocker (#1857 F59)', () => {
  it.each(['checking', 'pending_review', 'importing'] as const)('blocks on pipeline stage %s', (pipelineStage) => {
    expect(isPipelineBlocker(dl({ clientStatus: 'completed', pipelineStage }))).toBe(true);
  });

  it('blocks a tracked completed row (externalId != null) — QG-eligible', () => {
    expect(isPipelineBlocker(dl({ clientStatus: 'completed', pipelineStage: 'idle', externalId: 'ext-1' }))).toBe(true);
  });

  it('does NOT block a Blackhole handoff (completed, idle, externalId=null)', () => {
    expect(isPipelineBlocker(dl({ clientStatus: 'completed', pipelineStage: 'idle', externalId: null }))).toBe(false);
  });

  it('does NOT block a client-stage downloading row', () => {
    expect(isPipelineBlocker(dl({ clientStatus: 'downloading', pipelineStage: 'idle' }))).toBe(false);
  });
});

function blockers(partial: Partial<BookBlockers>): BookBlockers {
  return { replaceable: [], pipelineDownloads: [], hasPendingAutoJob: false, ...partial };
}

describe('classifyBlockers (#1857)', () => {
  it('clears when nothing blocks', () => {
    expect(classifyBlockers(blockers({}))).toEqual({ kind: 'clear' });
  });

  it('classifies replaceable, returning most-recent title + count', () => {
    const rows = [
      dl({ id: 5, title: 'Newer', clientStatus: 'downloading' }),
      dl({ id: 2, title: 'Older', clientStatus: 'queued' }),
    ];
    const result = classifyBlockers(blockers({ replaceable: rows }));
    expect(result).toEqual({ kind: 'replaceable', active: { title: 'Newer', count: 2 }, rows });
  });

  it('gives PIPELINE_ACTIVE precedence over replaceable in the mixed case', () => {
    const result = classifyBlockers(blockers({
      replaceable: [dl({ clientStatus: 'queued' })],
      pipelineDownloads: [dl({ clientStatus: 'completed', pipelineStage: 'importing' })],
    }));
    expect(result).toEqual({ kind: 'pipeline', reason: 'processing' });
  });

  it('classifies a pending auto job as PIPELINE_ACTIVE even with a replaceable row present', () => {
    const result = classifyBlockers(blockers({
      replaceable: [dl({ clientStatus: 'queued' })],
      hasPendingAutoJob: true,
    }));
    expect(result).toEqual({ kind: 'pipeline', reason: 'processing' });
  });
});

describe('pipelineActiveReason aggregate (#1857 F60/F64)', () => {
  it('is awaiting_review iff ANY blocker is pending_review (order-independent)', () => {
    expect(pipelineActiveReason(blockers({
      pipelineDownloads: [
        dl({ clientStatus: 'completed', pipelineStage: 'importing' }),
        dl({ clientStatus: 'completed', pipelineStage: 'pending_review' }),
      ],
    }))).toBe('awaiting_review');
  });

  it('is processing when no blocker is pending_review', () => {
    expect(pipelineActiveReason(blockers({
      pipelineDownloads: [dl({ clientStatus: 'completed', pipelineStage: 'checking' })],
    }))).toBe('processing');
  });

  it('is processing for a lone auto job (no pending_review download)', () => {
    expect(pipelineActiveReason(blockers({ hasPendingAutoJob: true }))).toBe('processing');
  });
});

describe('hasNonReplaceableBlocker', () => {
  it('is true for a pipeline download or a pending auto job', () => {
    expect(hasNonReplaceableBlocker(blockers({ pipelineDownloads: [dl({ pipelineStage: 'importing' })] }))).toBe(true);
    expect(hasNonReplaceableBlocker(blockers({ hasPendingAutoJob: true }))).toBe(true);
  });
  it('is false when only replaceable rows exist', () => {
    expect(hasNonReplaceableBlocker(blockers({ replaceable: [dl({ clientStatus: 'queued' })] }))).toBe(false);
  });
});

/**
 * Stateful staged/rollback transaction fixture (#1857 F4). Models what
 * `createMockDb` cannot: a transaction that COMMITS staged writes on resolve and
 * DISCARDS them on throw. Each guarded `transitionDownloadState` write is only
 * staged when its `.returning()` resolves a non-empty row (the guard matched),
 * driven by `returningSeq`; the recorded `where` predicates let the test prove the
 * `expected` guard is present (deletion heuristic). `committed` is empty after a
 * rollback — proving every original row is left unchanged.
 */
function stagedTxDb(returningSeq: Array<Array<{ id: number }>>, recheckRows: DownloadRow[] = [], recheckJobs: Array<{ id: number }> = []) {
  const committed: Array<Record<string, unknown>> = [];
  const wherePredicates: unknown[] = [];
  let updateCall = 0;
  const db = createMockDb();
  db.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
    const staged: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({
        set: (payload: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            wherePredicates.push(cond);
            return {
              returning: async () => {
                const rows = returningSeq[updateCall++] ?? [];
                if (rows.length > 0) staged.push(payload); // would-be committed write
                return rows;
              },
            };
          },
        }),
      }),
      // in-tx recheck gather: first select → rows, second → pending auto jobs
      select: (() => {
        let sel = 0;
        return () => ({
          from: () => ({
            where: (_c: unknown) => ({
              orderBy: async () => recheckRows,
              limit: async () => recheckJobs,
            }),
          }),
          _sel: sel++, // keep distinct
        });
      })(),
    };
    try {
      const r = await cb(tx);
      committed.push(...staged); // commit
      return r;
    } catch (e) {
      // rollback — staged writes are discarded (never pushed to committed)
      throw e;
    }
  });
  return { db: db as unknown as Db, committed, wherePredicates };
}

describe('claimReplaceableTargets (#1857 F4/F17/F21/F63)', () => {
  const targets = [
    { id: 10, expected: { clientStatus: 'downloading' as const, pipelineStage: 'idle' as const } },
    { id: 11, expected: { clientStatus: 'queued' as const, pipelineStage: 'idle' as const } },
  ];

  it('guard-claims every target to (failed, idle) with the reason written atomically, then commits', async () => {
    const { db, committed, wherePredicates } = stagedTxDb([[{ id: 1 }], [{ id: 1 }]]); // both land, recheck empty
    await claimReplaceableTargets(db, 5, targets, 'Replaced by "New"');

    // Both rows committed with the sanctioned failure tuple + the replace reason (F63).
    expect(committed).toHaveLength(2);
    expect(committed[0]).toMatchObject({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Replaced by "New"' });
    // Each claim carried the EXACT guarded predicate (id + observed tuple) — deletion heuristic.
    expect(wherePredicates[0]).toEqual(and(eq(downloads.id, 10), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')));
    expect(wherePredicates[1]).toEqual(and(eq(downloads.id, 11), eq(downloads.clientStatus, 'queued'), eq(downloads.pipelineStage, 'idle')));
  });

  it('second claim guard-miss throws ClaimMissError and ROLLS BACK the first (nothing committed)', async () => {
    const { db, committed, wherePredicates } = stagedTxDb([[{ id: 1 }], []]); // first lands, second misses

    await expect(claimReplaceableTargets(db, 5, targets, 'r')).rejects.toBeInstanceOf(ClaimMissError);

    // The first row was STAGED but the sentinel rolled the whole tx back → 0 committed.
    expect(committed).toHaveLength(0);
    // Both guarded predicates were still issued (the guard IS present on both claims).
    expect(wherePredicates[0]).toEqual(and(eq(downloads.id, 10), eq(downloads.clientStatus, 'downloading'), eq(downloads.pipelineStage, 'idle')));
    expect(wherePredicates[1]).toEqual(and(eq(downloads.id, 11), eq(downloads.clientStatus, 'queued'), eq(downloads.pipelineStage, 'idle')));
  });

  it('in-tx recheck finding a new non-replaceable blocker throws ClaimMissError and rolls back all claims', async () => {
    // Both claims land, but the recheck finds an importing row → blocker → rollback.
    const { db, committed } = stagedTxDb(
      [[{ id: 1 }], [{ id: 1 }]],
      [dl({ id: 99, clientStatus: 'completed', pipelineStage: 'importing', externalId: 'e' })],
      [],
    );

    await expect(claimReplaceableTargets(db, 5, targets, 'r')).rejects.toBeInstanceOf(ClaimMissError);
    expect(committed).toHaveLength(0); // every claimed row rolled back
  });
});
