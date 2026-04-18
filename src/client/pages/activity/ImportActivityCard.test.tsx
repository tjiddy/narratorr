import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportActivityCard } from './ImportActivityCard';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';

function makeJob(overrides: Partial<ImportJobWithBook> & { _progress?: number; _byteCounter?: { current: number; total: number } } = {}): ImportJobWithBook & { _progress?: number; _byteCounter?: { current: number; total: number } } {
  return {
    id: 1,
    bookId: 42,
    type: 'manual',
    status: 'processing',
    phase: 'copying',
    phaseHistory: [
      { phase: 'analyzing', startedAt: 1000, completedAt: 2000 },
      { phase: 'copying', startedAt: 2000 },
    ],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    startedAt: '2025-01-01T00:00:00Z',
    completedAt: null,
    book: { title: 'Test Book', coverUrl: null, primaryAuthorName: 'Test Author' },
    ...overrides,
  };
}

describe('ImportActivityCard', () => {
  describe('phase checklist rendering', () => {
    it('renders completed phases with check icon', () => {
      const job = makeJob();
      renderWithProviders(<ImportActivityCard job={job} />);

      // Analyzing is done — should show elapsed time
      expect(screen.getByText(/Analyzing/)).toBeInTheDocument();
      expect(screen.getByText(/1\.0s/)).toBeInTheDocument();
    });

    it('renders current phase with spinner', () => {
      const job = makeJob();
      renderWithProviders(<ImportActivityCard job={job} />);

      // Copying is current — should show label
      expect(screen.getByText(/Copying files/)).toBeInTheDocument();
    });

    it('does not render phases absent from phaseHistory', () => {
      const job = makeJob({
        phaseHistory: [{ phase: 'analyzing', startedAt: 1000, completedAt: 2000 }],
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.queryByText(/Copying files/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Flattening/)).not.toBeInTheDocument();
    });

    it('renders inline progress for copy phase', () => {
      const job = makeJob({ _progress: 0.43, _byteCounter: { current: 12_000_000, total: 28_000_000 }, _progressPhase: 'copying' });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText(/43%/)).toBeInTheDocument();
    });

  });

  describe('cover image', () => {
    it('renders HeadphonesIcon fallback when coverUrl is null', () => {
      const job = makeJob();
      renderWithProviders(<ImportActivityCard job={job} />);

      // HeadphonesIcon renders as an SVG — check for the muted container
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('renders cover image when coverUrl is set', () => {
      const job = makeJob({ book: { title: 'Test', coverUrl: '/covers/42.jpg', primaryAuthorName: null } });
      renderWithProviders(<ImportActivityCard job={job} />);

      const img = screen.getByRole('img');
      expect(img).toBeInTheDocument();
    });
  });

  describe('author display', () => {
    it('displays primary author name', () => {
      const job = makeJob();
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText('Test Author')).toBeInTheDocument();
    });
  });

  describe('failure state', () => {
    it('shows Failed label for failed jobs', () => {
      const job = makeJob({ status: 'failed' });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  describe('completed state', () => {
    it('shows Imported label for completed jobs', () => {
      const job = makeJob({ status: 'completed' });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText('Imported')).toBeInTheDocument();
    });
  });

  describe('renaming phase progress (#650)', () => {
    it('renders "Renaming files · 50% (14/28 files)" with progress bar when renaming phase is current', () => {
      const job = makeJob({
        phase: 'renaming',
        phaseHistory: [
          { phase: 'analyzing', startedAt: 1000, completedAt: 1500 },
          { phase: 'copying', startedAt: 1500, completedAt: 2000 },
          { phase: 'renaming', startedAt: 2000 },
        ],
        _progress: 0.5,
        _byteCounter: { current: 14, total: 28 },
        _progressPhase: 'renaming',
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText(/Renaming files/)).toBeInTheDocument();
      expect(screen.getByText(/50%/)).toBeInTheDocument();
      expect(screen.getByText(/14\/28 files/)).toBeInTheDocument();
    });

    it('renders "Renaming files" plain when renaming phase is current but no progress events', () => {
      const job = makeJob({
        phase: 'renaming',
        phaseHistory: [
          { phase: 'analyzing', startedAt: 1000, completedAt: 1500 },
          { phase: 'copying', startedAt: 1500, completedAt: 2000 },
          { phase: 'renaming', startedAt: 2000 },
        ],
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText(/Renaming files/)).toBeInTheDocument();
      // No percentage shown without progress data
      expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    });

    it('renders "Renaming files" with elapsed time when renaming phase is completed', () => {
      const job = makeJob({
        phase: 'fetching_metadata',
        phaseHistory: [
          { phase: 'analyzing', startedAt: 1000, completedAt: 1500 },
          { phase: 'copying', startedAt: 1500, completedAt: 2000 },
          { phase: 'renaming', startedAt: 2000, completedAt: 4300 },
          { phase: 'fetching_metadata', startedAt: 4300 },
        ],
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText(/Renaming files/)).toBeInTheDocument();
      expect(screen.getByText(/2\.3s/)).toBeInTheDocument();
    });

    it('does not render stale copy counters as file counts during copy→renaming transition', () => {
      // Simulates the gap between import_phase_change('renaming') and first import_progress('renaming')
      // where _byteCounter still holds copy byte values but _progressPhase is 'copying'
      const job = makeJob({
        phase: 'renaming',
        phaseHistory: [
          { phase: 'analyzing', startedAt: 1000, completedAt: 1500 },
          { phase: 'copying', startedAt: 1500, completedAt: 2000 },
          { phase: 'renaming', startedAt: 2000 },
        ],
        _progress: 0.43,
        _byteCounter: { current: 12_000_000, total: 28_000_000 },
        _progressPhase: 'copying', // stale — from previous phase
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.getByText(/Renaming files/)).toBeInTheDocument();
      // Should NOT show stale copy byte counts as file counts
      expect(screen.queryByText(/12000000/)).not.toBeInTheDocument();
      expect(screen.queryByText(/28000000/)).not.toBeInTheDocument();
    });

    it('does not render renaming row when phase is absent from phaseHistory', () => {
      const job = makeJob({
        phaseHistory: [
          { phase: 'analyzing', startedAt: 1000, completedAt: 2000 },
          { phase: 'copying', startedAt: 2000 },
        ],
      });
      renderWithProviders(<ImportActivityCard job={job} />);

      expect(screen.queryByText(/Renaming files/)).not.toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('phase status communicated via aria-label', () => {
      const job = makeJob();
      renderWithProviders(<ImportActivityCard job={job} />);

      const phaseElements = screen.getAllByLabelText(/completed|in progress/);
      expect(phaseElements.length).toBeGreaterThanOrEqual(1);
    });

    it('progress has role="progressbar" and aria-valuenow', () => {
      const job = makeJob({ _progress: 0.5, _progressPhase: 'copying' });
      renderWithProviders(<ImportActivityCard job={job} />);

      const progressBar = screen.getByRole('progressbar');
      expect(progressBar).toHaveAttribute('aria-valuenow', '50');
    });
  });
});
