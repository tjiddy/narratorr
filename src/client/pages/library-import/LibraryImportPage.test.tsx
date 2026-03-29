import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
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
  it('zero discoveries: renders friendly all-caught-up message, no Retry button, no scanning spinner', async () => {
    mockApi.scanDirectory.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    // Scanning spinner must not appear alongside the empty-state panel
    expect(screen.queryByText(/scanning library folder/i)).not.toBeInTheDocument();
    // Red error icon should not appear
    expect(screen.queryByText(/no audiobook folders found/i)).not.toBeInTheDocument();
  });

  it('all-duplicate discoveries: renders friendly all-caught-up message, no scanning spinner', async () => {
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
    // Scanning spinner must not appear alongside the empty-state panel
    expect(screen.queryByText(/scanning library folder/i)).not.toBeInTheDocument();
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

  // AC4: edit callback uses source-row index (#141)
  it('edit metadata when duplicates hidden: correct source-array row index — modal seeded with visible row data', async () => {
    // rows[0] = dup (hidden by default), rows[1] = new book
    // Clicking the only visible Edit metadata button must open modal for rows[1] (New Book)
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

    await userEvent.click(screen.getByRole('button', { name: /edit metadata/i }));

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /edit book metadata/i })).toBeInTheDocument();
    });
    // Modal must be seeded with "New Book" (rows[1]), not "Dup Book" (rows[0])
    expect(screen.getByLabelText('Title')).toHaveValue('New Book');
  });

  describe('deselect-all (#201)', () => {
    it('deselect-all clears selection for all non-duplicate rows; duplicate rows remain unchanged', async () => {
      mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'New Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'New Book 2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/B/B3', parsedTitle: 'Dup Book', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
        ],
        totalFolders: 3,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('New Book 1')).toBeInTheDocument();
      });

      // Initially all non-duplicates are selected: "2 of 2 new selected"
      expect(screen.getByText(/2 of 2 new selected/i)).toBeInTheDocument();

      // Click "Deselect all" button
      const deselectAllBtn = screen.getByRole('button', { name: /deselect all/i });
      await userEvent.click(deselectAllBtn);

      // After deselect-all: "0 of 2 new selected"
      await waitFor(() => {
        expect(screen.getByText(/0 of 2 new selected/i)).toBeInTheDocument();
      });
    });

    it('select-all re-selects all non-duplicate rows after deselect-all', async () => {
      mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book A', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Book B', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 2,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book A')).toBeInTheDocument();
      });

      // Deselect all
      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      await waitFor(() => {
        expect(screen.getByText(/0 of 2 new selected/i)).toBeInTheDocument();
      });

      // Re-select all
      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 new selected/i)).toBeInTheDocument();
      });
    });
  });

  describe('register button states (#201)', () => {
    it('register button shows "Register N book(s)" with correct selectedCount', async () => {
      mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Book 2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 2,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book 1')).toBeInTheDocument();
      });

      // Both books selected by default → "Register 2 books"
      expect(screen.getByRole('button', { name: /register 2 books/i })).toBeInTheDocument();
    });

    it('register button disabled when selectedCount === 0, shows "Register 0 books"', async () => {
      mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book 1')).toBeInTheDocument();
      });

      // Deselect the only book
      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));

      await waitFor(() => {
        const registerBtn = screen.getByRole('button', { name: /register 0 books/i });
        expect(registerBtn).toBeDisabled();
      });
    });

    it('register button disabled when selectedUnmatchedCount > 0 with title showing unmatched count', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'NoMatch', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });
      // Return completed with confidence: none
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'none', bestMatch: null, alternatives: [] }],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('NoMatch')).toBeInTheDocument();
      });

      // Advance to trigger poll — mergeMatchResults auto-deselects confidence=none rows
      await act(async () => { vi.advanceTimersByTime(2000); });

      // Wait for the no-match badge to appear (confirms merge happened)
      await waitFor(() => {
        expect(screen.getByText('1 no match')).toBeInTheDocument();
      });

      // Re-select the unmatched row manually so selectedUnmatchedCount becomes 1
      const selectBtn = screen.getByRole('button', { name: /^select$/i });
      await userEvent.click(selectBtn);

      // Now: selectedCount=1 AND selectedUnmatchedCount=1 → button disabled with title
      await waitFor(() => {
        const registerBtn = screen.getByRole('button', { name: /register 1 book$/i });
        expect(registerBtn).toBeDisabled();
        expect(registerBtn).toHaveAttribute('title', '1 selected book needs a match');
      });

      vi.useRealTimers();
    });

    it('register button shows "Registering..." when registerMutation.isPending', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      // confirmImport never resolves (keeps isPending=true)
      mockApi.confirmImport.mockReturnValue(new Promise(() => {}));
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Book 1', authors: [{ name: 'A' }], asin: 'B001' }, alternatives: [] }],
      });
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book 1')).toBeInTheDocument();
      });

      // Advance to trigger poll and complete matching
      await act(async () => { vi.advanceTimersByTime(2000); });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /register/i })).not.toBeDisabled();
      });

      await userEvent.click(screen.getByRole('button', { name: /register 1 book$/i }));

      await waitFor(() => {
        expect(screen.getByText(/registering\.\.\./i)).toBeInTheDocument();
      });

      vi.useRealTimers();
    });
  });

  describe('manual edit → register flow (#201)', () => {
    it('edited metadata persists through register confirm call', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      mockApi.confirmImport.mockResolvedValue({ accepted: 1 });
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Match Title', authors: [{ name: 'Match Author' }], asin: 'ASIN1', coverUrl: 'http://cover.jpg' }, alternatives: [] }],
      });
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Parsed Title', parsedAuthor: 'Parsed Author', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Parsed Title')).toBeInTheDocument();
      });

      // Advance to trigger poll, which merges match results
      await act(async () => { vi.advanceTimersByTime(2000); });

      // Wait for match result to merge — the title should now show the matched title
      await waitFor(() => {
        expect(screen.getByText('Match Title')).toBeInTheDocument();
      });

      // Open edit modal
      await userEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /edit book metadata/i })).toBeInTheDocument();
      });

      // Edit the title
      const titleInput = screen.getByLabelText('Title');
      await userEvent.clear(titleInput);
      await userEvent.type(titleInput, 'Custom Title');

      // Save the edit
      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      // Modal closes
      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      // Click register
      await userEvent.click(screen.getByRole('button', { name: /register/i }));

      // Verify the confirmImport was called with the edited metadata
      await waitFor(() => {
        expect(mockApi.confirmImport).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({ title: 'Custom Title' }),
          ]),
          undefined,
        );
      });

      vi.useRealTimers();
    });
  });

  describe('summary bar counters (#201)', () => {
    // These tests use fake timers to control the match job poll cycle.
    // Setup: 5 discoveries with different characteristics.

    const fiveBookDiscoveries = {
      discoveries: [
        { path: '/audiobooks/A/B1', parsedTitle: 'High Book', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/A/B2', parsedTitle: 'Medium Book', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/A/B3', parsedTitle: 'NoMatch Book', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/A/B4', parsedTitle: 'Pending Book', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        { path: '/audiobooks/B/B5', parsedTitle: 'Dup Book', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
      ],
      totalFolders: 5,
    };

    it('readyCount = selected + non-duplicate + high confidence', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      mockApi.scanDirectory.mockResolvedValue(fiveBookDiscoveries);
      // Return results for 3 of 4 non-duplicate books (B4 stays pending)
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 4, matched: 3,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'High Book', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/A/B2', confidence: 'medium', bestMatch: { title: 'Medium Book', authors: [{ name: 'A' }], asin: 'A2' }, alternatives: [] },
          { path: '/audiobooks/A/B3', confidence: 'none', bestMatch: null, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('High Book')).toBeInTheDocument();
      });

      await act(async () => { vi.advanceTimersByTime(2000); });

      // readyCount = selected + non-dup + high → only B1 (selected + non-dup + high)
      await waitFor(() => {
        expect(screen.getByText('1 ready')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('reviewCount = all medium confidence rows regardless of selection', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      mockApi.scanDirectory.mockResolvedValue(fiveBookDiscoveries);
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 4, matched: 3,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'High Book', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/A/B2', confidence: 'medium', bestMatch: { title: 'Medium Book', authors: [{ name: 'A' }], asin: 'A2' }, alternatives: [] },
          { path: '/audiobooks/A/B3', confidence: 'none', bestMatch: null, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('High Book')).toBeInTheDocument();
      });

      await act(async () => { vi.advanceTimersByTime(2000); });

      // reviewCount = all medium → 1 (B2) — while B2 is still selected
      await waitFor(() => {
        expect(screen.getByText('1 review')).toBeInTheDocument();
      });

      // After poll: B3 (none) was auto-deselected, so not all are selected.
      // Click "Select all" to select all rows, then "Deselect all" to deselect all.
      // reviewCount must persist through both selection changes.
      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
      });
      // reviewCount = 1 even after re-selecting all
      expect(screen.getByText('1 review')).toBeInTheDocument();

      // Now deselect all — reviewCount must still show 1 (selection-independent)
      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      await waitFor(() => {
        expect(screen.getByText(/0 of \d+ new selected/i)).toBeInTheDocument();
      });
      expect(screen.getByText('1 review')).toBeInTheDocument();

      vi.useRealTimers();
    });

    it('noMatchCount = all none confidence rows', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      mockApi.scanDirectory.mockResolvedValue(fiveBookDiscoveries);
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 4, matched: 3,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'High Book', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/A/B2', confidence: 'medium', bestMatch: { title: 'Medium Book', authors: [{ name: 'A' }], asin: 'A2' }, alternatives: [] },
          { path: '/audiobooks/A/B3', confidence: 'none', bestMatch: null, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('High Book')).toBeInTheDocument();
      });

      await act(async () => { vi.advanceTimersByTime(2000); });

      // noMatchCount = all none → 1 (B3)
      await waitFor(() => {
        expect(screen.getByText('1 no match')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('pendingCount = no matchResult + non-duplicate rows', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

      // Only 2 non-dup books, matching returns result for only 1
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Matched', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Still Pending', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/B/B3', parsedTitle: 'Dup', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
        ],
        totalFolders: 3,
      });
      // Return 'matching' (not completed) with partial results — B2 has no result
      mockApi.getMatchJob.mockResolvedValue({
        id: 'job-1', status: 'matching', total: 2, matched: 1,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Matched', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Matched')).toBeInTheDocument();
      });

      await act(async () => { vi.advanceTimersByTime(2000); });

      // pendingCount = no matchResult + non-dup → 1 (B2 has no match result and is non-dup)
      await waitFor(() => {
        expect(screen.getByText('1 matching')).toBeInTheDocument();
      });

      vi.useRealTimers();
    });

    it('duplicateCount = all isDuplicate rows', async () => {
      mockApi.startMatchJob.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'New', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/B/B2', parsedTitle: 'Dup1', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
          { path: '/audiobooks/B/B3', parsedTitle: 'Dup2', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'slug' },
        ],
        totalFolders: 3,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('New')).toBeInTheDocument();
      });

      // duplicateCount = all isDuplicate → 2 (B2 + B3)
      expect(screen.getByText('2 already in library')).toBeInTheDocument();
    });
  });

  // Polling tests — fake only setInterval/clearInterval to avoid TanStack Query deadlock
  describe('match-job polling (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('Register button enabled after poll resolves with completed job', async () => {
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

      // Advance the setInterval (POLL_INTERVAL=2s) to trigger the first poll
      await act(async () => { vi.advanceTimersByTime(2000); });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /register/i })).not.toBeDisabled();
      });

      await userEvent.click(screen.getByRole('button', { name: /register/i }));

      await waitFor(() => {
        expect(mockApi.confirmImport).toHaveBeenCalled();
      });
    });
  });

  describe('relative path computation (AC1: uses segment-based pathUtils, not startsWith)', () => {
    it('passes relative portion as relativePath prop to ImportCard when book path is inside library root', async () => {
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('AuthorA/Book1')).toBeInTheDocument();
      });
    });

    it('passes undefined as relativePath when book path is a sibling of the library root', async () => {
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks-old/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      // Sibling path: relativePath is undefined, so ImportCard falls back to the last 3 path segments
      await waitFor(() => {
        expect(screen.getByText('audiobooks-old/AuthorB/Book2')).toBeInTheDocument();
      });
    });

    it('passes undefined as relativePath when book path uses .. traversal that escapes library root', async () => {
      // /audiobooks/../secret/Author/Book normalizes to /secret/Author/Book (outside /audiobooks)
      // Old startsWith() bug: '/audiobooks/../secret/Author/Book'.startsWith('/audiobooks/') === true → would show '../secret/Author/Book'
      // Fixed makeRelativePath: normalizes segments → returns undefined → ImportCard falls back to 3-part shortpath
      mockApi.scanDirectory.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/../secret/Author/Book', parsedTitle: 'Secret Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      // Fallback: last 3 segments of raw path = ['secret', 'Author', 'Book'] → 'secret/Author/Book'
      // (NOT '../secret/Author/Book' which the buggy startsWith() code would produce)
      await waitFor(() => {
        expect(screen.getByText('secret/Author/Book')).toBeInTheDocument();
      });
      expect(screen.queryByText('../secret/Author/Book')).not.toBeInTheDocument();
    });

    it('passes undefined as relativePath when library root is not set in settings', async () => {
      mockApi.getSettings.mockResolvedValue(mockSettingsNoPath);

      renderWithProviders(<LibraryImportPage />);

      // No library path → page shows the no-path message; no ImportCards are rendered
      await waitFor(() => {
        expect(screen.getByText(/no library path/i)).toBeInTheDocument();
      });
    });
  });
});
