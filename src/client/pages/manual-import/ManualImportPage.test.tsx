import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ManualImportPage } from './ManualImportPage';
import type { MatchResult, DiscoveredBook, ScanResult } from '@/lib/api';
import type { PausedReason } from '@/hooks/match-recovery';
import type { FolderEntry } from './useFolderHistory.js';
import { wireStagedComplete, summaryResponse, acceptedRow, heldRow, type StagedMockFns } from '@/lib/staged-import/__tests__/staged-fixtures';
import { __resetOutboxCache } from '@/lib/staged-import/outbox';

// Track match job state for controlled polling — fresh per test via makeMatchState().
// Widened to the #1864 paused/recovery contract (paused/reason/remaining/recovering + restart/resume).
type MatchState = {
  results: MatchResult[];
  isMatching: boolean;
  recovering: boolean;
  paused: boolean;
  reason: PausedReason | null;
  remaining: number;
  total: number;
  startMatching: ReturnType<typeof vi.fn>;
  restart: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  cancelMatching: ReturnType<typeof vi.fn>;
};

function makeMatchState(): MatchState {
  return {
    results: [],
    isMatching: false,
    recovering: false,
    paused: false,
    reason: null,
    remaining: 0,
    total: 0,
    startMatching: vi.fn(),
    restart: vi.fn(),
    resume: vi.fn(),
    cancelMatching: vi.fn(),
  };
}

let matchState = makeMatchState();

vi.mock('@/hooks/useMatchJob', () => ({
  useMatchJob: () => ({
    results: matchState.results,
    progress: { matched: matchState.results.length, total: matchState.total },
    isMatching: matchState.isMatching,
    recovering: matchState.recovering,
    paused: matchState.paused,
    reason: matchState.reason,
    remaining: matchState.remaining,
    matchedCount: matchState.results.length,
    total: matchState.total,
    startMatching: matchState.startMatching,
    restart: matchState.restart,
    resume: matchState.resume,
    cancel: matchState.cancelMatching,
  }),
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockScanDirectory = vi.fn();

const mockBrowseDirectory = vi.fn();
const mockGetSettings = vi.fn();
const mockGetImportSubmissionAttention = vi.fn();
const mockListImportSubmissions = vi.fn();
// Staged submit + poll pipeline (#1902).
const mockCreateSubmission = vi.fn();
const mockPutSubmissionItems = vi.fn();
const mockFinalizeSubmission = vi.fn();
const mockGetSubmission = vi.fn();
const mockGetSubmissionByClientId = vi.fn();

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      scanDirectory: (...args: unknown[]) => mockScanDirectory(...args),
      searchMetadata: vi.fn().mockResolvedValue({ books: [], authors: [], series: [] }),
      browseDirectory: (...args: unknown[]) => mockBrowseDirectory(...args),
      getSettings: (...args: unknown[]) => mockGetSettings(...args),
      // #1894 — the last-import panel + attention banner mounted at the page top.
      listImportSubmissions: (...args: unknown[]) => mockListImportSubmissions(...args),
      getImportSubmissionAttention: (...args: unknown[]) => mockGetImportSubmissionAttention(...args),
      getImportSubmissionDetail: vi.fn(),
      discardImportSubmission: vi.fn(),
      // #1902 staged write + poll lane.
      createSubmission: (...args: unknown[]) => mockCreateSubmission(...args),
      putSubmissionItems: (...args: unknown[]) => mockPutSubmissionItems(...args),
      finalizeSubmission: (...args: unknown[]) => mockFinalizeSubmission(...args),
      getSubmission: (...args: unknown[]) => mockGetSubmission(...args),
      getSubmissionByClientId: (...args: unknown[]) => mockGetSubmissionByClientId(...args),
    },
    formatBytes: (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`,
  };
});

const stagedMocks: StagedMockFns = {
  create: mockCreateSubmission, put: mockPutSubmissionItems, finalize: mockFinalizeSubmission,
  get: mockGetSubmission, byClient: mockGetSubmissionByClientId,
};
/** The staged items actually PUT to the server, flattened across chunks. */
const submittedItems = () =>
  mockPutSubmissionItems.mock.calls.flatMap(c => (c[1] as { items: { ordinal: number; item: Record<string, unknown> }[] }).items.map(r => r.item));

vi.mock('@/hooks/useEscapeKey', () => ({
  useEscapeKey: vi.fn(),
}));

// Track folder history state for controlled rendering
let mockFavorites: FolderEntry[] = [];
let mockRecents: FolderEntry[] = [];
const mockAddRecent = vi.fn();
const mockPromoteToFavorite = vi.fn();
const mockDemoteToRecent = vi.fn();
const mockRemoveFavorite = vi.fn();
const mockRemoveRecent = vi.fn();
vi.mock('./useFolderHistory.js', () => ({
  useFolderHistory: () => ({
    favorites: mockFavorites,
    recents: mockRecents,
    addRecent: mockAddRecent,
    promoteToFavorite: mockPromoteToFavorite,
    demoteToRecent: mockDemoteToRecent,
    removeFavorite: mockRemoveFavorite,
    removeRecent: mockRemoveRecent,
  }),
}));

vi.mock('@/hooks/useLibrary', () => ({
  useBookIdentifiers: () => ({ data: [] }),
}));

function makeDiscoveredBook(overrides?: Partial<DiscoveredBook>): DiscoveredBook {
  return {
    path: '/media/audiobooks/Author/Book Title',
    parsedTitle: 'Book Title',
    parsedAuthor: 'Author Name',
    parsedSeries: null,
    fileCount: 10,
    totalSize: 500000000,
    isDuplicate: false,
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
 * The useMatchJob mock reads from the module-level `matchState.results` on each render.
 */
async function simulateMatchResults(
  rerender: (ui: React.ReactElement) => void,
  results: MatchResult[],
  matching = false,
) {
  matchState.results = results;
  matchState.isMatching = matching;
  createWrapper();
  rerender(<ManualImportPage />);
  // Allow useEffect to process
  await screen.findByText(/selected/);
}

describe('ManualImportPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    matchState = makeMatchState();
    mockFavorites = [];
    mockRecents = [];
    mockGetSettings.mockResolvedValue({ library: { path: '/audiobooks', folderFormat: '{author}/{title}' } });
    mockBrowseDirectory.mockResolvedValue({ dirs: ['audiobooks', 'media'], parent: '/' });
    mockGetImportSubmissionAttention.mockResolvedValue({ data: null, watch: false });
    mockListImportSubmissions.mockResolvedValue({ data: [], total: 0 });
    // Staged pipeline (#1902): reset the source-scoped hint and wire a clean submit → poll →
    // detail chain for the standard review book. Tests that assert other outcomes re-wire.
    localStorage.clear();
    __resetOutboxCache();
    wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [acceptedRow(0, '/media/audiobooks/Author/Book Title', 'Book Title')] });
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

    it('disables Scan button when path is whitespace-only', async () => {
      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '   ');
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
      });

      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/empty');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/No audiobook folders found/);
    });

    it('shows review step when all books are already in library (duplicates shown, not hidden)', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [
          makeDiscoveredBook({ isDuplicate: true, existingBookId: 1 }),
          makeDiscoveredBook({ path: '/media/audiobooks/Author/Book2', parsedTitle: 'Book 2', isDuplicate: true, existingBookId: 2 }),
        ],
        totalFolders: 2,
      });

      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/dupes');
      await userEvent.click(screen.getByText('Scan'));

      await screen.findByText(/selected/);
      expect(screen.getByText(/2 already in library/)).toBeInTheDocument();
    });

    it('handles Enter key to trigger scan', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [makeDiscoveredBook()],
        totalFolders: 1,
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
      expect(matchState.startMatching).toHaveBeenCalledOnce();
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

  describe('alternate match selection updates narrator in review card', () => {
    it('selecting an alternate match with a different narrator rerenders the card with the new narrator', async () => {
      const book = makeDiscoveredBook({ path: '/a/HarryPotter', parsedTitle: 'Harry Potter' });
      const { rerender } = await scanAndReview([book]);

      const stephenFryMeta = {
        title: 'Harry Potter',
        authors: [{ name: 'J.K. Rowling' }],
        narrators: ['Stephen Fry'],
        asin: 'B001',
        providerId: 'sfry',
      };
      const jimDaleMeta = {
        title: 'Harry Potter',
        authors: [{ name: 'J.K. Rowling' }],
        narrators: ['Jim Dale'],
        asin: 'B002',
        providerId: 'jdale',
      };

      // Match arrives: best match is Stephen Fry narration; Jim Dale version is an alternative
      await simulateMatchResults(rerender, [makeMatchResult({
        path: '/a/HarryPotter',
        confidence: 'high',
        bestMatch: stephenFryMeta,
        alternatives: [jimDaleMeta],
      })]);

      // Card shows Stephen Fry (wait for mergeMatchResults effect to propagate narrator to edited state)
      await screen.findByText(/Stephen Fry/);

      // User opens edit modal
      await userEvent.click(screen.getByLabelText('Edit metadata'));
      const dialog = screen.getByRole('dialog');

      // Select the Jim Dale alternative from the alternatives list
      const jimDaleButton = within(dialog).getAllByText('Jim Dale')[0]!.closest('button')!;
      await userEvent.click(jimDaleButton);

      // Save
      await userEvent.click(within(dialog).getByText('Save'));

      // Card now shows Jim Dale, not Stephen Fry
      await waitFor(() => {
        expect(screen.getByText(/Jim Dale/)).toBeInTheDocument();
        expect(screen.queryByText(/Stephen Fry/)).not.toBeInTheDocument();
      });
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
      matchState.isMatching = true;
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

    // #1102 — gate is scoped to selection, not the global match-job state
    it('enables import when only a matched row is selected and others are still pending', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/A', parsedTitle: 'Book A' }),
        makeDiscoveredBook({ path: '/a/B', parsedTitle: 'Book B' }),
        makeDiscoveredBook({ path: '/a/C', parsedTitle: 'Book C' }),
      ];
      const { rerender } = await scanAndReview(books);

      // Only Book A returns a match — B and C remain pending. Match job stays in flight.
      await simulateMatchResults(rerender, [
        makeMatchResult({ path: '/a/A', confidence: 'high', bestMatch: { title: 'Book A', authors: [{ name: 'Author' }] } }),
      ], /* matching */ true);

      // Deselect Book B and Book C so only the matched Book A row remains selected.
      // Re-query after each click since the row's button label flips Select<->Deselect.
      const firstDeselects = screen.getAllByLabelText('Deselect');
      await userEvent.click(firstDeselects[1]!);
      const remainingDeselects = screen.getAllByLabelText('Deselect');
      await userEvent.click(remainingDeselects[1]!);
      expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();

      const btn = screen.getByRole('button', { name: /Import 1 book$/ });
      expect(btn).toBeEnabled();
    });

    it('disables import with "still matching" tooltip when selected rows are awaiting a match', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/A', parsedTitle: 'Book A' }),
        makeDiscoveredBook({ path: '/a/B', parsedTitle: 'Book B' }),
      ];
      await scanAndReview(books);

      // No match results have arrived; both rows are selected by default.
      const btn = screen.getByRole('button', { name: /Import 2/ });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', '2 selected books are still matching');
    });

    it('combines tooltip when selection mixes unmatched and pending rows', async () => {
      const books = [
        makeDiscoveredBook({ path: '/a/None', parsedTitle: 'No Match' }),
        makeDiscoveredBook({ path: '/a/Pending', parsedTitle: 'Pending' }),
      ];
      const { rerender } = await scanAndReview(books);

      // Row /a/None comes back as no-match (auto-unchecks). /a/Pending stays pending.
      await simulateMatchResults(rerender, [
        makeMatchResult({ path: '/a/None', confidence: 'none', bestMatch: null }),
      ], /* matching */ true);

      // Re-select the no-match row manually.
      await userEvent.click(screen.getByLabelText('Select'));
      expect(screen.getByText('2 of 2 selected')).toBeInTheDocument();

      const btn = screen.getByRole('button', { name: /Import 2/ });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', '1 selected book needs a match, 1 still matching');
    });
  });

  describe('match-phase recovery banner (#1864)', () => {
    it('surfaces the paused banner on manual import — previously a silent no-op', async () => {
      matchState.paused = true;
      matchState.reason = 'run-expired';
      matchState.remaining = 1;
      matchState.total = 2;

      await scanAndReview();

      expect(screen.getByText(/matching paused/i)).toBeInTheDocument();
      expect(screen.getByText(/matching ended before every book/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /resume remaining/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /restart all/i })).toBeInTheDocument();
    });

    it('Import stays disabled while paused even after deselecting every pending row', async () => {
      // Book A matched (ready), Book B pending. Paused.
      matchState.paused = true;
      matchState.reason = 'run-expired';
      matchState.results = [makeMatchResult({ path: '/a/A', bestMatch: { title: 'Book A', authors: [{ name: 'A' }] } })];
      matchState.total = 2;

      const books = [
        makeDiscoveredBook({ path: '/a/A', parsedTitle: 'Book A' }),
        makeDiscoveredBook({ path: '/a/B', parsedTitle: 'Book B' }),
      ];
      await scanAndReview(books);

      // Deselect the pending Book B — selectedPendingCount would drop to 0, which
      // without the pause gate would enable Import on the matched Book A.
      const deselects = screen.getAllByLabelText('Deselect');
      await userEvent.click(deselects[1]!);

      expect(screen.getByRole('button', { name: /Import/ })).toBeDisabled();
    });

    it('Import stays disabled while recovering (automatic retry/remainder) even after deselecting every pending row (F1)', async () => {
      // recovering=true WITHOUT paused models an automatic retry/remainder in flight.
      matchState.recovering = true;
      matchState.results = [makeMatchResult({ path: '/a/A', bestMatch: { title: 'Book A', authors: [{ name: 'A' }] } })];
      matchState.total = 2;

      const books = [
        makeDiscoveredBook({ path: '/a/A', parsedTitle: 'Book A' }),
        makeDiscoveredBook({ path: '/a/B', parsedTitle: 'Book B' }),
      ];
      await scanAndReview(books);

      // Deselect the pending Book B — without the recovering gate this would enable Import.
      const deselects = screen.getAllByLabelText('Deselect');
      await userEvent.click(deselects[1]!);

      expect(screen.getByRole('button', { name: /Import/ })).toBeDisabled();
    });

    it('Resume/Restart buttons delegate to the hook actions', async () => {
      matchState.paused = true;
      matchState.reason = 'unreachable';
      matchState.total = 1;
      matchState.remaining = 1;

      await scanAndReview();

      await userEvent.click(screen.getByRole('button', { name: /resume remaining/i }));
      expect(matchState.resume).toHaveBeenCalled();
      await userEvent.click(screen.getByRole('button', { name: /restart all/i }));
      expect(matchState.restart).toHaveBeenCalled();
    });
  });

  describe('back navigation', () => {
    it('goes back to path step from review', async () => {
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Back'));
      expect(screen.getByPlaceholderText('/path/to/audiobooks')).toBeInTheDocument();
    });

    it('cancels matching when going back', async () => {
      matchState.isMatching = true;
      await scanAndReview();

      await userEvent.click(screen.getByLabelText('Back'));
      expect(matchState.cancelMatching).toHaveBeenCalledOnce();
    });

    it('navigates to library from path step', async () => {
      renderPage();
      await userEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/library');
    });
  });

  describe('import execution', () => {
    it('creates a staged submission with the selected rows and copy mode', async () => {
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);

      // Simulate match completing
      await simulateMatchResults(rerender, [makeMatchResult()]);

      const btn = screen.getByRole('button', { name: /Import 1/ });
      await userEvent.click(btn);

      await waitFor(() => { expect(mockCreateSubmission).toHaveBeenCalled(); });
      expect(mockCreateSubmission.mock.calls[0]![0]).toMatchObject({ source: 'manual', mode: 'copy' });
      expect(submittedItems()).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/media/audiobooks/Author/Book Title' }),
      ]));
    });

    it('sends move mode when user switches to Move', async () => {
      wireStagedComplete(stagedMocks, { source: 'manual', mode: 'move', items: [acceptedRow(0, '/media/audiobooks/Author/Book Title', 'Book Title')] });
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);

      await simulateMatchResults(rerender, [makeMatchResult()]);

      // Switch to move mode
      await userEvent.selectOptions(screen.getByRole('combobox'), 'move');

      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));

      await waitFor(() => { expect(mockCreateSubmission).toHaveBeenCalled(); });
      expect(mockCreateSubmission.mock.calls[0]![0]).toMatchObject({ mode: 'move' });
    });

    it('passes metadata through from match (no redundant provider lookups)', async () => {
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

      await waitFor(() => { expect(mockCreateSubmission).toHaveBeenCalled(); });
      expect(submittedItems()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          asin: 'B001',
          coverUrl: 'https://example.com/cover.jpg',
          metadata: bestMatch,
        }),
      ]));
    });
  });

  describe('processing progress label (#1902)', () => {
    it('a still-processing poll renders a non-zero "Registering X of Y" label', async () => {
      // The staged upload chunks are small (bounded items), so the live registration progress
      // is driven by the processing poll: expectedCount=2, processedCount=1 → "Registering 1 of 2".
      const books = [
        makeDiscoveredBook({ path: '/a/B1', parsedTitle: 'B1' }),
        makeDiscoveredBook({ path: '/a/B2', parsedTitle: 'B2' }),
      ];
      const { rerender } = await scanAndReview(books);
      await simulateMatchResults(rerender, [
        makeMatchResult({ path: '/a/B1', bestMatch: { title: 'B1', authors: [{ name: 'A' }], asin: 'A1' } }),
        makeMatchResult({ path: '/a/B2', bestMatch: { title: 'B2', authors: [{ name: 'A' }], asin: 'A2' } }),
      ]);

      // create/PUT/finalize resolve, then the summary poll stays in `processing` (never completes)
      // with 1 of 2 processed — the first immediate tick paints the label.
      mockCreateSubmission.mockResolvedValue(summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
      mockPutSubmissionItems.mockResolvedValue(summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'receiving', expectedCount: 2 }));
      mockFinalizeSubmission.mockResolvedValue(summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'processing', expectedCount: 2, processedCount: 0 }));
      mockGetSubmission.mockResolvedValue(summaryResponse({ id: 7, source: 'manual', mode: 'copy', status: 'processing', expectedCount: 2, processedCount: 1 }));

      await userEvent.click(screen.getByRole('button', { name: /Import 2/ }));

      expect(await screen.findByText(/Registering 1 of 2/)).toBeInTheDocument();
      expect(screen.queryByText(/Registering 0 of 2/)).not.toBeInTheDocument();
    });

    it('an in-flight create before any progress keeps the plain "Importing…" pending label', async () => {
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);
      await simulateMatchResults(rerender, [makeMatchResult()]);

      // Deferred create — no chunk/poll progress yet, so the summary bar shows its default label.
      mockCreateSubmission.mockReturnValue(new Promise(() => {}));
      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));

      expect(await screen.findByText(/Importing\.\.\./)).toBeInTheDocument();
      expect(screen.queryByText(/Registering/)).not.toBeInTheDocument();
    });
  });

  describe('held-review panel (#1732)', () => {
    it('renders held titles and a re-confirm button instead of navigating away', async () => {
      wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [heldRow(0, '/media/audiobooks/Author/Book Title', 'Book Title')] });
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);
      await simulateMatchResults(rerender, [makeMatchResult()]);

      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));

      const panel = await screen.findByTestId('held-review-panel');
      expect(within(panel).getByText('Book Title')).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: /re-confirm and import/i })).toBeInTheDocument();
      // The dead-end navigation no longer fires for held results.
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('is absent when there are no held items', async () => {
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);
      await simulateMatchResults(rerender, [makeMatchResult()]);

      expect(screen.queryByTestId('held-review-panel')).not.toBeInTheDocument();
    });

    it('re-confirm resubmits the held row with forceImport=true', async () => {
      wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [heldRow(0, '/media/audiobooks/Author/Book Title', 'Book Title')] });
      const book = makeDiscoveredBook();
      const { rerender } = await scanAndReview([book]);
      await simulateMatchResults(rerender, [makeMatchResult()]);

      await userEvent.click(screen.getByRole('button', { name: /Import 1/ }));
      const panel = await screen.findByTestId('held-review-panel');

      mockPutSubmissionItems.mockClear();
      wireStagedComplete(stagedMocks, { source: 'manual', mode: 'copy', items: [acceptedRow(0, '/media/audiobooks/Author/Book Title', 'Book Title')] });
      await userEvent.click(within(panel).getByRole('button', { name: /re-confirm and import/i }));

      await waitFor(() => {
        expect(submittedItems()).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: '/media/audiobooks/Author/Book Title', forceImport: true }),
        ]));
      });
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
      });

      await userEvent.click(screen.getByText('Scan'));
      await screen.findByText('2 of 2 selected');

      // Old book should be gone
      expect(screen.queryByText('Book Title')).not.toBeInTheDocument();
    });
  });

  describe('directory browser integration', () => {
    it('opens directory browser when Browse button is clicked', async () => {
      renderPage();

      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.getByText('Browse Directories')).toBeInTheDocument();
    });

    it('populates scan path input when directory is selected', async () => {
      mockBrowseDirectory
        .mockResolvedValueOnce({ dirs: ['projects', 'music'], parent: '/' })
        .mockResolvedValueOnce({ dirs: ['Author1', 'Author2'], parent: '/' });

      renderPage();

      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
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

    it('Browse button is clickable and not intercepted by the input field', async () => {
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });

    it('when path field is empty and user opens Browse, the modal seeds from library settings path', async () => {
      renderPage();

      // path starts empty — settings.library.path is '/audiobooks'
      await userEvent.click(screen.getByRole('button', { name: /browse/i }));
      await screen.findByRole('dialog');

      await waitFor(() => {
        expect(mockBrowseDirectory).toHaveBeenCalledWith('/audiobooks');
      });
    });

    it('manually typing a path into the field still works', async () => {
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      await userEvent.type(input, '/my/audiobooks');
      expect(input.value).toBe('/my/audiobooks');
    });

    it('existing form submission behavior is unchanged after PathInput adoption', async () => {
      mockScanDirectory.mockResolvedValue({ books: [], message: undefined });
      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/audio');
      await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
      await waitFor(() => {
        expect(mockScanDirectory).toHaveBeenCalledWith('/audio');
      });
    });
  });

  describe('folder history sections', () => {
    it('shows Favorite Folders and Recent Folders section headers even when lists are empty', () => {
      renderPage();
      expect(screen.getByText('Favorite Folders')).toBeInTheDocument();
      expect(screen.getByText('Recent Folders')).toBeInTheDocument();
      expect(screen.getByText('No favorite folders yet')).toBeInTheDocument();
      expect(screen.getByText('No recent folders yet')).toBeInTheDocument();
    });

    it('shows Favorite Folders and Recent Folders sections with entries', () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      expect(screen.getByText('Favorite Folders')).toBeInTheDocument();
      expect(screen.getByText('Recent Folders')).toBeInTheDocument();
      expect(screen.getByText('/audiobooks')).toBeInTheDocument();
      expect(screen.getByText('/podcasts')).toBeInTheDocument();
    });

    it('clicking a favorite folder entry populates the path input', async () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: '/audiobooks' }));
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      expect(input.value).toBe('/audiobooks');
    });

    it('clicking a recent folder entry populates the path input', async () => {
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: '/podcasts' }));
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      expect(input.value).toBe('/podcasts');
    });

    it('completing a scan adds the scanned path to recent folders', async () => {
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [makeDiscoveredBook()],
        totalFolders: 1,
      } satisfies ScanResult);
      renderPage();
      await userEvent.type(screen.getByPlaceholderText('/path/to/audiobooks'), '/media/audiobooks');
      await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
      await screen.findByText(/selected/);
      expect(mockAddRecent).toHaveBeenCalledWith('/media/audiobooks');
    });

    it('completing a scan on a favorited path also updates recents', async () => {
      mockFavorites = [{ path: '/media/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      mockScanDirectory.mockResolvedValueOnce({
        discoveries: [makeDiscoveredBook()],
        totalFolders: 1,
      } satisfies ScanResult);
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: '/media/audiobooks' }));
      await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
      await screen.findByText(/selected/);
      expect(mockAddRecent).toHaveBeenCalledWith('/media/audiobooks');
    });

    it('renders formatted lastUsedAt date for recent folder entries', () => {
      // 2026-03-05T12:00:00.000Z → "Mar 5, 2026" (toLocaleDateString pattern)
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-03-05T12:00:00.000Z' }];
      renderPage();
      // The formatted date is rendered in a span (shown on hover via group-hover CSS)
      // but it's still in the DOM — assert the text node exists
      const formatted = new Date('2026-03-05T12:00:00.000Z').toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(screen.getByText(formatted)).toBeInTheDocument();
    });

    it('clicking unfavorite button on a favorite demotes it to recent', async () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Unfavorite /audiobooks' }));
      expect(mockDemoteToRecent).toHaveBeenCalledWith('/audiobooks');
    });

    it('clicking remove button on a favorite removes it', async () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Remove favorite /audiobooks' }));
      expect(mockRemoveFavorite).toHaveBeenCalledWith('/audiobooks');
    });

    it('clicking favorite button on a recent promotes it', async () => {
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Favorite /podcasts' }));
      expect(mockPromoteToFavorite).toHaveBeenCalledWith('/podcasts');
    });

    it('clicking remove button on a recent removes it', async () => {
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: 'Remove recent /podcasts' }));
      expect(mockRemoveRecent).toHaveBeenCalledWith('/podcasts');
    });
  });

  describe('folder click clears scan error', () => {
    it('clicking a favorite folder entry clears the scan error', async () => {
      mockScanDirectory.mockRejectedValueOnce(new Error('Permission denied'));
      mockFavorites = [{ path: '/media', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      await userEvent.type(input, '/root/audiobooks');
      await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
      await screen.findByText(/Permission denied/);
      await userEvent.click(screen.getByRole('button', { name: '/media' }));
      expect(screen.queryByText(/Permission denied/)).not.toBeInTheDocument();
    });

    it('clicking a recent folder entry clears the scan error', async () => {
      mockScanDirectory.mockRejectedValueOnce(new Error('Permission denied'));
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      await userEvent.type(input, '/root/audiobooks');
      await userEvent.click(screen.getByRole('button', { name: 'Scan' }));
      await screen.findByText(/Permission denied/);
      await userEvent.click(screen.getByRole('button', { name: '/podcasts' }));
      expect(screen.queryByText(/Permission denied/)).not.toBeInTheDocument();
    });
  });

  describe('path input layout order (#100)', () => {
    it('path input and Scan button render before the Favorite Folders heading in the DOM', () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      const scanBtn = screen.getByRole('button', { name: 'Scan' });
      const favHeading = screen.getByText('Favorite Folders');
      expect(input.compareDocumentPosition(favHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scanBtn.compareDocumentPosition(favHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('path input and Scan button render before the Recent Folders heading in the DOM', () => {
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      const scanBtn = screen.getByRole('button', { name: 'Scan' });
      const recentHeading = screen.getByText('Recent Folders');
      expect(input.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scanBtn.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('with empty favorites and empty recents, path input and Scan button appear before both section headings', () => {
      renderPage();
      const input = screen.getByPlaceholderText('/path/to/audiobooks');
      const scanBtn = screen.getByRole('button', { name: 'Scan' });
      const favHeading = screen.getByText('Favorite Folders');
      const recentHeading = screen.getByText('Recent Folders');
      expect(input.compareDocumentPosition(favHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(input.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scanBtn.compareDocumentPosition(favHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(scanBtn.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('clicking a favorite folder entry still populates the path input after reorder (regression)', async () => {
      mockFavorites = [{ path: '/audiobooks', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: '/audiobooks' }));
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      expect(input.value).toBe('/audiobooks');
    });

    it('clicking a recent folder entry still populates the path input after reorder (regression)', async () => {
      mockRecents = [{ path: '/podcasts', lastUsedAt: '2026-01-02T00:00:00.000Z' }];
      renderPage();
      await userEvent.click(screen.getByRole('button', { name: '/podcasts' }));
      const input = screen.getByPlaceholderText('/path/to/audiobooks') as HTMLInputElement;
      expect(input.value).toBe('/podcasts');
    });
  });

  describe('library root guardrail (#134)', () => {
    describe('path containment detection', () => {
      it('shows warning and disables scan when scan path equals library root exactly', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });

      it('shows warning and disables scan when scan path is a subdirectory of library root', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });

      it('does not show warning when scan path shares a prefix but is not inside library root', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks-old/sub');
        expect(await screen.findByDisplayValue('/audiobooks-old/sub')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });

      it('does not show warning when scan path is completely outside library root', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/media/podcasts');
        expect(await screen.findByDisplayValue('/media/podcasts')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });
    });

    describe('trailing slash and normalization', () => {
      it('detects library containment when library path has no trailing slash and scan path is a subdirectory', async () => {
        mockGetSettings.mockResolvedValue({ library: { path: '/lib', folderFormat: '{author}/{title}' } });
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/lib/sub');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
      });

      it('detects library containment when library path has a trailing slash and scan path is a subdirectory', async () => {
        mockGetSettings.mockResolvedValue({ library: { path: '/lib/', folderFormat: '{author}/{title}' } });
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/lib/sub');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
      });
    });

    describe('all scan path sources (favorites/history)', () => {
      it('shows warning and disables scan when user clicks a favorite folder inside the library root', async () => {
        mockFavorites = [{ path: '/audiobooks/favorites', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
        renderPage();
        await userEvent.click(screen.getByRole('button', { name: '/audiobooks/favorites' }));
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });

      it('shows warning and disables scan when user clicks a recent folder inside the library root', async () => {
        mockRecents = [{ path: '/audiobooks/recents', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
        renderPage();
        await userEvent.click(screen.getByRole('button', { name: '/audiobooks/recents' }));
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });

      it('does not show warning when user clicks a favorite folder outside the library root', async () => {
        mockFavorites = [{ path: '/media/podcasts', lastUsedAt: '2026-01-01T00:00:00.000Z' }];
        renderPage();
        await userEvent.click(screen.getByRole('button', { name: '/media/podcasts' }));
        expect(await screen.findByDisplayValue('/media/podcasts')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });
    });

    describe('Enter-key blocking', () => {
      it('pressing Enter while path is inside library root does not trigger scan', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        await screen.findByText(/This folder is inside your library/);
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(mockScanDirectory).not.toHaveBeenCalled();
      });
    });

    describe('library path not configured or unavailable', () => {
      it('skips guardrail and enables scan when library path is empty string', async () => {
        mockGetSettings.mockResolvedValue({ library: { path: '', folderFormat: '{author}/{title}' } });
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        expect(await screen.findByDisplayValue('/audiobooks/sub')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });

      it('skips guardrail and enables scan when settings query has not resolved yet', async () => {
        mockGetSettings.mockImplementation(() => new Promise(() => {}));
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });

      it('skips guardrail and enables scan when getSettings() rejects with an error', async () => {
        mockGetSettings.mockRejectedValue(new Error('settings unavailable'));
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });
    });

    describe('warning UI', () => {
      it('warning message contains text directing user to Library Import', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
      });

      it('warning message contains a link to /library-import', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        await screen.findByText(/This folder is inside your library/);
        const link = screen.getByRole('link', { name: /library import/i });
        expect(link).toHaveAttribute('href', '/library-import');
      });

      it('scan button is disabled while warning is shown', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        await screen.findByText(/This folder is inside your library/);
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });
    });

    describe('state transitions', () => {
      it('warning disappears and scan re-enables when path changes from inside library to outside', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/audiobooks/sub');
        await screen.findByText(/This folder is inside your library/);
        await userEvent.clear(input);
        await userEvent.type(input, '/media/podcasts');
        expect(await screen.findByDisplayValue('/media/podcasts')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).not.toBeDisabled();
      });

      it('warning appears and scan disables when path changes from outside library to inside', async () => {
        renderPage();
        const input = screen.getByPlaceholderText('/path/to/audiobooks');
        await userEvent.type(input, '/media/podcasts');
        expect(await screen.findByDisplayValue('/media/podcasts')).toBeInTheDocument();
        expect(screen.queryByText(/This folder is inside your library/)).not.toBeInTheDocument();
        await userEvent.clear(input);
        await userEvent.type(input, '/audiobooks/sub');
        expect(await screen.findByText(/This folder is inside your library/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Scan' })).toBeDisabled();
      });
    });
  });
});

describe('ManualImportPage — scanned path display (#284)', () => {
  beforeEach(() => {
    matchState = makeMatchState();
    mockScanDirectory.mockReset();
    mockGetSettings.mockResolvedValue({ library: { path: '/audiobooks' } });
    mockBrowseDirectory.mockResolvedValue({ dirs: [], parent: '/' });
  });

  it('displays scanned directory path after successful scan', async () => {
    await scanAndReview();
    expect(screen.getByText('/media/audiobooks')).toBeInTheDocument();
  });

  it('path text uses muted/secondary styling', async () => {
    await scanAndReview();
    const pathEl = screen.getByText('/media/audiobooks');
    expect(pathEl.className).toMatch(/text-muted-foreground/);
  });

  it('does not display scanned path on path step', () => {
    renderPage();
    expect(screen.queryByText('/media/audiobooks')).not.toBeInTheDocument();
  });

  it('updates displayed path after going back and scanning a different directory', async () => {
    await scanAndReview();
    expect(screen.getByText('/media/audiobooks')).toBeInTheDocument();

    // Go back to path step
    await userEvent.click(screen.getByLabelText('Back'));
    await screen.findByPlaceholderText('/path/to/audiobooks');

    // Scan a different directory
    mockScanDirectory.mockResolvedValueOnce({
      discoveries: [makeDiscoveredBook({ path: '/other/dir/Book', parsedTitle: 'Other Book' })],
      totalFolders: 1,
    });
    const input = screen.getByPlaceholderText('/path/to/audiobooks');
    await userEvent.clear(input);
    await userEvent.type(input, '/other/dir');
    await userEvent.click(screen.getByText('Scan'));
    await screen.findByText(/selected/);

    // Path display should show the new directory
    expect(screen.getByText('/other/dir')).toBeInTheDocument();
    expect(screen.queryByText('/media/audiobooks')).not.toBeInTheDocument();
  });

  describe('attention banner host (#1894, F1/F21)', () => {
    const abandonedManual = {
      id: 7, clientSubmissionId: 'c', source: 'manual' as const, status: 'receiving' as const,
      expectedCount: 3, receivedCount: 1, processedCount: 0,
      aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 }, detailsPruned: false,
      itemsIncluded: false as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      attention: { kind: 'abandoned' as const },
    };

    it('"Import again" from the PATH step stays on path without navigating away (F1)', async () => {
      const user = userEvent.setup();
      mockGetImportSubmissionAttention.mockResolvedValue({ data: abandonedManual, watch: true });
      renderPage();
      // The banner is source-scoped to manual and shows on the path step.
      await waitFor(() => expect(mockGetImportSubmissionAttention).toHaveBeenCalledWith({ source: 'manual' }));
      const banner = await screen.findByTestId('import-attention-banner');
      await user.click(within(banner).getByRole('button', { name: 'Import again' }));
      // Still on the path step (the Scan button is present) and never navigated to /library.
      expect(screen.getByText('Scan')).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalledWith('/library');
    });

    it('"Import again" from the REVIEW step resets to path — review rows clear, no navigation (F38)', async () => {
      const user = userEvent.setup();
      mockGetImportSubmissionAttention.mockResolvedValue({ data: abandonedManual, watch: true });
      await scanAndReview([makeDiscoveredBook()]); // drives the page to the review step
      expect(screen.getByText(/selected/)).toBeInTheDocument(); // review content present
      const banner = await screen.findByTestId('import-attention-banner');
      await user.click(within(banner).getByRole('button', { name: 'Import again' }));
      // Reset lands back on the path step: the Scan button returns and review content clears…
      expect(screen.getByText('Scan')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText(/selected/)).not.toBeInTheDocument());
      // …without navigating away (deletion-proof: a no-op callback would leave review mounted).
      expect(mockNavigate).not.toHaveBeenCalledWith('/library');
    });

    it('mounts the source-scoped last-import PANEL (source=manual) on Manual Import (F36)', async () => {
      const manualSummary = {
        id: 9, clientSubmissionId: 'c', source: 'manual' as const, mode: 'copy' as const, status: 'complete' as const,
        expectedCount: 2, receivedCount: 2, processedCount: 2,
        aggregates: { accepted: 1, held: 1, skipped: 0, failed: 0 }, detailsPruned: false,
        itemsIncluded: false as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      };
      mockListImportSubmissions.mockResolvedValue({ data: [manualSummary], total: 1 });
      renderPage();
      // The panel queries the LATEST manual submission and renders its output.
      await waitFor(() => expect(mockListImportSubmissions).toHaveBeenCalledWith({ source: 'manual', limit: 1 }));
      expect(await screen.findByTestId('last-import-panel')).toBeInTheDocument();
      expect(screen.getByText('1 held')).toBeInTheDocument();
    });
  });
});
