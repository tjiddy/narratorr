import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportHistorySection } from './ImportHistorySection';
import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

const listImportSubmissions = vi.fn();
const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual, // keep the real ApiError class for instanceof checks
    api: {
      listImportSubmissions: (...a: unknown[]) => listImportSubmissions(...a),
      getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a),
    },
  };
});

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 1, clientSubmissionId: 'c', source: 'library', status: 'complete',
    expectedCount: 3, receivedCount: 3, processedCount: 3,
    aggregates: { accepted: 1, held: 1, skipped: 0, failed: 1 },
    detailsPruned: false, itemsIncluded: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  listImportSubmissions.mockReset();
  getImportSubmissionDetail.mockReset();
});

describe('ImportHistorySection (#1894)', () => {
  it('renders cards with source label + mode + counts, newest-first from the server', async () => {
    listImportSubmissions.mockResolvedValue({
      data: [summary({ id: 2, source: 'manual', mode: 'copy' }), summary({ id: 1 })],
      total: 2,
    });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-2');
    expect(screen.getByText('Import history')).toBeInTheDocument();
    expect(screen.getByText('Manual')).toBeInTheDocument();
    expect(screen.getByText('· copy')).toBeInTheDocument();
    expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument();
  });

  it('shows the empty state when total is 0', async () => {
    listImportSubmissions.mockResolvedValue({ data: [], total: 0 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-empty');
    expect(screen.getByText('No import history yet.')).toBeInTheDocument();
  });

  it('auto-expands a present deep-link run and shows its attention rows', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 5 })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 5 }), itemsIncluded: true,
      items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Boom Book', message: 'kaboom' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=5' });
    await screen.findByText('kaboom');
    expect(screen.getByText('Boom Book')).toBeInTheDocument();
  });

  it('hydrates an off-page deep-link run into exactly one focused card (F64)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 }); // page lacks id 9
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 9 }), itemsIncluded: true,
      items: [{ disposition: 'held', ordinal: 0, path: '/h', title: 'Held Book', reason: 'recording-review-required' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    await waitFor(() => expect(screen.getAllByTestId('import-history-card-9')).toHaveLength(1));
    expect(screen.getByText('Held Book')).toBeInTheDocument();
  });

  it('degrades a 404 deep link to a "no longer available" placeholder (no retry, F59)', async () => {
    const { ApiError } = await import('@/lib/api');
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    getImportSubmissionDetail.mockRejectedValue(new ApiError(404, { error: 'submission-not-found' }));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=9' });
    await screen.findByTestId('import-run-unavailable');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    // The rest of the section still renders.
    expect(screen.getByTestId('import-history-card-1')).toBeInTheDocument();
  });

  it('ignores a non-positive-integer run (all collapsed)', async () => {
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1 })], total: 1 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history&run=abc' });
    await screen.findByTestId('import-history-card-1');
    expect(getImportSubmissionDetail).not.toHaveBeenCalled();
  });

  it('shows a section-level error + retry when the list read fails', async () => {
    listImportSubmissions.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByText('Couldn’t load import history.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('promotes a self-polled detail header into the card and keeps it terminal across collapse/re-expand (F86)', async () => {
    const user = userEvent.setup();
    // The list snapshot shows the run still Processing…
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, status: 'processing', processedCount: 1, aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 } })], total: 1 });
    // …but the detail read for that id is already terminal.
    getImportSubmissionDetail.mockResolvedValue({
      ...summary({ id: 1, status: 'complete', processedCount: 3 }), itemsIncluded: true,
      items: [{ disposition: 'failed', ordinal: 0, path: '/a', title: 'Failed Book', message: 'nope' }],
    } as SubmissionResponse);
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    const card = await screen.findByTestId('import-history-card-1');
    expect(screen.getByText('Processing')).toBeInTheDocument();

    await user.click(card.querySelector('button')!); // expand → detail promotes the header
    await screen.findByText('Failed Book');
    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument());
    expect(screen.queryByText('Processing')).not.toBeInTheDocument();

    await user.click(card.querySelector('button')!); // collapse — header must stay Completed
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await user.click(card.querySelector('button')!); // re-expand
    expect(screen.getByText('Completed')).toBeInTheDocument();
    await screen.findByText('Failed Book');
  });

  it('renders a pruned card as "details expired" on expand', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ id: 1, detailsPruned: true })], total: 1 });
    renderWithProviders(<ImportHistorySection />, { route: '/activity?tab=history' });
    await screen.findByTestId('import-history-card-1');
    await user.click(screen.getByTestId('import-history-card-1').querySelector('button')!);
    expect(await screen.findByTestId('import-details-expired')).toBeInTheDocument();
    expect(getImportSubmissionDetail).not.toHaveBeenCalled(); // pruned short-circuits the fetch
  });
});
