import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportHistoryCard } from './ImportHistoryCard';
import type { SubmissionSummary } from '@/lib/api';

const getImportSubmissionDetail = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: { getImportSubmissionDetail: (...a: unknown[]) => getImportSubmissionDetail(...a) },
  };
});

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

describe('ImportHistoryCard delete affordance (#2220)', () => {
  it('renders delete as a sibling of the expand toggle, not nested inside it', () => {
    renderWithProviders(<ImportHistoryCard row={summary()} onDelete={vi.fn()} />);
    const card = screen.getByTestId('import-history-card-1');
    const expand = within(card).getByRole('button', { expanded: false });
    const del = within(card).getByRole('button', { name: 'Delete import run' });
    expect(expand).not.toContainElement(del);
    expect(del).not.toContainElement(expand);
  });

  it('clicking delete reports the row id without toggling the expansion, and expanding still works afterwards', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    getImportSubmissionDetail.mockResolvedValue({ ...summary({ id: 4 }), itemsIncluded: true, items: [] });
    renderWithProviders(<ImportHistoryCard row={summary({ id: 4 })} onDelete={onDelete} />);
    const card = screen.getByTestId('import-history-card-4');

    await user.click(within(card).getByRole('button', { name: 'Delete import run' }));
    expect(onDelete).toHaveBeenCalledWith(4);
    expect(within(card).getByRole('button', { expanded: false })).toBeInTheDocument();
    expect(getImportSubmissionDetail).not.toHaveBeenCalled();

    await user.click(within(card).getByRole('button', { expanded: false }));
    expect(within(card).getByRole('button', { expanded: true })).toBeInTheDocument();
    await waitFor(() => expect(getImportSubmissionDetail).toHaveBeenCalledWith(4));
  });

  it('disables only the delete control while its own delete is pending', () => {
    renderWithProviders(<ImportHistoryCard row={summary()} onDelete={vi.fn()} isDeleting />);
    const card = screen.getByTestId('import-history-card-1');
    expect(within(card).getByRole('button', { name: 'Delete import run' })).toBeDisabled();
    expect(within(card).getByRole('button', { expanded: false })).toBeEnabled();
  });

  it('omits the delete control entirely when no handler is supplied', () => {
    renderWithProviders(<ImportHistoryCard row={summary()} />);
    expect(screen.queryByRole('button', { name: 'Delete import run' })).not.toBeInTheDocument();
  });
});
