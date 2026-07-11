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
import { createMockDb, mockDbChain } from '../__tests__/helpers.js';
import type { Db } from '../../db/index.js';
import type { Mock } from 'vitest';
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

describe('claimReplaceableTargets (#1857 F17/F21/F63)', () => {
  const targets = [
    { id: 10, expected: { clientStatus: 'downloading' as const, pipelineStage: 'idle' as const } },
    { id: 11, expected: { clientStatus: 'queued' as const, pipelineStage: 'idle' as const } },
  ];

  it('guard-claims every target to (failed, idle) with the reason written atomically, then commits', async () => {
    const db = createMockDb();
    const updateChain = mockDbChain([{ id: 1 }]); // every guarded claim lands
    db.update.mockReturnValue(updateChain);
    // In-tx recheck: no rows, no pending auto job → no blocker.
    db.select.mockReturnValueOnce(mockDbChain([])).mockReturnValueOnce(mockDbChain([]));

    await claimReplaceableTargets(db as unknown as Db, 5, targets, 'Replaced by "New"');

    const setCalls = (updateChain.set as Mock).mock.calls.map((c) => c[0] as Record<string, unknown>);
    // The sanctioned failure tuple + the replace reason land in the SAME statement (F63).
    expect(setCalls).toContainEqual(expect.objectContaining({ clientStatus: 'failed', pipelineStage: 'idle', errorMessage: 'Replaced by "New"' }));
    expect((db.update as Mock).mock.calls.length).toBe(2); // one guarded claim per target
  });

  it('throws ClaimMissError (rolls back) when a claim guard-misses', async () => {
    const db = createMockDb();
    // First target lands, second misses (returning() empty).
    db.update.mockReturnValueOnce(mockDbChain([{ id: 1 }])).mockReturnValueOnce(mockDbChain([]));

    await expect(claimReplaceableTargets(db as unknown as Db, 5, targets, 'r')).rejects.toBeInstanceOf(ClaimMissError);
  });

  it('throws ClaimMissError when the in-tx recheck finds a new non-replaceable blocker', async () => {
    const db = createMockDb();
    db.update.mockReturnValue(mockDbChain([{ id: 1 }])); // all claims land
    // Recheck: a pipeline-stage (importing) row appeared → blocker.
    db.select
      .mockReturnValueOnce(mockDbChain([dl({ id: 99, clientStatus: 'completed', pipelineStage: 'importing', externalId: 'e' })]))
      .mockReturnValueOnce(mockDbChain([])); // no pending auto job

    await expect(claimReplaceableTargets(db as unknown as Db, 5, targets, 'r')).rejects.toBeInstanceOf(ClaimMissError);
  });
});
