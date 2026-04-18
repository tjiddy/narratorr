import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  let dateNowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, 'now');
  });

  afterEach(() => {
    dateNowSpy.mockRestore();
  });

  describe('visibility', () => {
    it('renders when import jobs exist in non-terminal states', () => {
      renderWithProviders(<ImportBatchBanner jobs={[makeJob({ status: 'processing' })]} />);

      expect(screen.getByText(/0 of 1 processed/)).toBeInTheDocument();
    });

    it('renders when most recent terminal job completed <60s ago', () => {
      const now = Date.now();
      dateNowSpy.mockReturnValue(now);

      const job = makeJob({
        status: 'completed',
        completedAt: new Date(now - 30_000).toISOString(), // 30s ago
      });
      renderWithProviders(<ImportBatchBanner jobs={[job]} />);

      expect(screen.getByText(/1 of 1 processed/)).toBeInTheDocument();
    });

    it('hides when all jobs terminal and completedAt >60s ago', () => {
      const now = Date.now();
      dateNowSpy.mockReturnValue(now);

      const job = makeJob({
        status: 'completed',
        completedAt: new Date(now - 90_000).toISOString(), // 90s ago
      });
      const { container } = renderWithProviders(<ImportBatchBanner jobs={[job]} />);

      // Banner should not render
      expect(container.textContent).toBe('');
    });

    it('hides when no import jobs exist', () => {
      const { container } = renderWithProviders(<ImportBatchBanner jobs={[]} />);
      expect(container.textContent).toBe('');
    });
  });

  describe('counts', () => {
    it('shows correct X of Y processed, A imported, B failed', () => {
      const now = Date.now();
      dateNowSpy.mockReturnValue(now);

      const jobs = [
        makeJob({ id: 1, status: 'completed', completedAt: new Date(now - 10_000).toISOString() }),
        makeJob({ id: 2, status: 'failed', completedAt: new Date(now - 5_000).toISOString() }),
        makeJob({ id: 3, status: 'processing' }),
        makeJob({ id: 4, status: 'pending' }),
      ];
      renderWithProviders(<ImportBatchBanner jobs={jobs} />);

      expect(screen.getByText(/2 of 4 processed/)).toBeInTheDocument();
      expect(screen.getByText(/1 imported/)).toBeInTheDocument();
    });
  });

  describe('failed link', () => {
    it('"B failed →" link rendered when B > 0', () => {
      const now = Date.now();
      dateNowSpy.mockReturnValue(now);

      const jobs = [
        makeJob({ id: 1, status: 'failed', completedAt: new Date(now - 5_000).toISOString() }),
      ];
      renderWithProviders(<ImportBatchBanner jobs={jobs} />);

      const link = screen.getByText(/failed/);
      expect(link.closest('a')).toHaveAttribute('href', '/activity?tab=history&filter=import_failed');
    });

    it('does not render failed link when B is 0', () => {
      renderWithProviders(<ImportBatchBanner jobs={[makeJob({ status: 'processing' })]} />);

      expect(screen.queryByText(/failed/)).not.toBeInTheDocument();
    });
  });
});
