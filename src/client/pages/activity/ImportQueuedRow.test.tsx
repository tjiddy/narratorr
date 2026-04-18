import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportQueuedRow } from './ImportQueuedRow';
import type { ImportJobWithBook } from '@/lib/api/import-jobs';

function makeQueuedJob(overrides: Partial<ImportJobWithBook> = {}): ImportJobWithBook {
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
    book: { title: 'Queued Book', coverUrl: null, primaryAuthorName: 'Author Name' },
    ...overrides,
  };
}

describe('ImportQueuedRow', () => {
  it('renders title and primary author name', () => {
    renderWithProviders(<ImportQueuedRow job={makeQueuedJob()} />);

    expect(screen.getByText('Queued Book')).toBeInTheDocument();
    expect(screen.getByText('Author Name')).toBeInTheDocument();
  });

  it('displays QUEUED eyebrow label', () => {
    renderWithProviders(<ImportQueuedRow job={makeQueuedJob()} />);

    expect(screen.getByText('Queued')).toBeInTheDocument();
  });

  it('does not render phase rows or progress', () => {
    renderWithProviders(<ImportQueuedRow job={makeQueuedJob()} />);

    expect(screen.queryByText(/Analyzing/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Copying/)).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('renders HeadphonesIcon fallback when coverUrl is null', () => {
    renderWithProviders(<ImportQueuedRow job={makeQueuedJob()} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
