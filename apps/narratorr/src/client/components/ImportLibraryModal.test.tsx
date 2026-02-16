import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportLibraryModal } from './ImportLibraryModal';

vi.mock('@/lib/api', () => ({
  api: {
    scanDirectory: vi.fn(),
    confirmImport: vi.fn(),
  },
  formatBytes: (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`,
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

import { api } from '@/lib/api';

const mockDiscoveries = [
  { path: '/books/Author/Title', parsedTitle: 'The Way of Kings', parsedAuthor: 'Brandon Sanderson', parsedSeries: null, fileCount: 10, totalSize: 500_000_000 },
  { path: '/books/Author/Title2', parsedTitle: 'Words of Radiance', parsedAuthor: 'Brandon Sanderson', parsedSeries: 'Stormlight', fileCount: 12, totalSize: 600_000_000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ImportLibraryModal', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <ImportLibraryModal isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders input step when open', () => {
    renderWithProviders(<ImportLibraryModal isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('Import Existing Library')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/path/to/audiobooks')).toBeInTheDocument();
  });

  it('shows enrichment count in done step', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: mockDiscoveries,
      totalFolders: 2,
      skippedDuplicates: 0,
    });
    vi.mocked(api.confirmImport).mockResolvedValue({
      imported: 2,
      failed: 0,
      enriched: 2,
      enrichmentFailed: 0,
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportLibraryModal isOpen={true} onClose={vi.fn()} />);

    // Enter path and scan
    await user.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/books');
    await user.click(screen.getByRole('button', { name: '' })); // search icon button

    // Wait for review step
    await waitFor(() => expect(screen.getByText('The Way of Kings')).toBeInTheDocument());

    // Click import
    await user.click(screen.getByText(/Import 2 Books/));

    // Done step shows enrichment
    await waitFor(() => {
      expect(screen.getByText('Import Complete')).toBeInTheDocument();
      expect(screen.getByText(', 2 enriched')).toBeInTheDocument();
    });
  });

  it('shows enrichment failures in done step', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [mockDiscoveries[0]],
      totalFolders: 1,
      skippedDuplicates: 0,
    });
    vi.mocked(api.confirmImport).mockResolvedValue({
      imported: 1,
      failed: 0,
      enriched: 0,
      enrichmentFailed: 1,
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportLibraryModal isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/books');
    await user.click(screen.getByRole('button', { name: '' }));

    await waitFor(() => expect(screen.getByText('The Way of Kings')).toBeInTheDocument());
    await user.click(screen.getByText(/Import 1 Book$/));

    await waitFor(() => {
      expect(screen.getByText('Import Complete')).toBeInTheDocument();
      expect(screen.getByText(/1 enrichment failure/)).toBeInTheDocument();
    });
  });

  it('hides enrichment info when all zero', async () => {
    vi.mocked(api.scanDirectory).mockResolvedValue({
      discoveries: [mockDiscoveries[0]],
      totalFolders: 1,
      skippedDuplicates: 0,
    });
    vi.mocked(api.confirmImport).mockResolvedValue({
      imported: 1,
      failed: 0,
      enriched: 0,
      enrichmentFailed: 0,
    });
    const user = userEvent.setup();

    renderWithProviders(<ImportLibraryModal isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/books');
    await user.click(screen.getByRole('button', { name: '' }));

    await waitFor(() => expect(screen.getByText('The Way of Kings')).toBeInTheDocument());
    await user.click(screen.getByText(/Import 1 Book$/));

    await waitFor(() => {
      expect(screen.getByText('Import Complete')).toBeInTheDocument();
      expect(screen.queryByText(/enriched/)).not.toBeInTheDocument();
      expect(screen.queryByText(/enrichment failure/)).not.toBeInTheDocument();
    });
  });
});
