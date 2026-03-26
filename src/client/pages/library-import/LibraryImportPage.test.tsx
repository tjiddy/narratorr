import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { LibraryImportPage } from './LibraryImportPage';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    api: {
      scanDirectory: vi.fn(),
      confirmImport: vi.fn(),
      startMatchJob: vi.fn(),
      getMatchJob: vi.fn(),
      cancelMatchJob: vi.fn(),
      getSettings: vi.fn(),
      getBookIdentifiers: vi.fn(),
    },
  };
});

const { api } = await import('@/lib/api');
const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const mockSettingsWithPath = createMockSettings({
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
});
const mockSettingsNoPath = createMockSettings({
  library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
});

describe('LibraryImportPage (#133)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi.getSettings.mockResolvedValue(mockSettingsWithPath);
    mockApi.getBookIdentifiers.mockResolvedValue([]);
    mockApi.scanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });
    mockApi.startMatchJob.mockResolvedValue({ jobId: 'job-1' });
    mockApi.getMatchJob.mockResolvedValue({ id: 'job-1', status: 'matching', total: 0, matched: 0, results: [] });
    mockApi.cancelMatchJob.mockResolvedValue({ cancelled: true });
  });

  it('renders page heading', async () => {
    renderWithProviders(<LibraryImportPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /library import/i })).toBeInTheDocument();
    });
  });

  it('no library path: fallback message + Settings link shown', async () => {
    mockApi.getSettings.mockResolvedValue(mockSettingsNoPath);

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/no library path/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('scan fails: inline error message shown with retry CTA', async () => {
    mockApi.scanDirectory.mockRejectedValue(new Error('Permission denied'));

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('empty scan: friendly all-caught-up message shown (not scan error)', async () => {
    mockApi.scanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/already registered/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('scan finds books: review list renders with book count', async () => {
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText('Book One')).toBeInTheDocument();
    });
  });

  it('retry-matching button: clicking it starts a new match job and clears the error card', async () => {
    // First startMatchJob call fails; retry call succeeds
    mockApi.startMatchJob
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue({ jobId: 'job-2' });
    mockApi.getMatchJob.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [] });
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/matching failed/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /retry matching/i }));

    // Error card goes away once startMatching clears the error
    await waitFor(() => {
      expect(screen.queryByText(/matching failed/i)).not.toBeInTheDocument();
    });

    // startMatchJob called twice: initial + retry
    expect(mockApi.startMatchJob).toHaveBeenCalledTimes(2);
  });

  it('match-job failure: inline error shown and Register button disabled', async () => {
    mockApi.startMatchJob.mockRejectedValue(new Error('match server unavailable'));
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/matching failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/match server unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry matching/i })).toBeInTheDocument();

    // Register button must be disabled when matchJobError is set
    const registerBtn = screen.getByRole('button', { name: /register/i });
    expect(registerBtn).toBeDisabled();
  });

  it('existing rows hidden by default, toggle shows them', async () => {
    mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'New Book', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Existing Book', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 2,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText('New Book')).toBeInTheDocument();
    });

    // Duplicate row hidden by default
    expect(screen.queryByText('Existing Book')).not.toBeInTheDocument();

    // Toggle shows them
    const toggleBtn = screen.getByRole('button', { name: /existing.*hidden/i });
    await userEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('Existing Book')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /existing.*shown/i })).toBeInTheDocument();
  });

  // AC3: friendly empty state (#141)
  it('zero discoveries: renders friendly all-caught-up message, no Retry button', async () => {
    mockApi.scanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    // Red error icon should not appear
    expect(screen.queryByText(/no audiobook folders found/i)).not.toBeInTheDocument();
  });

  it('all-duplicate discoveries: renders friendly all-caught-up message (not scan error card)', async () => {
    mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Dup Book', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no audiobook folders found/i)).not.toBeInTheDocument();
  });

  it('mix of new and duplicate discoveries: renders review list, no empty state', async () => {
    mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'New Book', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Dup Book', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 2,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText('New Book')).toBeInTheDocument();
    });
    expect(screen.queryByText(/all caught up|up to date|already registered/i)).not.toBeInTheDocument();
  });

  // AC4: card index map wiring (#141)
  it('toggle card when duplicates hidden: correct source-array row index passed to handleToggle', async () => {
    // 2 rows: index 0 is dup (hidden by default), index 1 is new book
    // When user toggles the new book (which appears first in displayedRows),
    // the underlying rows[1] must be toggled — not rows[0]
    mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorB/Book2', parsedTitle: 'Dup Book', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'New Book', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
      ],
      totalFolders: 2,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText('New Book')).toBeInTheDocument();
    });

    // New Book is selected by default (non-dup); its toggle button shows aria-label="Deselect" (not "Deselect all")
    const toggleBtn = screen.getByRole('button', { name: /^deselect$/i });
    await userEvent.click(toggleBtn);

    // After toggle, the "New Book" row should be deselected
    // The count shows "0 of 1 new selected"
    await waitFor(() => {
      expect(screen.getByText(/0 of 1 new selected/i)).toBeInTheDocument();
    });
  });

  it('Register button calls confirmImport when match job succeeds', async () => {
    mockApi.confirmImport.mockResolvedValue({ accepted: 1 });
    // Completed match job — polling returns 'completed' immediately so isMatching=false
    mockApi.getMatchJob.mockResolvedValue({ id: 'job-1', status: 'completed', total: 1, matched: 1, results: [] });
    mockApi.scanDirectory.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText('Book One')).toBeInTheDocument();
    });

    // Wait for poll to fire (POLL_INTERVAL=2s) and isMatching to settle
    await waitFor(() => {
      const registerBtn = screen.getByRole('button', { name: /register/i });
      expect(registerBtn).not.toBeDisabled();
    }, { timeout: 5000 });

    await userEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => {
      expect(mockApi.confirmImport).toHaveBeenCalled();
    });
  });
});
