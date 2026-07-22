import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { attentionCopy, pluralCount } from './attentionCopy.js';
import { patchImportHistoryCache } from './cache.js';
import {
  DISMISSAL_CAP,
  DISMISSAL_STORAGE_KEY,
  dismissalKey,
  loadDismissedKeys,
  useAttentionDismissal,
  __resetDismissalMemory,
} from './dismissalStore.js';
import type { AttentionSubmission, SubmissionResponse, SubmissionSummary } from '@/lib/api';

const baseHeader = {
  clientSubmissionId: 'c', source: 'library' as const, expectedCount: 3, receivedCount: 3,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
};

function summary(id: number, status: SubmissionSummary['status'], processedCount: number, aggregates = { accepted: 0, held: 0, skipped: 0, failed: 0 }): SubmissionSummary {
  return { ...baseHeader, id, status, processedCount, aggregates, detailsPruned: false, itemsIncluded: false };
}

describe('attentionCopy (F54)', () => {
  it('formats singular/plural counts', () => {
    expect(pluralCount(1, 'hold')).toBe('1 hold');
    expect(pluralCount(3, 'hold')).toBe('3 holds');
    expect(pluralCount(2, 'failure')).toBe('2 failures');
  });

  const abandoned = (received: number, expected: number): AttentionSubmission => ({
    ...summary(1, 'receiving', 0), receivedCount: received, expectedCount: expected, attention: { kind: 'abandoned' },
  });
  const completed = (held: number, failed: number): AttentionSubmission => ({
    ...summary(1, 'complete', held + failed, { accepted: 0, held, skipped: 0, failed }),
    attention: { kind: 'completed-attention', held, failed },
  });

  it('abandoned copy (incl. M of M fully-received)', () => {
    expect(attentionCopy(abandoned(1, 3))).toBe('1 of 3 received — nothing was imported');
    expect(attentionCopy(abandoned(3, 3))).toBe('3 of 3 received — nothing was imported');
  });

  it('completed held-only / failed-only / both', () => {
    expect(attentionCopy(completed(2, 0))).toBe('Import finished with 2 holds');
    expect(attentionCopy(completed(0, 1))).toBe('Import finished with 1 failure');
    expect(attentionCopy(completed(2, 3))).toBe('Import finished with 2 holds and 3 failures');
  });
});

describe('dismissal store (F55)', () => {
  beforeEach(() => {
    __resetDismissalMemory();
    localStorage.clear();
  });

  it('keys distinguish same-id kinds', () => {
    expect(dismissalKey(5, 'abandoned')).toBe('5:abandoned');
    expect(dismissalKey(5, 'completed-attention')).toBe('5:completed-attention');
  });

  it('dismissing abandoned does not suppress a later completed-attention on the same id; a new id re-raises', () => {
    const { result } = renderHook(() => useAttentionDismissal());
    act(() => result.current.dismiss(dismissalKey(5, 'abandoned')));
    expect(result.current.isDismissed(dismissalKey(5, 'abandoned'))).toBe(true);
    expect(result.current.isDismissed(dismissalKey(5, 'completed-attention'))).toBe(false); // distinct key
    expect(result.current.isDismissed(dismissalKey(6, 'abandoned'))).toBe(false); // new id
  });

  it('caps at 50 with FIFO eviction — the 51st dismissal evicts the oldest', () => {
    const { result } = renderHook(() => useAttentionDismissal());
    act(() => {
      for (let i = 0; i < 51; i++) result.current.dismiss(dismissalKey(i, 'abandoned'));
    });
    expect(DISMISSAL_CAP).toBe(50);
    expect(loadDismissedKeys()).toHaveLength(50);
    expect(result.current.isDismissed(dismissalKey(0, 'abandoned'))).toBe(false); // oldest evicted
    expect(result.current.isDismissed(dismissalKey(50, 'abandoned'))).toBe(true); // newest kept
  });

  it('falls back to in-memory list when localStorage.getItem throws (no crash)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => loadDismissedKeys()).not.toThrow();
    expect(loadDismissedKeys()).toEqual([]);
    spy.mockRestore();
  });

  it('treats corrupt stored data as empty (no crash)', () => {
    localStorage.setItem(DISMISSAL_STORAGE_KEY, '{not json');
    expect(loadDismissedKeys()).toEqual([]);
    localStorage.setItem(DISMISSAL_STORAGE_KEY, '{"not":"an array"}');
    expect(loadDismissedKeys()).toEqual([]);
  });

  it('when localStorage.setItem throws, dismissals are RETAINED in the in-memory fallback', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useAttentionDismissal());
    act(() => result.current.dismiss(dismissalKey(7, 'abandoned')));
    // Hook state reflects it, AND the store-level read (in-memory fallback) retains it.
    expect(result.current.isDismissed(dismissalKey(7, 'abandoned'))).toBe(true);
    expect(loadDismissedKeys()).toContain('7:abandoned');
    spy.mockRestore();
  });

  it('the in-memory fallback keeps the same 50-entry FIFO cap', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const { result } = renderHook(() => useAttentionDismissal());
    act(() => {
      for (let i = 0; i < 51; i++) result.current.dismiss(dismissalKey(i, 'abandoned'));
    });
    expect(loadDismissedKeys()).toHaveLength(50); // capped in memory too
    expect(result.current.isDismissed(dismissalKey(0, 'abandoned'))).toBe(false); // oldest evicted
    expect(result.current.isDismissed(dismissalKey(50, 'abandoned'))).toBe(true);
    spy.mockRestore();
  });
});

describe('patchImportHistoryCache (F86/F89)', () => {
  function detailFor(id: number, status: SubmissionResponse['status'], processedCount: number): SubmissionResponse {
    return { ...summary(id, status, processedCount), itemsIncluded: true, items: [] } as SubmissionResponse;
  }

  it('promotes a more-terminal header into EVERY cached list page containing the id (F89)', () => {
    const qc = new QueryClient();
    const page1 = { data: [summary(1, 'processing', 1), summary(2, 'complete', 3)], total: 4 };
    const page2 = { data: [summary(1, 'processing', 1)], total: 4 };
    qc.setQueryData(['importSubmissions', 'list', { limit: 20, offset: 0 }], page1);
    qc.setQueryData(['importSubmissions', 'list', { limit: 20, offset: 20 }], page2);

    patchImportHistoryCache(qc, detailFor(1, 'complete', 3));

    const p1 = qc.getQueryData(['importSubmissions', 'list', { limit: 20, offset: 0 }]) as typeof page1;
    const p2 = qc.getQueryData(['importSubmissions', 'list', { limit: 20, offset: 20 }]) as typeof page2;
    expect(p1.data.find((r) => r.id === 1)!.status).toBe('complete');
    expect(p2.data.find((r) => r.id === 1)!.status).toBe('complete');
    expect(p1.data.find((r) => r.id === 2)!.status).toBe('complete'); // untouched
  });

  it('does not regress a header when the detail is less terminal (monotonic)', () => {
    const qc = new QueryClient();
    qc.setQueryData(['importSubmissions', 'list', { limit: 20, offset: 0 }], { data: [summary(1, 'complete', 3)], total: 1 });
    patchImportHistoryCache(qc, detailFor(1, 'processing', 1));
    const p = qc.getQueryData(['importSubmissions', 'list', { limit: 20, offset: 0 }]) as { data: SubmissionSummary[] };
    expect(p.data[0]!.status).toBe('complete'); // not reverted
  });
});
