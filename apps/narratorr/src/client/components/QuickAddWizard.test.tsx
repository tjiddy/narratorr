import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { QuickAddWizard } from './QuickAddWizard';

vi.mock('@/lib/api', () => ({
  api: {
    scanSingleBook: vi.fn(),
    importSingleBook: vi.fn(),
    searchMetadata: vi.fn(),
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

const mockScanResult = {
  book: {
    path: '/audiobooks/Author/Title',
    parsedTitle: 'The Way of Kings',
    parsedAuthor: 'Brandon Sanderson',
    parsedSeries: null,
    fileCount: 10,
    totalSize: 500_000_000,
  },
  metadata: {
    title: 'The Way of Kings',
    authors: [{ name: 'Brandon Sanderson' }],
    narrators: ['Michael Kramer', 'Kate Reading'],
    description: 'An epic fantasy novel.',
    coverUrl: 'https://example.com/cover.jpg',
    asin: 'B003P2WO5E',
    providerId: 'hc-123',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QuickAddWizard', () => {
  it('does not render when closed', () => {
    const { container } = renderWithProviders(
      <QuickAddWizard isOpen={false} onClose={vi.fn()} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders path input step when open', () => {
    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);
    expect(screen.getByText('Quick Add')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('/path/to/audiobook')).toBeInTheDocument();
  });

  it('shows error when scan finds multiple books', async () => {
    vi.mocked(api.scanSingleBook).mockRejectedValue(
      new Error('This folder contains 5 audiobooks. Use Library Import for bulk imports.'),
    );
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByText(/This folder contains 5 audiobooks/)).toBeInTheDocument();
    });
  });

  it('shows verify step with editable fields after scan', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/audiobooks/Author/Title');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Brandon Sanderson')).toBeInTheDocument();
    });

    // Metadata preview shown
    expect(screen.getByText(/Michael Kramer/)).toBeInTheDocument();
  });

  it('allows editing fields and re-searching', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    vi.mocked(api.searchMetadata).mockResolvedValue({
      books: [{
        title: 'Corrected Title',
        authors: [{ name: 'Corrected Author' }],
        coverUrl: 'https://example.com/new-cover.jpg',
      }],
      authors: [],
      series: [],
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
    });

    // Change the title
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New Title' } });

    // Click search
    await user.click(screen.getByText('Search Providers'));

    await waitFor(() => {
      expect(api.searchMetadata).toHaveBeenCalledWith('New Title Brandon Sanderson');
    });
  });

  it('imports book with verified metadata', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    vi.mocked(api.importSingleBook).mockResolvedValue({
      imported: true,
      bookId: 42,
      enriched: true,
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(screen.getByText('Added to Library')).toBeInTheDocument();
    });

    expect(api.importSingleBook).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/audiobooks/Author/Title',
        title: 'The Way of Kings',
        authorName: 'Brandon Sanderson',
        asin: 'B003P2WO5E',
      }),
    );
  });

  it('shows duplicate error in done step', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    vi.mocked(api.importSingleBook).mockResolvedValue({
      imported: false,
      enriched: false,
      error: 'duplicate',
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(screen.getByText('Import Failed')).toBeInTheDocument();
      expect(screen.getByText('This book is already in your library.')).toBeInTheDocument();
    });
  });

  it('shows error when import throws a network error', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    vi.mocked(api.importSingleBook).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Import' }));

    await waitFor(() => {
      expect(screen.getByText('Import Failed')).toBeInTheDocument();
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows metadata preview without narrators', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue({
      book: {
        path: '/audiobooks/Author/Title',
        parsedTitle: 'A Book',
        parsedAuthor: 'Author',
        parsedSeries: null,
        fileCount: 5,
        totalSize: 200_000_000,
      },
      metadata: {
        title: 'A Book',
        authors: [{ name: 'Author' }],
        description: 'A description.',
        coverUrl: 'https://example.com/cover.jpg',
        asin: 'B123',
        providerId: 'hc-1',
        // no narrators field
      },
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('A Book')).toBeInTheDocument();
    });

    // Should show metadata without crashing even though narrators is missing
    expect(screen.getByText('A description.')).toBeInTheDocument();
  });

  it('handles search returning empty results', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue(mockScanResult);
    vi.mocked(api.searchMetadata).mockResolvedValue({
      books: [],
      authors: [],
      series: [],
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Search Providers'));

    await waitFor(() => {
      expect(api.searchMetadata).toHaveBeenCalled();
    });
  });

  it('shows verify step with no metadata preview when scan returns null metadata', async () => {
    vi.mocked(api.scanSingleBook).mockResolvedValue({
      book: {
        path: '/audiobooks/Unknown',
        parsedTitle: 'Some Obscure Book',
        parsedAuthor: null,
        parsedSeries: null,
        fileCount: 3,
        totalSize: 100_000_000,
      },
      metadata: null,
    });
    const user = userEvent.setup();

    renderWithProviders(<QuickAddWizard isOpen={true} onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('/path/to/audiobook'), '/books');
    await user.click(screen.getByText('Scan'));

    await waitFor(() => {
      expect(screen.getByDisplayValue('Some Obscure Book')).toBeInTheDocument();
    });

    // No metadata match message shown
    expect(screen.getByText(/No metadata match found/)).toBeInTheDocument();
    // Author field should be empty
    expect(screen.getByLabelText('Author')).toHaveValue('');
  });
});
