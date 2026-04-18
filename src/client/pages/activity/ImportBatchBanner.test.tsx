import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportBatchBanner } from './ImportBatchBanner';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';

function makeJob(overrides: Partial<ImportJobWithBook> = {}): ImportJobWithBook {
  return {
    id: 1,
    bookId: 42,
    type: 'manual',
    status: 'pending',
    phase: 'queued',
    phaseHistory: [],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    startedAt: null,
    completedAt: null,
    book: { title: 'Test', coverUrl: null, primaryAuthorName: null },
    ...overrides,
  };
}

describe('ImportBatchBanner', () => {
  const NOW = 1700000000000;

  describe('visibility', () => {
    it('renders when import jobs exist in non-terminal states', () => {
      renderWithProviders(<ImportBatchBanner jobs={[makeJob({ status: 'processing' })]} now={NOW} />);

      expect(screen.getByText(/0 of 1 processed/)).toBeInTheDocument();
    });

    it('renders when most recent terminal job completed <60s ago', () => {
      const job = makeJob({
        status: 'completed',
        completedAt: new Date(NOW - 30_000).toISOString(),
      });
      renderWithProviders(<ImportBatchBanner jobs={[job]} now={NOW} />);

      expect(screen.getByText(/1 of 1 processed/)).toBeInTheDocument();
    });

    it('hides when all jobs terminal and completedAt >60s ago', () => {
      const job = makeJob({
        status: 'completed',
        completedAt: new Date(NOW - 90_000).toISOString(),
      });
      const { container } = renderWithProviders(<ImportBatchBanner jobs={[job]} now={NOW} />);

      expect(container.textContent).toBe('');
    });

    it('hides when no import jobs exist', () => {
      const { container } = renderWithProviders(<ImportBatchBanner jobs={[]} now={NOW} />);
      expect(container.textContent).toBe('');
    });
  });

  describe('counts', () => {
    it('shows correct X of Y processed, A imported, B failed', () => {
      const jobs = [
        makeJob({ id: 1, status: 'completed', completedAt: new Date(NOW - 10_000).toISOString() }),
        makeJob({ id: 2, status: 'failed', completedAt: new Date(NOW - 5_000).toISOString() }),
        makeJob({ id: 3, status: 'processing' }),
        makeJob({ id: 4, status: 'pending' }),
      ];
      renderWithProviders(<ImportBatchBanner jobs={jobs} now={NOW} />);

      expect(screen.getByText(/2 of 4 processed/)).toBeInTheDocument();
      expect(screen.getByText(/1 imported/)).toBeInTheDocument();
    });
  });

  describe('failed link', () => {
    it('"B failed →" link rendered when B > 0', () => {
      const jobs = [
        makeJob({ id: 1, status: 'failed', completedAt: new Date(NOW - 5_000).toISOString() }),
      ];
      renderWithProviders(<ImportBatchBanner jobs={jobs} now={NOW} />);

      const link = screen.getByText(/failed/);
      expect(link.closest('a')).toHaveAttribute('href', '/activity?tab=history&filter=import_failed');
    });

    it('does not render failed link when B is 0', () => {
      renderWithProviders(<ImportBatchBanner jobs={[makeJob({ status: 'processing' })]} now={NOW} />);

      expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    });
  });
});
