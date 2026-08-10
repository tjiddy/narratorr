import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { renderWithProviders } from '@/__tests__/helpers';
import { queryKeys } from '@/lib/queryKeys';
import { ImportHistorySection } from './ImportHistorySection';
import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

const listImportSubmissions = vi.fn();
const getImportSubmissionDetail = vi.fn();
const discardImportSubmission = vi.fn();
const clearCompletedImportSubmissions = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual, // Preserve ApiError identity for instanceof checks.
    api: {
      listImportSubmissions: (...a: unknown[]) => listImportSubmissions(...a),
      getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a),
      discardImportSubmission: (...a: unknown[]) => discardImportSubmission(...a),
      clearCompletedImportSubmissions: (...a: unknown[]) => clearCompletedImportSubmissions(...a),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { toast } from 'sonner';

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 1, clientSubmissionId: 'c', source: 'library', status: 'complete',
    expectedCount: 1, receivedCount: 1, processedCount: 1,
    aggregates: { accepted: 1, held: 0, skipped: 0, failed: 0 },
    detailsPruned: false, itemsIncluded: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

function detail(id: number, overrides: Partial<SubmissionSummary> = {}): SubmissionResponse {
  return { ...summary({ id, ...overrides }), itemsIncluded: true, items: [] } as SubmissionResponse;
}

function seedDetail(qc: QueryClient, id: number): void {
  qc.setQueryData(queryKeys.importSubmissions.detail(id), detail(id));
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Mutation settling competes with the rest of the suite for the event loop; 1s default flakes under load.
const SETTLED = { timeout: 5000 };

const deleteControl = (id: number) =>
  within(screen.getByTestId(`import-history-card-${id}`)).getByRole('button', { name: 'Delete import run' });

async function confirmDelete(user: ReturnType<typeof userEvent.setup>, id: number): Promise<void> {
  await user.click(deleteControl(id));
  await user.click(await screen.findByRole('button', { name: 'Delete run' }, SETTLED));
}

async function confirmClear(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: /clear completed/i }));
  await user.click(await screen.findByRole('button', { name: 'Clear completed runs' }, SETTLED));
}

let fetchSpy: MockInstance<typeof globalThis.fetch>;

beforeEach(() => {
  listImportSubmissions.mockReset();
  getImportSubmissionDetail.mockReset();
  discardImportSubmission.mockReset();
  clearCompletedImportSubmissions.mockReset();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  getImportSubmissionDetail.mockResolvedValue(detail(1));
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('ImportHistorySection per-row delete (#2220)', () => {
  it('cancelling the confirm issues no request', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');

    await user.click(deleteControl(3));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(discardImportSubmission).not.toHaveBeenCalled();
    expect(screen.getByTestId('import-history-card-3')).toBeInTheDocument();
  });

  it('confirming issues exactly one DELETE for that row, refetches the list, evicts its cached report, and toasts', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    seedDetail(qc, 3);
    seedDetail(qc, 4);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 }), summary({ id: 4 })], total: 2 });
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');
    const listCalls = listImportSubmissions.mock.calls.length;

    await confirmDelete(user, 3);

    await waitFor(() => expect(listImportSubmissions.mock.calls.length).toBeGreaterThan(listCalls), SETTLED);
    expect(discardImportSubmission.mock.calls).toEqual([[3]]);
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(4))).toBeDefined();
    expect(toast.success).toHaveBeenCalledWith('Import run deleted');
  });

  it('disables that row’s delete control while the request is in flight and re-enables it after', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    let release!: () => void;
    discardImportSubmission.mockReturnValue(new Promise<{ success: true }>((res) => { release = () => res({ success: true }); }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');

    await confirmDelete(user, 3);
    await waitFor(() => expect(deleteControl(3)).toBeDisabled(), SETTLED);

    release();
    await waitFor(() => expect(deleteControl(3)).toBeEnabled(), SETTLED);
  });

  it('a 409 names the still-importing state, keeps the row, and fires no success toast', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api');
    const qc = newClient();
    seedDetail(qc, 3);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3, status: 'processing' })], total: 1 });
    discardImportSubmission.mockRejectedValue(new ApiError(409, { error: 'submission-in-flight', message: 'nope' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmDelete(user, 3);

    const surface = await screen.findByTestId('import-history-delete-error');
    expect(surface).toHaveTextContent(/still importing/i);
    expect(screen.getByTestId('import-history-card-3')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeDefined();
  });

  it('a 404 resolves as success: no error surface, the list refetches, and that id’s report is evicted', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api');
    const qc = newClient();
    seedDetail(qc, 3);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    discardImportSubmission.mockRejectedValue(new ApiError(404, { error: 'submission-not-found' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');
    const listCalls = listImportSubmissions.mock.calls.length;

    await confirmDelete(user, 3);

    await waitFor(() => expect(listImportSubmissions.mock.calls.length).toBeGreaterThan(listCalls), SETTLED);
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeUndefined();
    expect(screen.queryByTestId('import-history-delete-error')).not.toBeInTheDocument();
  });

  it('a 500 surfaces an error, keeps the row, and evicts nothing', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api');
    const qc = newClient();
    seedDetail(qc, 3);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    discardImportSubmission.mockRejectedValue(new ApiError(500, { error: 'boom', message: 'server exploded' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmDelete(user, 3);

    expect(await screen.findByTestId('import-history-delete-error')).toHaveTextContent(/couldn’t delete/i);
    expect(screen.getByTestId('import-history-card-3')).toBeInTheDocument();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeDefined();
  });

  it('deleting the last remaining run renders the empty state', async () => {
    const user = userEvent.setup();
    listImportSubmissions
      .mockResolvedValueOnce({ data: [summary({ id: 3 })], total: 1 })
      .mockResolvedValue({ data: [], total: 0 });
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');

    await confirmDelete(user, 3);

    expect(await screen.findByTestId('import-history-empty')).toBeInTheDocument();
  });

  it('deleting the only row on page 2 clamps back and re-queries at offset 0', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 51 });
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() => expect(listImportSubmissions).toHaveBeenCalledWith({ limit: 50, offset: 50 }), SETTLED);

    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 4 })], total: 50 });
    await confirmDelete(user, 3);

    await waitFor(() => expect(listImportSubmissions).toHaveBeenLastCalledWith({ limit: 50, offset: 0 }), SETTLED);
  });

  it('issues no real network request across a delete flow', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');
    await confirmDelete(user, 3);
    await waitFor(() => expect(toast.success).toHaveBeenCalled(), SETTLED);

    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual([]);
  });
});

describe('ImportHistorySection bulk clear (#2220)', () => {
  it('the confirm names what is preserved and cancelling issues no request', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');

    await user.click(screen.getByRole('button', { name: /clear completed/i }));
    expect(await screen.findByText(/held, skipped, or failed/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(clearCompletedImportSubmissions).not.toHaveBeenCalled();
  });

  it('disables the clear control while the clear is in flight and re-enables it after', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    let release!: () => void;
    clearCompletedImportSubmissions.mockReturnValue(new Promise((res) => { release = () => res({ deleted: 1, ids: [3] }); }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-3');
    const clearButton = () => screen.getByRole('button', { name: /clear completed/i });

    await confirmClear(user);
    await waitFor(() => expect(clearButton()).toBeDisabled(), SETTLED);

    release();
    await waitFor(() => expect(clearButton()).toBeEnabled(), SETTLED);
  });

  it('evicts only the reports the server actually deleted and leaves the preserved run expandable', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    seedDetail(qc, 3);
    seedDetail(qc, 9);
    listImportSubmissions
      .mockResolvedValueOnce({ data: [summary({ id: 3 }), summary({ id: 9, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } })], total: 2 })
      .mockResolvedValue({ data: [summary({ id: 9, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } })], total: 1 });
    clearCompletedImportSubmissions.mockResolvedValue({ deleted: 1, ids: [3] });
    getImportSubmissionDetail.mockResolvedValue(detail(9, { aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmClear(user);

    await waitFor(() => expect(screen.queryByTestId('import-history-card-3')).not.toBeInTheDocument(), SETTLED);
    expect(clearCompletedImportSubmissions.mock.calls).toEqual([[]]);
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeUndefined();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(9))).toBeDefined();

    // The deleted run must not be re-seeded into the list cache by a stale cached report.
    const cached = qc.getQueryData(queryKeys.importSubmissions.list({ limit: 50, offset: 0 })) as { data: SubmissionSummary[] };
    expect(cached.data.map((r) => r.id)).toEqual([9]);

    await user.click(within(screen.getByTestId('import-history-card-9')).getByRole('button', { expanded: false }));
    await waitFor(() => expect(getImportSubmissionDetail).toHaveBeenCalledWith(9), SETTLED);
  });

  it('names the deleted count and evicts every returned id', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    for (const id of [3, 4, 5]) seedDetail(qc, id);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 }), summary({ id: 4 }), summary({ id: 5 })], total: 3 });
    clearCompletedImportSubmissions.mockResolvedValue({ deleted: 3, ids: [3, 4, 5] });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmClear(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Cleared 3 completed import runs'), SETTLED);
    for (const id of [3, 4, 5]) {
      expect(qc.getQueryData(queryKeys.importSubmissions.detail(id)), `detail(${id})`).toBeUndefined();
    }
  });

  it('a zero-delete clear still invalidates, evicts nothing, and says there was nothing to clear', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    seedDetail(qc, 9);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 9, aggregates: { accepted: 0, held: 1, skipped: 0, failed: 0 } })], total: 1 });
    clearCompletedImportSubmissions.mockResolvedValue({ deleted: 0, ids: [] });
    getImportSubmissionDetail.mockResolvedValue(detail(9));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9', queryClient: qc });
    await screen.findByTestId('import-history-card-9');
    const listCalls = listImportSubmissions.mock.calls.length;

    await confirmClear(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('No completed runs to clear'), SETTLED);
    await waitFor(() => expect(listImportSubmissions.mock.calls.length).toBeGreaterThan(listCalls), SETTLED);
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(9))).toBeDefined();
    expect(screen.getByTestId('import-history-card-9')).toBeInTheDocument();
  });

  it('a failure surfaces an error, leaves the list unchanged, and evicts nothing', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    seedDetail(qc, 3);
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 3 })], total: 1 });
    clearCompletedImportSubmissions.mockRejectedValue(new Error('server exploded'));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmClear(user);

    expect(await screen.findByTestId('import-history-delete-error')).toHaveTextContent(/couldn’t clear/i);
    expect(screen.getByTestId('import-history-card-3')).toBeInTheDocument();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeDefined();
    expect(toast.success).not.toHaveBeenCalled();
  });
});

/** Reads back the live URL so deep-link cleanup is asserted on the router, not on a prop. */
function DeepLinkHarness() {
  const [params] = useSearchParams();
  return (
    <>
      <span data-testid="search">{params.toString()}</span>
      <ImportHistorySection />
    </>
  );
}

describe('ImportHistorySection deep-link cleanup (#2220)', () => {
  it('a bulk clear that deletes the focused run clears only `run`, keeping tab and filter', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    seedDetail(qc, 3);
    listImportSubmissions
      .mockResolvedValueOnce({ data: [summary({ id: 3 })], total: 1 })
      .mockResolvedValue({ data: [summary({ id: 7 })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(detail(3));
    clearCompletedImportSubmissions.mockResolvedValue({ deleted: 1, ids: [3] });
    renderWithProviders(<DeepLinkHarness />, { route: '/activity?tab=history&filter=deleted&run=3', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmClear(user);

    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('tab=history&filter=deleted'), SETTLED);
    expect(screen.getByTestId('search').textContent).not.toContain('run=');
    expect(screen.queryByTestId('import-run-unavailable')).not.toBeInTheDocument();
    expect(await screen.findByTestId('import-history-card-7')).toBeInTheDocument();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeUndefined();
  });

  it('a bulk clear that spares the focused run leaves `run` set and its card rendered', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    const held = { accepted: 0, held: 1, skipped: 0, failed: 0 };
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 9, aggregates: held })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(detail(9, { aggregates: held }));
    clearCompletedImportSubmissions.mockResolvedValue({ deleted: 1, ids: [3] });
    renderWithProviders(<DeepLinkHarness />, { route: '/activity?tab=history&run=9', queryClient: qc });
    await screen.findByTestId('import-history-card-9');

    await confirmClear(user);

    await waitFor(() => expect(toast.success).toHaveBeenCalled(), SETTLED);
    expect(screen.getByTestId('search')).toHaveTextContent('run=9');
    expect(screen.getByTestId('import-history-card-9')).toBeInTheDocument();
  });

  it('deleting the focused run from its own card clears `run` and falls back to the list', async () => {
    const user = userEvent.setup();
    const qc = newClient();
    listImportSubmissions
      .mockResolvedValueOnce({ data: [summary({ id: 3 })], total: 1 })
      .mockResolvedValue({ data: [summary({ id: 7 })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(detail(3));
    discardImportSubmission.mockResolvedValue({ success: true });
    renderWithProviders(<DeepLinkHarness />, { route: '/activity?tab=history&run=3', queryClient: qc });
    await screen.findByTestId('import-history-card-3');

    await confirmDelete(user, 3);

    await waitFor(() => expect(screen.getByTestId('search').textContent).not.toContain('run='), SETTLED);
    expect(discardImportSubmission.mock.calls).toEqual([[3]]);
    expect(await screen.findByTestId('import-history-card-7')).toBeInTheDocument();
    expect(qc.getQueryData(queryKeys.importSubmissions.detail(3))).toBeUndefined();
  });
});
