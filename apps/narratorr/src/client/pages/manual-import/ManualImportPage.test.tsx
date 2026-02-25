import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualImportPage } from './ManualImportPage';
import type { MatchResult, DiscoveredBook, ScanResult } from '@/lib/api';

// Track match job state for controlled polling
let mockMatchResults: MatchResult[] = [];
let mockIsMatching = false;
let mockStartMatching: ReturnType<typeof vi.fn>;
let mockCancelMatching: ReturnType<typeof vi.fn>;

vi.mock('@/hooks/useMatchJob', () => ({
  useMatchJob: () => ({
    results: mockMatchResults,
    progress: { matched: mockMatchResults.length, total: 0 },
    isMatching: mockIsMatching,
    startMatching: mockStartMatching,
    cancel: mockCancelMatching,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockScanDirectory = vi.fn();
const mockConfirmImport = vi.fn();

const mockBrowseDirectory = vi.fn();
const mockGetSettings = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
      confirmImport: (...args: unknown[]) => mockConfirmImport(...args),
      searchMetadata: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
      browseDirectory: (...args: unknown[]) => mockBrowseDirectory(...args),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
    },
    formatBytes: (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`,
  };
});

vi.mock('@/hooks/useEscapeKey', () => ({
  useEscapeKey: vi.fn(),
}));

vi.mock('@/hooks/useLibrary', () => ({
  useLibrary: () => ({ data: [] }),
}));

function makeDiscoveredBook(overrides?: Partial<DiscoveredBook>): DiscoveredBook {
  return {
    path: '/media/audiobooks/Author/Book Title',
    parsedTitle: 'Book Title',
    parsedAuthor: 'Author Name',
    parsedSeries: null,
    fileCount: 10,
    totalSize: 500000000,
    ...overrides,
  };
}

function makeMatchResult(overrides?: Partial<MatchResult>): MatchResult {
  return {
    path: '/media/audiobooks/Author/Book Title',
    confidence: 'high',
    bestMatch: {
      title: 'Book Title',
      authors: [{ name: 'Author Name' }],
      narrators: ['Jim Dale'],
      asin: 'B001',
      coverUrl: 'https://example.com/cover.jpg',
    },
    alternatives: [],
    ...overrides,
  };
}

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/import']}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
  };
}

function renderPage() {
  const Wrapper = createWrapper();
  return render(<ManualImportPage />, { wrapper: Wrapper });
}

async function scanAndReview(books: DiscoveredBook[] = [makeDiscoveredBook()]) {
  mockScanDirectory.mockResolvedValueOnce({
    discoveries: books,
    totalFolders: books.length,
    skippedDuplicates: 0,
  } satisfies ScanResult);

  const result = renderPage();

  const input = screen.getByPlaceholderText('/path/to/audiobooks');
  await userEvent.type(input, '/media/audiobooks');
  await userEvent.click(screen.getByText('Scan'));

  // Wait for review step
  await screen.findByText(/selected/);

  return result;
}

/**
 * Simulate match results arriving by updating the mock and re-rendering.
 * The useMatchJob mock reads from the module-level `mockMatchResults` on each render.
 */
async function simulateMatchResults(
  rerender: (ui: React.ReactElement) => void,
  results: MatchResult[],
  matching = false,
) {
  mockMatchResults = results;
  mockIsMatching = matching;
  createWrapper();
  rerender(<ManualImportPage />);
  // Allow useEffect to process
  await screen.findByText(/selected/);
}

describe('ManualImportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMatchResults = [];
    mockIsMatching = false;
    mockStartMatching = vi.fn();
    mockCancelMatching = vi.fn();
    mockGetSettings.mockResolvedValue({ library: { path: '/audiobooks', folderFormat: '{author}/{title}' } });
    mockBrowseDirectory.mockResolvedValue({ dirs: ['audiobooks', 'media'], parent: '/' });
  });

  describe('scan step', () => {
    it('shows path input on initial render', () => {
      renderPage();
      expect(screen.getByPlaceholderText('/path/to/audiobooks')).toBeInTheDocument();
      expect(screen.getByText('Scan')).toBeInTheDocument();
    });

    it('disables Scan button when path is empty', () => {
      renderPage();
      expect(screen.getByText('Scan')).toBeDisabled();
    });

    it('enables Scan button when path is entered', async () => {
      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/media');
      expect(screen.getByText('Scan')).toBeEnabled();
    });

    it('shows error when scan finds no books', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [],
        totalFolders: 0,
        skippedDuplicates: 0,
      });

      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/empty');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/No audiobook folders found/);
    });

    it('shows duplicate message when all books are already in library', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [],
        totalFolders: 5,
        skippedDuplicates: 5,
      });

      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/dupes');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/all 5 are already in your library/);
    });

    it('handles Enter key to trigger scan', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [makeDiscoveredBook()],
        totalFolders: 1,
        skippedDuplicates: 0,
      });

      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      await userEvent.type(input, '/media{Enter}');

      await screen.findByText(/selected/);
    });
  });

  describe('review step', () => {
    it('shows all discovered books as rows', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/Book One', parsedTitle: 'Book One' }),
        makeDiscoveredBook({ path: '/a/Book Two', parsedTitle: 'Book Two' }),
      ];
      await scanAndReview(books);

      expect(screen.getByText('Book One')).toBeInTheDocument();
      expect(screen.getByText('Book Two')).toBeInTheDocument();
    });

    it('all rows start selected', async () => {
      await scanAndReview();
      expect(screen.getByText(/1 of 1 selected/)).toBeInTheDocument();
    });

    it('starts matching immediately after scan', async () => {
      await scanAndReview();
      expect(mockStartMatching).toHaveBeenCalledOnce();
    });

    it('shows select-all header with correct count', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/B1', parsedTitle: 'B1' }),
        makeDiscoveredBook({ path: '/a/B2', parsedTitle: 'B2' }),
        makeDiscoveredBook({ path: '/a/B3', parsedTitle: 'B3' }),
      ];
      await scanAndReview(books);
      expect(screen.getByText('3 of 3 selected')).toBeInTheDocument();
    });
  });

  describe('match results merge into rows', () => {
    it('auto-populates edited fields from bestMatch when result arrives', async () => {
      const book = makeDiscoveredBook({ path: '/a/Test', parsedTitle: 'Parsed' });
      const { rerender } = await scanAndReview([book]);

      await simulateMatchResults(rerender, [makeMatchResult({
        path: '/a/Test',
        confidence: 'high',
        bestMatch: {
          title: 'Provider Title',
          authors: [{ name: 'Provider Author' }],
          asin: 'B123',
        },
      })]);

      expect(screen.getByText('Provider Title')).toBeInTheDocument();
    });
  });

  describe('no-match auto-uncheck', () => {
    it('auto-unchecks rows when match result is none', async () => {
      const book = makeDiscoveredBook({ path: '/a/NoMatch', parsedTitle: 'NoMatch' });
      const { rerender } = await scanAndReview([book]);

      expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();

      await simulateMatchResults(rerender, [
        makeMatchResult({ path: '/a/NoMatch', confidence: 'none', bestMatch: null }),
      ]);

      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
    });
  });

  describe('toggle selection', () => {
    it('toggles individual row selection', async () => {
      await scanAndReview();
      expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('Deselect'));
      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
    });

    it('toggle all selects/deselects all rows', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/B1', parsedTitle: 'B1' }),
        makeDiscoveredBook({ path: '/a/B2', parsedTitle: 'B2' }),
      ];
      await scanAndReview(books);
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('Deselect all'));
      expect(screen.getByText('0 of 2 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('Select all'));
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();
    });
  });

  describe('edit modal opens', () => {
    it('opens BookEditModal when pencil icon is clicked', async () => {
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Edit metadata'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Edit Book')).toBeInTheDocument();
    });
  });

  describe('user edits no-match row → confidence promotes and checkbox enables', () => {
    it('auto-checks row and promotes to Review when user picks metadata on no-match row', async () => {
      const book = makeDiscoveredBook({ path: '/a/Fixed', parsedTitle: 'Fixed' });
      const { rerender } = await scanAndReview([book]);

      // Simulate no-match
      await simulateMatchResults(rerender, [makeMatchResult({
        path: '/a/Fixed',
        confidence: 'none',
        bestMatch: null,
        alternatives: [{
          title: 'Correct Title',
          authors: [{ name: 'Real Author' }],
          asin: 'B999',
          providerId: 'alt1',
        }],
      })]);

      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
      expect(screen.getByText('No Match')).toBeInTheDocument();

      // Open modal and click an alternative
      await userEvent.click(screen.getByLabelText('Edit metadata'));
      const dialog = screen.getByRole('dialog');

      const altButton = within(dialog).getByText('Correct Title');
      await userEvent.click(altButton);

      // Save
      await userEvent.click(within(dialog).getByText('Save'));

      // Row should now be checked and confidence promoted to medium
      expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
      expect(screen.getByText('Review')).toBeInTheDocument();
    });

    it('does not auto-check when saving without metadata', async () => {
      const book = makeDiscoveredBook({ path: '/a/Bad', parsedTitle: 'Bad Parse' });
      const { rerender } = await scanAndReview([book]);

      await simulateMatchResults(rerender, [makeMatchResult({
        path: '/a/Bad',
        confidence: 'none',
        bestMatch: null,
        alternatives: [],
      })]);

      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();

      // Open modal and save without picking metadata
      await userEvent.click(screen.getByLabelText('Edit metadata'));
      await userEvent.click(within(screen.getByRole('dialog')).getByText('Save'));

      // Should still be unchecked
      expect(screen.getByText('0 of 1 selected')).toBeInTheDocument();
    });
  });

  describe('import button blocking', () => {
    it('import button disabled when matching in progress', async () => {
      mockIsMatching = true;
      await scanAndReview();

      const btn = screen.getByRole('button', { name: /Import/ });
      expect(btn).toBeDisabled();
    });

    it('import button disabled when no rows selected', async () => {
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Deselect'));
      const btn = screen.getByRole('button', { name: /Import 0/ });
      expect(btn).toBeDisabled();
    });

    it('import button disabled when selected rows have no-match confidence', async () => {
      const book = makeDiscoveredBook({ path: '/a/NoMatch', parsedTitle: 'NoMatch' });
      const { rerender } = await scanAndReview([book]);

      // Manually re-check the row first (user toggles it back on)
      // Then simulate no-match arriving — the row gets unchecked by the effect
      await simulateMatchResults(rerender, [
        makeMatchResult({ path: '/a/NoMatch', confidence: 'none', bestMatch: null }),
      ]);

      // Re-select the no-match row manually
      await userEvent.click(screen.getByLabelText('Select'));

      // Should be selected but still disabled because it's unmatched
      expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();
      const btn = screen.getByRole('button', { name: /Import 1/ });
      expect(btn).toBeDisabled();
    });
  });

  describe('back navigation', () => {
    it('goes back to path step from review', async () => {
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Back'));
      expect(screen.getByPlaceholderText('/path/to/audiobooks')).toBeInTheDocument();
    });

    it('cancels matching when going back', async () => {
      mockIsMatching = true;
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Back'));
      expect(mockCancelMatching).toHaveBeenCalledOnce();
    });

    it('navigates to library from path step', async () => {
      renderPage();
      await userEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/library');
    });
  });

  describe('import execution', () => {
    it('calls confirmImport with selected rows and copy mode', async () => {
      mockConfirmImport.mockResolvedValueOnce({ accepted: 1 });
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);

      // Simulate match completing
      await simulateMatchResults(rerender, [makeMatchResult()]);

      const btn = screen.getByRole('button', { name: /Import 1/ });
      await userEvent.click(btn);

      expect(mockConfirmImport).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ path: '/media/audiobooks/Author/Book Title' }),
        ]),
        'copy',
      );
    });

    it('sends move mode when user switches to Move', async () => {
      mockConfirmImport.mockResolvedValueOnce({ accepted: 1 });
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);

      await simulateMatchResults(rerender, [makeMatchResult()]);

      // Switch to move mode
      await userEvent.selectOptions(screen.getByRole('combobox'), 'move');

      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));

      expect(mockConfirmImport).toHaveBeenCalledWith(
        expect.anything(),
        'move',
      );
    });

    it('passes metadata through from match (no redundant provider lookups)', async () => {
      mockConfirmImport.mockResolvedValueOnce({ accepted: 1 });
      const book = makeDiscoveredBook();
      const bestMatch = {
        title: 'Book Title',
        authors: [{ name: 'Author Name' }],
        narrators: ['Jim Dale'],
        asin: 'B001',
        coverUrl: 'https://example.com/cover.jpg',
      };
      const { rerender } = await scanAndReview([book]);

      await simulateMatchResults(rerender, [makeMatchResult({ bestMatch })]);

      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));

      expect(mockConfirmImport).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            asin: 'B001',
            coverUrl: 'https://example.com/cover.jpg',
            metadata: bestMatch,
          }),
        ]),
        'copy',
      );
    });
  });

  describe('scan error handling', () => {
    it('shows error message when scan API rejects', async () => {
      mockScanDirectory.mockRejectedValueOnce(new Error('Permission denied: /root/audiobooks'));

      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/root/audiobooks');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/Permission denied/);
    });

    it('clears error when user types a new path', async () => {
      mockScanDirectory.mockRejectedValueOnce(new Error('Not found'));

      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      await userEvent.type(input, '/bad');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/Not found/);

      // Typing clears the error
      await userEvent.type(input, '/new');
      expect(screen.queryByText(/Not found/)).not.toBeInTheDocument();
    });

    it('clears stale error when subsequent scan succeeds', async () => {
      // First scan fails
      mockScanDirectory.mockRejectedValueOnce(new Error('Permission denied'));

      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      await userEvent.type(input, '/bad/path');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/Permission denied/);

      // User changes path and scans again — succeeds
      await userEvent.clear(input);
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [makeDiscoveredBook()],
        totalFolders: 1,
        skippedDuplicates: 0,
      });
      await userEvent.type(input, '/good/path');
      await userEvent.click(screen.getByText('Scan'));

      // Error should be cleared, review step visible
      await screen.findByText(/selected/);
      expect(screen.queryByText(/Permission denied/)).not.toBeInTheDocument();
    });
  });

  describe('back resets state', () => {
    it('clears rows and resets to empty when going back to path step', async () => {
      await scanAndReview();
      expect(screen.getByText('1 of 1 selected')).toBeInTheDocument();

      await userEvent.click(screen.getByLabelText('Back'));

      // Now on path step
      expect(screen.getByPlaceholderText('/path/to/audiobooks')).toBeInTheDocument();

      // Scan again with different books
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [
          makeDiscoveredBook({ path: '/new/Book', parsedTitle: 'New Book' }),
          makeDiscoveredBook({ path: '/new/Book2', parsedTitle: 'New Book 2' }),
        ],
        totalFolders: 2,
        skippedDuplicates: 0,
      });

      await userEvent.click(screen.getByText('Scan'));
      await screen.findByText('2 of 2 selected');

      // Old book should be gone
      expect(screen.queryByText('Book Title')).not.toBeInTheDocument();
    });
  });

  describe('directory browser integration', () => {
    it('opens directory browser when folder icon is clicked', async () => {
      renderPage();

      await userEvent.click(screen.getByLabelText('Browse directories'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Browse Directories')).toBeInTheDocument();
    });

    it('populates scan path input when directory is selected', async () => {
      mockBrowseDirectory
        .mockResolvedValueOnce({ dirs: ['projects', 'music'], parent: '/' })
        .mockResolvedValueOnce({ dirs: ['Author1', 'Author2'], parent: '/' });

      renderPage();

      await userEvent.click(screen.getByLabelText('Browse directories'));
      const dialog = await screen.findByRole('dialog');
      await within(dialog).findByText('projects');

      // Navigate into projects
      await userEvent.click(within(dialog).getByText('projects'));
      await within(dialog).findByText('Author1');

      // Select current path
      await userEvent.click(within(dialog).getByRole('button', { name: 'Select' }));

      // Modal should close and path should be populated
      expect(screen.queryByText('Browse Directories')).not.toBeInTheDocument();
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      expect(input.value).toContain('projects');
    });
  });
});
