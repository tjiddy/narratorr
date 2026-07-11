import { describe, it, expect } from 'vitest';
import {
  isClientStageReplaceable,
  isPipelineBlocker,
  classifyBlockers,
  pipelineActiveReason,
  hasNonReplaceableBlocker,
  type BookBlockers,
} from './download-blockers.js';
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
