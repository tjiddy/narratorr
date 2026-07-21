import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportAttentionBanner } from './ImportAttentionBanner';
import { __resetDismissalMemory } from '@/lib/import-report/dismissalStore';
import type { AttentionResponse, AttentionSubmission } from '@/lib/api';

const getImportSubmissionAttention = vi.fn();
const discardImportSubmission = vi.fn();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      getImportSubmissionAttention: (...a: unknown[]) => getImportSubmissionAttention(...a),
      discardImportSubmission: (...a: unknown[]) => discardImportSubmission(...a),
    },
  };
});

function abandoned(id: number, received = 2, expected = 3): AttentionSubmission {
  return {
    id, clientSubmissionId: 'c', source: 'library', status: 'receiving',
    expectedCount: expected, receivedCount: received, processedCount: 0,
    aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 }, detailsPruned: false,
    itemsIncluded: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    attention: { kind: 'abandoned' },
  };
}
function completed(id: number, held: number, failed: number): AttentionSubmission {
  return {
    id, clientSubmissionId: 'c', source: 'library', status: 'complete',
    expectedCount: 3, receivedCount: 3, processedCount: held + failed,
    aggregates: { accepted: 0, held, skipped: 0, failed }, detailsPruned: false,
    itemsIncluded: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    attention: { kind: 'completed-attention', held, failed },
  };
}
const resp = (data: AttentionSubmission | null, watch = false): AttentionResponse => ({ data, watch });

beforeEach(() => {
  getImportSubmissionAttention.mockReset();
  discardImportSubmission.mockReset();
  __resetDismissalMemory();
  localStorage.clear();
});

describe('ImportAttentionBanner (#1894)', () => {
  it('renders abandoned copy with Discard + Import again', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(1, 2, 3), true));
    const onImportAgain = vi.fn();
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={onImportAgain} />);
    await screen.findByTestId('import-attention-banner');
    expect(screen.getByText('2 of 3 received — nothing was imported')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import again' }));
    expect(onImportAgain).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it('renders the deterministic completed-attention templates (singular/plural)', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(completed(5, 2, 3)));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    expect(screen.getByText('Import finished with 2 holds and 3 failures')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View details' })).toBeInTheDocument();
  });

  it('renders no banner when data is null', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(null, false));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await waitFor(() => expect(getImportSubmissionAttention).toHaveBeenCalled());
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
  });

  it('dismisses per (id + kind) — dismissing abandoned hides it', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(7), true));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('import-attention-banner')).not.toBeInTheDocument();
  });

  it('retains the banner + shows an error + retry when Discard fails (never optimistically cleared)', async () => {
    getImportSubmissionAttention.mockResolvedValue(resp(abandoned(3), true));
    discardImportSubmission.mockRejectedValue(new Error('409 conflict'));
    renderWithProviders(<ImportAttentionBanner source="library" onImportAgain={vi.fn()} />);
    await screen.findByTestId('import-attention-banner');
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await screen.findByTestId('attention-discard-error');
    expect(screen.getByTestId('import-attention-banner')).toBeInTheDocument(); // retained
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('a failed attention read is observable/retryable, not silently "no banner"', async () => {
    getImportSubmissionAttention.mockRejectedValue(new Error('boom'));
    renderWithProviders(<ImportAttentionBanner onImportAgain={vi.fn()} />);
    await screen.findByTestId('attention-error', {}, { timeout: 8000 });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  }, 12000);
});
