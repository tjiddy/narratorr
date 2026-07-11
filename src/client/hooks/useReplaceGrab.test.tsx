import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useReplaceGrab } from './useReplaceGrab';

const { MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`HTTP ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  return { MockApiError };
});

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: { ...(actual as { api: object }).api, searchGrab: vi.fn() },
    ApiError: MockApiError,
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { toast } from 'sonner';

const searchGrab = api.searchGrab as unknown as ReturnType<typeof vi.fn>;
const toastSuccess = toast.success as unknown as ReturnType<typeof vi.fn>;
const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const BOOK_TITLE = 'Words of Radiance';
const payload = { downloadUrl: 'magnet:?x', title: 'The Chosen Release', bookId: 5 };

describe('useReplaceGrab (#1857)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('success: toasts, calls onGrabSuccess, leaves no confirm pending', async () => {
    searchGrab.mockResolvedValue({ id: 1 });
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReplaceGrab(onSuccess, BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(toastSuccess).toHaveBeenCalled();
    expect(result.current.confirm).toBeNull();
  });

  it('ACTIVE_DOWNLOAD_EXISTS: opens a confirm naming the active + selected release', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old Grab' }, count: 1 }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    await waitFor(() => expect(result.current.confirm).not.toBeNull());
    expect(result.current.confirm!.message).toContain('Old Grab');
    expect(result.current.confirm!.message).toContain('The Chosen Release');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ACTIVE_DOWNLOAD_EXISTS: plural copy when count > 1', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old' }, count: 3 }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    await waitFor(() => expect(result.current.confirm).not.toBeNull());
    expect(result.current.confirm!.message).toContain('3 downloads');
  });

  it('confirming re-issues the grab with replace: true', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old' }, count: 1 }));
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReplaceGrab(onSuccess, BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));
    await waitFor(() => expect(result.current.confirm).not.toBeNull());

    searchGrab.mockResolvedValueOnce({ id: 2 });
    act(() => result.current.confirm!.onConfirm());

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(searchGrab).toHaveBeenLastCalledWith(expect.objectContaining({ ...payload, replace: true }));
    expect(result.current.confirm).toBeNull();
  });

  it('PIPELINE_ACTIVE processing: honest toast, no confirm', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'PIPELINE_ACTIVE', reason: 'processing' }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    // AC10/F2 — the toast NAMES the book and carries no transport vocabulary.
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('being imported')));
    const msg = toastError.mock.calls.at(-1)![0] as string;
    expect(msg).toContain(BOOK_TITLE);
    expect(msg).not.toMatch(/409|PIPELINE_ACTIVE|job/);
    expect(result.current.confirm).toBeNull();
  });

  it('PIPELINE_ACTIVE awaiting_review: names the book and directs the user to Activity to approve/reject', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'PIPELINE_ACTIVE', reason: 'awaiting_review' }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('awaiting your review')));
    const msg = toastError.mock.calls.at(-1)![0] as string;
    expect(msg).toContain(BOOK_TITLE);
    expect(msg).not.toMatch(/409|PIPELINE_ACTIVE|job/);
    expect(result.current.confirm).toBeNull();
  });

  it('confirmed replace that loses the race (PIPELINE_ACTIVE) clears pending + toasts', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old' }, count: 1 }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });
    act(() => result.current.grab(payload));
    await waitFor(() => expect(result.current.confirm).not.toBeNull());

    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'PIPELINE_ACTIVE', reason: 'processing' }));
    act(() => result.current.confirm!.onConfirm());

    await waitFor(() => expect(result.current.confirm).toBeNull());
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('being imported'));
  });

  it('generic error: generic toast, no confirm', async () => {
    searchGrab.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    act(() => result.current.grab(payload));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Failed to grab')));
    expect(result.current.confirm).toBeNull();
  });

  // #1857 F17 — a response that resolves AFTER reset() (modal close / book change)
  // must NOT act on the (now-stale) lifecycle. reset() is the shared teardown seam.
  it('ignores a stale ACTIVE_DOWNLOAD_EXISTS that resolves after reset — no confirm repopulated', async () => {
    let rejectGrab!: (e: unknown) => void;
    searchGrab.mockImplementationOnce(() => new Promise((_res, rej) => { rejectGrab = rej; }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });

    await act(async () => { result.current.grab(payload); await new Promise((r) => setTimeout(r, 0)); }); // in-flight
    expect(rejectGrab).toBeDefined();
    act(() => result.current.reset());             // close / book change
    await act(async () => {                          // stale 409 arrives afterwards
      rejectGrab(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old' }, count: 1 }));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.confirm).toBeNull();     // did not repopulate the confirm
    expect(toastError).not.toHaveBeenCalled();
  });

  it('ignores a stale success that resolves after reset — does not call onGrabSuccess or toast success', async () => {
    let resolveGrab!: (v: unknown) => void;
    searchGrab.mockImplementationOnce(() => new Promise((res) => { resolveGrab = res; }));
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useReplaceGrab(onSuccess, BOOK_TITLE), { wrapper });

    await act(async () => { result.current.grab(payload); await new Promise((r) => setTimeout(r, 0)); });
    expect(resolveGrab).toBeDefined();
    act(() => result.current.reset());
    await act(async () => {
      resolveGrab({ id: 1 });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('reset clears a pending confirm (modal close / book change)', async () => {
    searchGrab.mockRejectedValueOnce(new MockApiError(409, { code: 'ACTIVE_DOWNLOAD_EXISTS', active: { title: 'Old' }, count: 1 }));
    const { result } = renderHook(() => useReplaceGrab(vi.fn(), BOOK_TITLE), { wrapper });
    act(() => result.current.grab(payload));
    await waitFor(() => expect(result.current.confirm).not.toBeNull());

    act(() => result.current.reset());
    expect(result.current.confirm).toBeNull();
  });
});
