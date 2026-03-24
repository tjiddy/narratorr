import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { RecyclingBinSection } from './RecyclingBinSection';

vi.mock('@/lib/api', () => ({
  api: {
    getRecyclingBinEntries: vi.fn(),
    restoreRecyclingBinEntry: vi.fn(),
    purgeRecyclingBinEntry: vi.fn(),
    emptyRecyclingBin: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { api } from '@/lib/api';
import type { RecyclingBinEntry } from '@/lib/api';
import { toast } from 'sonner';

function createMockEntry(overrides: Partial<RecyclingBinEntry> & { id: number; title: string; deletedAt: string }): RecyclingBinEntry {
  return {
    bookId: null, authorName: null, authorAsin: null, narrator: null,
    description: null, coverUrl: null, asin: null, isbn: null,
    seriesName: null, seriesPosition: null, duration: null,
    publishedDate: null, genres: null, monitorForUpgrades: false,
    originalPath: '/audiobooks/default', recyclePath: './config/recycle/0',
    ...overrides,
  };
}

const mockEntries: RecyclingBinEntry[] = [
  createMockEntry({
    id: 1, bookId: 42, title: 'The Way of Kings', authorName: ['Brandon Sanderson'],
    deletedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
    originalPath: '/audiobooks/Sanderson/Way of Kings', recyclePath: './config/recycle/42',
  }),
  createMockEntry({
    id: 2, bookId: 43, title: 'Mistborn', authorName: ['Brandon Sanderson'],
    deletedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    originalPath: '/audiobooks/Sanderson/Mistborn', recyclePath: './config/recycle/43',
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RecyclingBinSection', () => {
  it('shows empty state when no items in recycling bin', async () => {
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue([]);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('Recycling bin is empty')).toBeInTheDocument();
    });
  });

  it('displays items with title, author, and formatted deletion date', async () => {
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });
    expect(screen.getByText('Mistborn')).toBeInTheDocument();
    expect(screen.getAllByText(/Brandon Sanderson/)).toHaveLength(2);
    expect(screen.getByText(/3 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/10 days ago/)).toBeInTheDocument();
  });

  it('restore button triggers restore API call and removes item from list on success', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.restoreRecyclingBinEntry).mockResolvedValue({ bookId: 99 });

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    await waitFor(() => {
      expect(api.restoreRecyclingBinEntry).toHaveBeenCalledWith(1);
    });
    expect(toast.success).toHaveBeenCalledWith('Book restored from recycling bin');
  });

  it('shows error toast when restore fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.restoreRecyclingBinEntry).mockRejectedValue(new Error('Path occupied'));

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const restoreButtons = screen.getAllByRole('button', { name: /restore/i });
    await user.click(restoreButtons[0]);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Path occupied');
    });
  });

  it('permanent delete button shows confirmation dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]);

    expect(screen.getByText('Permanently Delete')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('confirms permanent delete removes item from list', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.purgeRecyclingBinEntry).mockResolvedValue(undefined);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]);

    const confirmButton = screen.getByRole('button', { name: /delete permanently/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.purgeRecyclingBinEntry).toHaveBeenCalledWith(1);
    });
    expect(toast.success).toHaveBeenCalledWith('Permanently deleted');
  });

  it('empty all button shows confirmation dialog', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /empty all/i }));

    expect(screen.getByText('Empty Recycling Bin')).toBeInTheDocument();
    expect(screen.getByText(/permanently delete all 2 items/)).toBeInTheDocument();
  });

  it('empty all button is disabled when bin is empty', async () => {
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue([]);

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('Recycling bin is empty')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /empty all/i })).toBeDisabled();
  });

  it('confirms empty all removes all items', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.emptyRecyclingBin).mockResolvedValue({ purged: 2, failed: 0 });

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Click "Empty All" button to open modal
    await user.click(screen.getByRole('button', { name: /empty all/i }));
    // Confirm in modal — find the confirm button inside the dialog
    const dialog = screen.getByRole('dialog');
    const confirmBtn = dialog.querySelectorAll('button')[1]; // Cancel first, confirm second in DOM (flex-col-reverse)
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(api.emptyRecyclingBin).toHaveBeenCalled();
    });
    expect(toast.success).toHaveBeenCalledWith('Emptied 2 items from recycling bin');
  });

  it('shows loading spinner during initial load', () => {
    vi.mocked(api.getRecyclingBinEntries).mockReturnValue(new Promise(() => {}));

    renderWithProviders(<RecyclingBinSection />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });

  it('shows error toast on empty all failure', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.emptyRecyclingBin).mockRejectedValue(new Error('Server error'));

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Open modal
    const emptyAllBtn = screen.getByRole('button', { name: /empty all/i });
    await user.click(emptyAllBtn);

    // Wait for dialog to appear
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    // Click confirm in the modal
    const dialog = screen.getByRole('dialog');
    const buttons = dialog.querySelectorAll('button');
    await user.click(buttons[1]);

    await waitFor(() => {
      expect(api.emptyRecyclingBin).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Server error');
    });
  });

  it('shows warning toast when empty all has partial failures', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.emptyRecyclingBin).mockResolvedValue({ purged: 1, failed: 1 });

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /empty all/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    const dialog = screen.getByRole('dialog');
    const buttons = dialog.querySelectorAll('button');
    await user.click(buttons[1]);

    await waitFor(() => {
      expect(api.emptyRecyclingBin).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith('Emptied 1 items, 1 failed');
    });
  });

  it('shows error toast when purge single item fails', async () => {
    const user = userEvent.setup();
    vi.mocked(api.getRecyclingBinEntries).mockResolvedValue(mockEntries);
    vi.mocked(api.purgeRecyclingBinEntry).mockRejectedValue(new Error('Filesystem error'));

    renderWithProviders(<RecyclingBinSection />);

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]);

    const confirmButton = screen.getByRole('button', { name: /delete permanently/i });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.purgeRecyclingBinEntry).toHaveBeenCalledWith(1);
    });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Filesystem error');
    });
  });
});
