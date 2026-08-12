import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBookActivity } from './useBookActivity.js';
import { setMergeProgress, applyMergeStateSnapshot, _resetForTesting } from './useMergeProgress.js';
import { api } from '@/lib/api';
import type { Mock } from 'vitest';

vi.mock('@/lib/api', () => ({
  api: {
    getImportJobs: vi.fn().mockResolvedValue([]),
  },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

function importJob(overrides: Record<string, unknown>) {
  return {
    id: 1,
    bookId: 42,
    type: 'auto',
    status: 'pending',
    phase: null,
    phaseHistory: [],
    createdAt: '2026-08-03T00:00:00Z',
    updatedAt: '2026-08-03T00:00:00Z',
    startedAt: null,
    completedAt: null,
    book: { title: 'T', coverUrl: null, primaryAuthorName: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (api.getImportJobs as Mock).mockResolvedValue([]);
  _resetForTesting();
});

afterEach(() => {
  _resetForTesting();
});

describe('useBookActivity', () => {
  it('returns null when no merge and no import job exist', async () => {
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    await waitFor(() => expect(api.getImportJobs).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('maps a queued merge to the queued state', () => {
    setMergeProgress(42, { bookTitle: 'T', phase: 'queued' });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toEqual({ state: 'queued', label: 'Merge queued' });
  });

  it('maps an encoding merge to working, converting the wire fraction to a display percent', () => {
    setMergeProgress(42, { bookTitle: 'T', phase: 'processing', percentage: 0.61 });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toEqual({ state: 'working', label: 'Encoding…', percentage: 61 });
  });

  it('maps a verifying merge to working without a percentage', () => {
    setMergeProgress(42, { bookTitle: 'T', phase: 'verifying' });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toEqual({ state: 'working', label: 'Verifying output…' });
  });

  it('reports null for a terminal merge (dismiss window)', () => {
    setMergeProgress(42, { bookTitle: 'T', phase: 'complete', outcome: 'success' });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toBeNull();
  });

  it('ignores merge progress belonging to a different book', () => {
    setMergeProgress(7, { bookTitle: 'Other', phase: 'processing', percentage: 0.1 });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toBeNull();
  });

  it('maps a pending import job to the queued state', async () => {
    (api.getImportJobs as Mock).mockResolvedValue([importJob({ status: 'pending' })]);
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ state: 'queued', label: 'Import queued' }));
  });

  it('maps a processing import job to the working state', async () => {
    (api.getImportJobs as Mock).mockResolvedValue([importJob({ status: 'processing', phase: 'copying' })]);
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    await waitFor(() => expect(result.current).toEqual({ state: 'working', label: 'Importing…' }));
  });

  it('ignores completed and failed import jobs', async () => {
    (api.getImportJobs as Mock).mockResolvedValue([
      importJob({ status: 'completed' }),
      importJob({ id: 2, status: 'failed' }),
    ]);
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    await waitFor(() => expect(api.getImportJobs).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it('prefers merge state over an import job for the same book', async () => {
    (api.getImportJobs as Mock).mockResolvedValue([importJob({ status: 'pending' })]);
    setMergeProgress(42, { bookTitle: 'T', phase: 'processing', percentage: 0.3 });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    await waitFor(() => expect(api.getImportJobs).toHaveBeenCalled());
    expect(result.current).toEqual({ state: 'working', label: 'Encoding…', percentage: 30 });
  });
});

describe('useBookActivity from a merge_state snapshot', () => {
  it('reports a queued merge learned ONLY from the snapshot (the reported regression)', () => {
    applyMergeStateSnapshot({ active: [], queued: [{ book_id: 42, book_title: 'The Shining' }] });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toEqual({ state: 'queued', label: 'Merge queued' });
  });

  it('reports the working state with its percentage for an active snapshot entry', () => {
    applyMergeStateSnapshot({
      active: [{ book_id: 42, book_title: 'Dogs of War', phase: 'processing', percentage: 0.35 }],
      queued: [],
    });
    const { result } = renderHook(() => useBookActivity(42), { wrapper });
    expect(result.current).toEqual({ state: 'working', label: 'Encoding…', percentage: 35 });
  });

  it('reports null after the terminal sequence, while the Activity card is still in its dismiss window', () => {
    setMergeProgress(42, { bookTitle: 'Dogs of War', phase: 'complete', outcome: 'success', message: 'Merged 3 files' });
    applyMergeStateSnapshot({ active: [], queued: [] });

    const { result } = renderHook(() => useBookActivity(42), { wrapper });

    expect(result.current).toBeNull();
  });
});
