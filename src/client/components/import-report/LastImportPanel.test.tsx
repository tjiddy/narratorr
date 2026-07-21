import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { LastImportPanel } from './LastImportPanel';
import type { SubmissionResponse, SubmissionSummary } from '@/lib/api';

const listImportSubmissions = vi.fn();
const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      listImportSubmissions: (...a: unknown[]) => listImportSubmissions(...a),
      getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a),
    },
  };
});

function summary(overrides: Partial<SubmissionSummary> = {}): SubmissionSummary {
  return {
    id: 1, clientSubmissionId: 'c', source: 'library', status: 'receiving',
    expectedCount: 3, receivedCount: 2, processedCount: 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 },
    detailsPruned: false, itemsIncluded: false,
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  listImportSubmissions.mockReset();
  getImportSubmissionDetail.mockReset();
});

describe('LastImportPanel (#1894)', () => {
  it('hides when the latest read returns no submission', async () => {
    listImportSubmissions.mockResolvedValue({ data: [], total: 0 });
    renderWithProviders(<LastImportPanel source="library" />);
    await waitFor(() => expect(screen.queryByTestId('last-import-skeleton')).not.toBeInTheDocument());
    expect(screen.queryByTestId('last-import-panel')).not.toBeInTheDocument();
  });

  it('maps status → chip label and renders counts + the View in Activity link', async () => {
    listImportSubmissions.mockResolvedValue({
      data: [summary({ status: 'processing', aggregates: { accepted: 2, held: 1, skipped: 0, failed: 3 } })],
      total: 1,
    });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    expect(screen.getByText('Processing')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
    expect(screen.getByText('1 held')).toBeInTheDocument();
    expect(screen.getByText('3 failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View in Activity' })).toHaveAttribute('href', '/activity?tab=history&run=1');
  });

  it('uses completedAt for the relative time on a complete run', async () => {
    listImportSubmissions.mockResolvedValue({
      data: [summary({
        status: 'complete',
        createdAt: new Date(Date.now() - 60 * 1000).toISOString(), // 1m ago
        completedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(), // 3h ago
      })],
      total: 1,
    });
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument(); // completedAt, not createdAt's "1m ago"
  });

  it('expands to attention rows only (held → failed → skipped) with skipped link', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'complete', completedAt: new Date().toISOString() })], total: 1 });
    const detail: SubmissionResponse = {
      ...summary({ status: 'complete', completedAt: new Date().toISOString() }),
      itemsIncluded: true,
      items: [
        { disposition: 'accepted', ordinal: 0, path: '/a', title: 'Accepted One', bookId: 1 },
        { disposition: 'held', ordinal: 1, path: '/b', title: 'Held One', reason: 'recording-review-required' },
        { disposition: 'failed', ordinal: 2, path: '/c', title: 'Failed One', message: 'Disk full' },
        { disposition: 'skipped', ordinal: 3, path: '/d', title: 'Skipped One', reason: 'already-in-library', existingBookId: 9, existingTitle: 'Dune' },
      ],
    };
    getImportSubmissionDetail.mockResolvedValue(detail);
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByTestId('import-attention-rows');
    expect(screen.getByText('Held One')).toBeInTheDocument();
    expect(screen.getByText('Disk full')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Dune' })).toHaveAttribute('href', '/books/9');
    expect(screen.queryByText('Accepted One')).not.toBeInTheDocument(); // accepted is count-only
  });

  it('shows "Details expired" when the expansion returns a pruned record', async () => {
    const user = userEvent.setup();
    listImportSubmissions.mockResolvedValue({ data: [summary({ status: 'complete', detailsPruned: true, completedAt: new Date().toISOString() })], total: 1 });
    getImportSubmissionDetail.mockResolvedValue(summary({ status: 'complete', detailsPruned: true, completedAt: new Date().toISOString() }));
    renderWithProviders(<LastImportPanel source="library" />);
    await screen.findByTestId('last-import-panel');
    await user.click(screen.getByRole('button', { name: 'Details' }));
    await screen.findByTestId('import-details-expired');
  });

  it('shows an inline error + retry when the latest read fails with no cached data', async () => {
    listImportSubmissions.mockRejectedValue(new Error('boom'));
    renderWithProviders(<LastImportPanel source="library" />);
    // The hook uses retry:2 (exponential backoff ~1s+2s) before surfacing the error.
    await screen.findByText('Couldn’t load the last import.', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);
});
