import type { Mock } from 'vitest';
import type { SubmissionResponse, SubmissionAggregates, StagedItemResultDto } from '@/lib/api';

/**
 * Shared fixtures/mocks for the staged submit + poll flow (#1902). The hook/page tests
 * mock `@/lib/api` and drive the pipeline through `createSubmission` → `putSubmissionItems`
 * → `finalizeSubmission` → `getSubmission` (summary + one-time detail). Because the poll
 * controller fires its FIRST tick immediately (not after the interval), a summary that
 * already reads `complete` resolves the whole terminal chain via microtasks — no fake
 * timers needed for terminal-outcome tests.
 */

export const zeroAgg: SubmissionAggregates = { accepted: 0, held: 0, skipped: 0, failed: 0 };

interface HeaderOverrides {
  id?: number;
  clientSubmissionId?: string;
  source?: 'library' | 'manual';
  mode?: 'copy' | 'move';
  status?: 'receiving' | 'processing' | 'complete';
  expectedCount?: number;
  receivedCount?: number;
  processedCount?: number;
  aggregates?: SubmissionAggregates;
  detailsPruned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

const HEADER_BASE = {
  id: 5,
  clientSubmissionId: '00000000-0000-4000-8000-000000000000',
  source: 'library',
  status: 'receiving',
  expectedCount: 1,
  receivedCount: 0,
  processedCount: 0,
  aggregates: zeroAgg,
  detailsPruned: false,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
};

export function summaryResponse(over: HeaderOverrides = {}): SubmissionResponse {
  return { ...HEADER_BASE, ...over, itemsIncluded: false } as SubmissionResponse;
}

export function detailResponse(items: StagedItemResultDto[], over: HeaderOverrides = {}): SubmissionResponse {
  return { ...HEADER_BASE, ...over, itemsIncluded: true, items } as SubmissionResponse;
}

// ── Disposition-row builders ─────────────────────────────────────────────────
export const acceptedRow = (ordinal: number, path: string, title = 'T'): StagedItemResultDto =>
  ({ disposition: 'accepted', ordinal, path, title, bookId: ordinal + 1 });
export const heldRow = (ordinal: number, path: string, title = 'T'): StagedItemResultDto =>
  ({ disposition: 'held', ordinal, path, title, reason: 'recording-review-required' });
export const skippedRow = (ordinal: number, path: string, title = 'T', reason: 'already-in-library' | 'already-importing' = 'already-in-library'): StagedItemResultDto =>
  ({ disposition: 'skipped', ordinal, path, title, reason });
export const failedRow = (ordinal: number, path: string, title = 'T'): StagedItemResultDto =>
  ({ disposition: 'failed', ordinal, path, title, message: 'boom' });

export function aggregateOf(items: StagedItemResultDto[]): SubmissionAggregates {
  const agg = { ...zeroAgg };
  for (const i of items) {
    if (i.disposition === 'accepted') agg.accepted++;
    else if (i.disposition === 'held') agg.held++;
    else if (i.disposition === 'skipped') agg.skipped++;
    else if (i.disposition === 'failed') agg.failed++;
  }
  return agg;
}

export interface StagedMockFns {
  create: Mock;
  put: Mock;
  finalize: Mock;
  get: Mock;
  byClient: Mock;
}

export interface WireCompleteOpts {
  id?: number;
  source?: 'library' | 'manual';
  mode?: 'copy' | 'move';
  items?: StagedItemResultDto[];
  aggregates?: SubmissionAggregates;
  detailsPruned?: boolean;
  expectedCount?: number;
}

/**
 * Wire a full happy submit that polls straight to `complete` and returns the given
 * terminal detail on the one-time `includeItems=true` fetch.
 */
export function wireStagedComplete(m: StagedMockFns, opts: WireCompleteOpts = {}): void {
  const id = opts.id ?? 5;
  const items = opts.items ?? [];
  const aggregates = opts.aggregates ?? aggregateOf(items);
  const detailsPruned = opts.detailsPruned ?? false;
  const source = opts.source ?? 'library';
  const modeOver = opts.mode !== undefined ? { mode: opts.mode } : {};
  const expectedCount = opts.expectedCount ?? Math.max(1, items.length);
  const base = { id, source, expectedCount, ...modeOver };

  m.create.mockResolvedValue(summaryResponse({ ...base, status: 'receiving' }));
  m.put.mockResolvedValue(summaryResponse({ ...base, status: 'receiving' }));
  m.finalize.mockResolvedValue(summaryResponse({ ...base, status: 'processing', aggregates }));
  m.get.mockImplementation((_id: number, includeItems?: boolean) =>
    Promise.resolve(
      includeItems
        ? detailResponse(items, { ...base, status: 'complete', aggregates, detailsPruned, processedCount: expectedCount })
        : summaryResponse({ ...base, status: 'complete', aggregates, detailsPruned, processedCount: expectedCount }),
    ),
  );
}
