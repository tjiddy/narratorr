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

  it('empty scan: no books found message', async () => {
    mockApi.scanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/no audiobook folders found/i)).toBeInTheDocument();
    });
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

  it('Register button calls confirmImport', async () => {
    mockApi.confirmImport.mockResolvedValue({ accepted: 1 });
    // Match job fails immediately so isMatching=false and button is enabled
    mockApi.startMatchJob.mockRejectedValue(new Error('match unavailable'));
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

    // Wait for isMatching to settle (startMatchJob rejected)
    await waitFor(() => {
      const registerBtn = screen.getByRole('button', { name: /register/i });
      expect(registerBtn).not.toBeDisabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /register/i }));

    await waitFor(() => {
      expect(mockApi.confirmImport).toHaveBeenCalled();
    });
  });
});
