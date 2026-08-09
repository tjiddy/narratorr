import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router';
import { renderWithProviders } from '@/__tests__/helpers';
import { createMockSettings } from '@/__tests__/factories';
import { LibraryImportPage } from './LibraryImportPage';
import { wireStagedComplete, summaryResponse, acceptedRow, heldRow, type StagedMockFns } from '@/lib/staged-import/__tests__/staged-fixtures';
import { __resetOutboxCache } from '@/lib/staged-import/outbox';

// Mock the match timer directly; global fake timers deadlock React Query.
vi.mock('@/hooks/match-timer', async () => {
  const { createMatchTimerMock } = await import('@/__tests__/match-timer-mock');
  return createMatchTimerMock();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    api: {
      scanDirectory: vi.fn(),
      startMatchJob: vi.fn(),
      getMatchJob: vi.fn(),
      cancelMatchJob: vi.fn(),
      getSettings: vi.fn(),
      getBookIdentifiers: vi.fn(),
      listImportSubmissions: vi.fn().mockResolvedValue({ data: [], total: 0 }),
      getImportSubmissionAttention: vi.fn().mockResolvedValue({ data: null, watch: false }),
      getImportSubmissionDetail: vi.fn(),
      discardImportSubmission: vi.fn(),
      createImportSubmission: vi.fn(),
      putImportSubmissionItems: vi.fn(),
      finalizeImportSubmission: vi.fn(),
      getImportSubmission: vi.fn(),
      getImportSubmissionByClientId: vi.fn(),
    },
  };
});

const { api, ApiError } = await import('@/lib/api');
const mockApi = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const stagedMocks = {
  create: mockApi.createImportSubmission!, put: mockApi.putImportSubmissionItems!, finalize: mockApi.finalizeImportSubmission!,
  get: mockApi.getImportSubmission!, byClient: mockApi.getImportSubmissionByClientId!,
} as unknown as StagedMockFns;
const submittedItems = () =>
  mockApi.putImportSubmissionItems!.mock.calls.flatMap(c => (c[1] as { items: { ordinal: number; item: Record<string, unknown> }[] }).items.map(r => r.item));

const matchTimer = await import('@/hooks/match-timer');
const engineClock = matchTimer as unknown as import('@/__tests__/match-timer-mock').MatchTimerMock;
async function firePoll(): Promise<void> {
  await waitFor(() => expect(engineClock.__pending()).toBeGreaterThan(0));
  await act(async () => { engineClock.__flushNext(); });
}

// Without Routes, navigation leaves the page mounted; expose pathname so tests can detect it.
function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location">{pathname}</div>;
}

const mockSettingsWithPath = createMockSettings({
  library: { path: '/audiobooks', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
});
const mockSettingsNoPath = createMockSettings({
  library: { path: '', folderFormat: '{author}/{title}', fileFormat: '{author} - {title}' },
});

describe('LibraryImportPage (#133)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    engineClock.__reset();
    mockApi.getSettings!.mockResolvedValue(mockSettingsWithPath);
    mockApi.getBookIdentifiers!.mockResolvedValue([]);
    mockApi.scanDirectory!.mockResolvedValue({ discoveries: [], totalFolders: 0 });
    mockApi.startMatchJob!.mockResolvedValue({ jobId: 'job-1' });
    mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'matching', total: 0, matched: 0, results: [] });
    mockApi.cancelMatchJob!.mockResolvedValue({ cancelled: true });
    // Default to a complete staged pipeline; failure tests override individual calls.
    localStorage.clear();
    __resetOutboxCache();
    wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/New Book', 'New Book')] });
  });

  it('renders page heading', async () => {
    renderWithProviders(<LibraryImportPage />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /library import/i })).toBeInTheDocument();
    });
  });

  it('no library path: fallback message + Settings link shown', async () => {
    mockApi.getSettings!.mockResolvedValue(mockSettingsNoPath);

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/no library path/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  });

  it('scan fails: inline error message shown with retry CTA', async () => {
    mockApi.scanDirectory!.mockRejectedValue(new Error('Permission denied'));

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/permission denied/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('empty scan: friendly all-caught-up message shown (not scan error)', async () => {
    mockApi.scanDirectory!.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/already imported/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('scan finds books: review list renders with book count', async () => {
    mockApi.scanDirectory!.mockResolvedValue({
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

  it('Resume-remaining: clicking it starts a new match job and clears the paused banner (#1864)', async () => {
    mockApi.startMatchJob!
      .mockRejectedValueOnce(new Error('transient error'))
      .mockResolvedValue({ jobId: 'job-2' });
    mockApi.getMatchJob!.mockResolvedValue({ id: 'job-2', status: 'completed', total: 1, matched: 1, results: [] });
    mockApi.scanDirectory!.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/matching paused/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /resume remaining/i }));

    await waitFor(() => {
      expect(screen.queryByText(/matching paused/i)).not.toBeInTheDocument();
    });

    expect(mockApi.startMatchJob).toHaveBeenCalledTimes(2);
  });

  it('match-job start failure: paused banner (reason-mapped copy) and Import disabled (#1864)', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('match server unavailable'));
    mockApi.scanDirectory!.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
      ],
      totalFolders: 1,
    });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/matching paused/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/couldn't start matching/i)).toBeInTheDocument();
    expect(screen.queryByText(/match server unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume remaining/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /import/i })).toBeDisabled();
  });

  it('paused-gate relaxation: Import disabled with a selected pending row, ENABLED after deselecting it (#1895)', async () => {
    mockApi.scanDirectory!.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/A/B1', parsedTitle: 'B1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
        { path: '/audiobooks/A/B2', parsedTitle: 'B2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
      totalFolders: 2,
    });
    const b1 = { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'B1', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] };
    mockApi.getMatchJob!
      .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 2, matched: 1, results: [b1] })
      .mockRejectedValue(new (await import('@/lib/api')).ApiError(400, { error: 'bad' }));

    renderWithProviders(<LibraryImportPage />);
    await waitFor(() => { expect(screen.getByText('B1')).toBeInTheDocument(); });
    await firePoll();
    await firePoll();

    await waitFor(() => { expect(screen.getByText(/matching paused/i)).toBeInTheDocument(); });

    const importBtn = screen.getByRole('button', { name: /import/i });
    expect(importBtn).toBeDisabled();
    expect(importBtn).toHaveAttribute('title', '1 selected book is paused');

    await userEvent.click(screen.getAllByLabelText('Deselect')[1]!);

    await waitFor(() => { expect(screen.getByRole('button', { name: /import/i })).toBeEnabled(); });
  });

  it('unconditional fail-closed: Import stays disabled during AUTOMATIC recovery (recovering, not paused) after deselecting the pending row (#1864 F10)', async () => {
    const ApiError = (await import('@/lib/api')).ApiError;
    mockApi.scanDirectory!.mockResolvedValue({
      discoveries: [
        { path: '/audiobooks/A/B1', parsedTitle: 'B1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
        { path: '/audiobooks/A/B2', parsedTitle: 'B2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false },
      ],
      totalFolders: 2,
    });
    mockApi.startMatchJob!.mockReset();
    mockApi.startMatchJob!.mockResolvedValueOnce({ jobId: 'job-1' }).mockResolvedValue({ jobId: 'job-2' });
    const b1 = { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'B1', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] };
    mockApi.getMatchJob!.mockReset();
    mockApi.getMatchJob!
      .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 2, matched: 1, results: [b1] })
      .mockRejectedValueOnce(new ApiError(404, { error: 'gone' }))
      .mockResolvedValue({ id: 'job-2', status: 'matching', total: 2, matched: 0, results: [] });

    renderWithProviders(<LibraryImportPage />);
    await waitFor(() => { expect(screen.getByText('B1')).toBeInTheDocument(); });
    await firePoll();
    await firePoll();

    await waitFor(() => { expect(mockApi.startMatchJob).toHaveBeenCalledTimes(2); });
    expect(screen.queryByText(/matching paused/i)).not.toBeInTheDocument();

    await waitFor(() => { expect(screen.getAllByLabelText('Deselect')).toHaveLength(2); });
    await userEvent.click(screen.getAllByLabelText('Deselect')[1]!);

    expect(screen.getByRole('button', { name: /import/i })).toBeDisabled();
  });

  describe('paused-subset import (#1895)', () => {
    const disc = (path: string, title: string, over: Record<string, unknown> = {}) =>
      ({ path, parsedTitle: title, parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 1, isDuplicate: false, ...over });
    const highResult = (path: string, title: string) =>
      ({ path, confidence: 'high', bestMatch: { title, authors: [{ name: 'A' }], asin: path }, alternatives: [] });

    async function renderPaused(extra: ReturnType<typeof disc>[], probe = false) {
      mockApi.scanDirectory!.mockResolvedValue({ discoveries: [disc('/audiobooks/A/B1', 'B1'), ...extra], totalFolders: 1 + extra.length });
      mockApi.getMatchJob!
        .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 1 + extra.length, matched: 1, results: [highResult('/audiobooks/A/B1', 'B1')] })
        .mockRejectedValue(new ApiError(400, { error: 'bad' }));
      renderWithProviders(probe ? <><LibraryImportPage /><LocationProbe /></> : <LibraryImportPage />, { route: '/library-import' });
      await waitFor(() => { expect(screen.getByText('B1')).toBeInTheDocument(); });
      await firePoll();
      await firePoll();
      await waitFor(() => { expect(screen.getByText(/matching paused/i)).toBeInTheDocument(); });
    }

    it('paused with a fully-matched selection (no pending selected) → Import enabled', async () => {
      mockApi.scanDirectory!.mockResolvedValue({ discoveries: [disc('/audiobooks/A/B1', 'B1'), disc('/audiobooks/A/B2', 'B2')], totalFolders: 2 });
      mockApi.getMatchJob!
        .mockResolvedValueOnce({ id: 'job-1', status: 'matching', total: 2, matched: 2, results: [highResult('/audiobooks/A/B1', 'B1'), highResult('/audiobooks/A/B2', 'B2')] })
        .mockRejectedValue(new ApiError(400, { error: 'bad' }));
      renderWithProviders(<LibraryImportPage />, { route: '/library-import' });
      await waitFor(() => { expect(screen.getByText('B1')).toBeInTheDocument(); });
      await firePoll();
      await firePoll();
      await waitFor(() => { expect(screen.getByText(/matching paused/i)).toBeInTheDocument(); });

      expect(screen.getByRole('button', { name: /import 2 books/i })).toBeEnabled();
    });

    it('deselect-pending affordance clears pending rows, keeps matched, and flips Import enabled', async () => {
      await renderPaused([disc('/audiobooks/A/B2', 'B2')]);

      expect(screen.getByRole('button', { name: /import/i })).toBeDisabled();
      const affordance = screen.getByRole('button', { name: /deselect 1 pending/i });
      await userEvent.click(affordance);

      await waitFor(() => { expect(screen.getByText(/1 of 2 new selected/i)).toBeInTheDocument(); });
      expect(screen.getByRole('button', { name: /import 1 book$/i })).toBeEnabled();
      expect(screen.queryByRole('button', { name: /deselect \d+ pending/i })).not.toBeInTheDocument();
    });

    it('deselect-pending affordance is absent when NOT paused', async () => {
      mockApi.scanDirectory!.mockResolvedValue({ discoveries: [disc('/audiobooks/A/B1', 'B1'), disc('/audiobooks/A/B2', 'B2')], totalFolders: 2 });
      mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'matching', total: 2, matched: 1, results: [highResult('/audiobooks/A/B1', 'B1')] });
      renderWithProviders(<LibraryImportPage />, { route: '/library-import' });
      await waitFor(() => { expect(screen.getByText('B1')).toBeInTheDocument(); });
      await firePoll();
      await waitFor(() => { expect(screen.getByText('1 matching')).toBeInTheDocument(); });

      expect(screen.queryByRole('button', { name: /deselect \d+ pending/i })).not.toBeInTheDocument();
    });

    it('deselect-pending affordance is absent when paused with no selected pending rows', async () => {
      await renderPaused([disc('/audiobooks/A/B2', 'B2')]);
      await userEvent.click(screen.getAllByLabelText('Deselect')[1]!);
      await waitFor(() => { expect(screen.queryByRole('button', { name: /deselect \d+ pending/i })).not.toBeInTheDocument(); });
    });

    it('F5: affordance clears the actionable former within-scan pending row, leaving the DB duplicate (canonical helper)', async () => {
      await renderPaused([
        disc('/audiobooks/A/WS', 'WS', { isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' }),
        disc('/audiobooks/A/DB', 'DB', { isDuplicate: true, duplicateReason: 'slug' }),
      ]);

      await waitFor(() => { expect(screen.getByText(/2 of 2 new selected/i)).toBeInTheDocument(); });
      await userEvent.click(screen.getByRole('button', { name: /deselect 1 pending/i }));

      await waitFor(() => { expect(screen.getByText(/1 of 2 new selected/i)).toBeInTheDocument(); });
      expect(screen.getByRole('button', { name: /import 1 book$/i })).toBeEnabled();
    });

    it('paused visual: genuinely-new pending row shows "Paused" (no spinner) and the summary shows "{n} paused"', async () => {
      await renderPaused([disc('/audiobooks/A/B2', 'B2')]);

      const badge = screen.getByText('Paused');
      expect(badge).toBeInTheDocument();
      expect(badge.querySelector('svg')).toBeNull();
      const segment = screen.getByText('1 paused');
      expect(segment).toBeInTheDocument();
      expect(screen.queryByText('1 matching')).not.toBeInTheDocument();
      expect(segment.querySelector('svg')).toBeNull();
    });

    it('F9: a paused result-less former within-scan row shows the normal "Paused" badge + review hint (#1925)', async () => {
      await renderPaused([disc('/audiobooks/A/WS', 'WS', { isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' })]);

      expect(screen.queryByText('Duplicate in scan')).not.toBeInTheDocument();
      expect(screen.getByTestId('review-reason-indicator')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(screen.getByText('1 paused')).toBeInTheDocument();
    });

    it('clean paused-subset import stays on the page, deselects the accepted row in place, and preserves the paused run (F1/F12)', async () => {
      wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/A/B1', 'B1')] });
      await renderPaused([disc('/audiobooks/A/B2', 'B2')], /* probe */ true);
      expect(screen.getByTestId('location')).toHaveTextContent('/library-import');

      await userEvent.click(screen.getAllByLabelText('Deselect')[1]!);
      await waitFor(() => { expect(screen.getByRole('button', { name: /import 1 book$/i })).toBeEnabled(); });

      expect(screen.getByText(/Matching paused — 1 of 2 books remaining\./i)).toBeInTheDocument();

      const cancelCallsBefore = mockApi.cancelMatchJob!.mock.calls.length;
      const startCallsBefore = mockApi.startMatchJob!.mock.calls.length;
      await userEvent.click(screen.getByRole('button', { name: /import 1 book$/i }));

      await waitFor(() => { expect(screen.getByText(/0 of 2 new selected/i)).toBeInTheDocument(); });
      expect(screen.getByTestId('location')).toHaveTextContent('/library-import');
      expect(mockApi.cancelMatchJob!.mock.calls.length).toBe(cancelCallsBefore);
      expect(screen.getByText(/Matching paused — 1 of 2 books remaining\./i)).toBeInTheDocument();
      expect(screen.getByText('Matched')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
      expect(mockApi.startMatchJob!.mock.calls.length).toBe(startCallsBefore);

      mockApi.getMatchJob!.mockRejectedValue(new ApiError(404, { error: 'gone' }));
      await userEvent.click(screen.getByRole('button', { name: /resume remaining/i }));

      await waitFor(() => { expect(mockApi.startMatchJob!.mock.calls.length).toBe(startCallsBefore + 1); });
      const resumeCandidates = mockApi.startMatchJob!.mock.calls[startCallsBefore]![0] as Array<{ path: string }>;
      expect(resumeCandidates.map((c) => c.path)).toEqual(['/audiobooks/A/B2']);
      expect(screen.getByText('Matched')).toBeInTheDocument();
    });
  });

  it('existing rows hidden by default, toggle shows them', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory!.mockResolvedValue({
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

    expect(screen.queryByText('Existing Book')).not.toBeInTheDocument();

    const toggleBtn = screen.getByRole('button', { name: /existing.*hidden/i });
    await userEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('Existing Book')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /existing.*shown/i })).toBeInTheDocument();
  });

  it('zero discoveries: renders friendly all-caught-up message, no Retry button, no scanning spinner', async () => {
    mockApi.scanDirectory!.mockResolvedValue({ discoveries: [], totalFolders: 0 });

    renderWithProviders(<LibraryImportPage />);

    await waitFor(() => {
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/scanning library folder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no audiobook folders found/i)).not.toBeInTheDocument();
  });

  it('all-duplicate discoveries: renders friendly all-caught-up message, no scanning spinner', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory!.mockResolvedValue({
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
    expect(screen.queryByText(/scanning library folder/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no audiobook folders found/i)).not.toBeInTheDocument();
  });

  it('mix of new and duplicate discoveries: renders review list, no empty state', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory!.mockResolvedValue({
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
    expect(screen.queryByText(/all caught up|up to date|already imported/i)).not.toBeInTheDocument();
  });

  it('toggle card when duplicates hidden: correct source-array row index passed to handleToggle', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory!.mockResolvedValue({
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

    const toggleBtn = screen.getByRole('button', { name: /^deselect$/i });
    await userEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText(/0 of 1 new selected/i)).toBeInTheDocument();
    });
  });

  it('edit metadata when duplicates hidden: correct source-array row index — modal seeded with visible row data', async () => {
    mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
    mockApi.scanDirectory!.mockResolvedValue({
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
      expect(screen.getByRole('dialog', { name: /edit book/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Title')).toHaveValue('New Book');
  });

  describe('deselect-all (#201)', () => {
    it('deselect-all clears selection for all non-duplicate rows; duplicate rows remain unchanged', async () => {
      mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory!.mockResolvedValue({
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

      expect(screen.getByText(/2 of 2 new selected/i)).toBeInTheDocument();

      const deselectAllBtn = screen.getByRole('button', { name: /deselect all/i });
      await userEvent.click(deselectAllBtn);

      await waitFor(() => {
        expect(screen.getByText(/0 of 2 new selected/i)).toBeInTheDocument();
      });
    });

    it('select-all re-selects all non-duplicate rows after deselect-all', async () => {
      mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory!.mockResolvedValue({
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

      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      await waitFor(() => {
        expect(screen.getByText(/0 of 2 new selected/i)).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      await waitFor(() => {
        expect(screen.getByText(/2 of 2 new selected/i)).toBeInTheDocument();
      });
    });
  });

  describe('import button states (#201)', () => {
    it('import button shows "Import N book(s)" with correct selectedCount', async () => {
      mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory!.mockResolvedValue({
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

      expect(screen.getByRole('button', { name: /import 2 books/i })).toBeInTheDocument();
    });

    it('import button disabled when selectedCount === 0, shows "Import 0 books"', async () => {
      mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book 1')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));

      await waitFor(() => {
        const registerBtn = screen.getByRole('button', { name: /import 0 books/i });
        expect(registerBtn).toBeDisabled();
      });
    });

    it('import button disabled when selectedUnmatchedCount > 0 with title showing unmatched count', async () => {

      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'NoMatch', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'none', bestMatch: null, alternatives: [] }],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('NoMatch')).toBeInTheDocument();
      });

      await firePoll();

      await waitFor(() => {
        expect(screen.getByText('1 no match')).toBeInTheDocument();
      });

      const selectBtn = screen.getByRole('button', { name: /^select$/i });
      await userEvent.click(selectBtn);

      await waitFor(() => {
        const registerBtn = screen.getByRole('button', { name: /import 1 book$/i });
        expect(registerBtn).toBeDisabled();
        expect(registerBtn).toHaveAttribute('title', '1 selected book needs a match');
      });

    });

    it('enables import when only a matched row is selected and others are still pending', async () => {

      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Matched', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Other Matched', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B3', parsedTitle: 'Still Pending', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 3,
      });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'matching', total: 3, matched: 2,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Matched', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/A/B2', confidence: 'high', bestMatch: { title: 'Other Matched', authors: [{ name: 'A' }], asin: 'A2' }, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => { expect(screen.getByText('Matched')).toBeInTheDocument(); });
      await firePoll();

      await waitFor(() => { expect(screen.getByText('2 ready')).toBeInTheDocument(); });

      const deselects = screen.getAllByRole('button', { name: /^deselect$/i });
      await userEvent.click(deselects[1]!);
      const remainingDeselects = screen.getAllByRole('button', { name: /^deselect$/i });
      await userEvent.click(remainingDeselects[1]!);

      await waitFor(() => { expect(screen.getByText(/1 of 3 new selected/i)).toBeInTheDocument(); });

      const registerBtn = screen.getByRole('button', { name: /import 1 book$/i });
      expect(registerBtn).toBeEnabled();

    });

    it('import button shows "Importing..." when registerMutation.isPending', async () => {

      mockApi.createImportSubmission!.mockReturnValue(new Promise(() => {}));
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Book 1', authors: [{ name: 'A' }], asin: 'B001' }, alternatives: [] }],
      });
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book 1')).toBeInTheDocument();
      });

      await firePoll();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /import/i })).not.toBeDisabled();
      });

      await userEvent.click(screen.getByRole('button', { name: /import 1 book$/i }));

      await waitFor(() => {
        expect(screen.getByText(/importing\.\.\./i)).toBeInTheDocument();
      });

    });
  });

  describe('manual edit → import flow (#201)', () => {
    it('edited metadata persists through import confirm call', async () => {

      wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/A/B1', 'Custom Title')] });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Match Title', authors: [{ name: 'Match Author' }], asin: 'ASIN1', coverUrl: 'http://cover.jpg' }, alternatives: [] }],
      });
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Parsed Title', parsedAuthor: 'Parsed Author', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Parsed Title')).toBeInTheDocument();
      });

      await firePoll();

      await waitFor(() => {
        expect(screen.getByText('Match Title')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /edit metadata/i }));
      await waitFor(() => {
        expect(screen.getByRole('dialog', { name: /edit book/i })).toBeInTheDocument();
      });

      const titleInput = screen.getByLabelText('Title');
      await userEvent.clear(titleInput);
      await userEvent.type(titleInput, 'Custom Title');

      await userEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /import/i }));

      await waitFor(() => { expect(mockApi.createImportSubmission).toHaveBeenCalled(); });
      expect(mockApi.createImportSubmission!.mock.calls[0]![0]).not.toHaveProperty('mode');
      expect(submittedItems()).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'Custom Title' }),
      ]));

    });
  });

  describe('held-review panel (#1711)', () => {
    it('renders held items and re-confirms them with forceImport=true', async () => {
      const user = userEvent.setup();

      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Held Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Held Book', authors: [{ name: 'Author' }], asin: 'ASIN1' }, alternatives: [] }],
      });
      wireStagedComplete(stagedMocks, { source: 'library', items: [heldRow(0, '/audiobooks/A/B1', 'Held Book')] });

      renderWithProviders(<LibraryImportPage />);
      await waitFor(() => expect(screen.getByText('Held Book')).toBeInTheDocument());

      await firePoll();
      await waitFor(() => expect(screen.getByRole('button', { name: /import 1 book/i })).toBeEnabled());

      await user.click(screen.getByRole('button', { name: /import 1 book/i }));

      const panel = await screen.findByTestId('held-review-panel');
      expect(within(panel).getByText('Held Book')).toBeInTheDocument();
      const reconfirmBtn = within(panel).getByRole('button', { name: /re-confirm and import/i });

      mockApi.putImportSubmissionItems!.mockClear();
      wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/A/B1', 'Held Book')] });
      await user.click(reconfirmBtn);

      await waitFor(() => {
        expect(submittedItems()).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: '/audiobooks/A/B1', forceImport: true }),
        ]));
      });

    });
  });

  describe('summary bar counters (#201)', () => {
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

      mockApi.scanDirectory!.mockResolvedValue(fiveBookDiscoveries);
      mockApi.getMatchJob!.mockResolvedValue({
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

      await firePoll();
      await waitFor(() => {
        expect(screen.getByText('1 ready')).toBeInTheDocument();
      });

    });

    it('reviewCount = all medium confidence rows regardless of selection', async () => {

      mockApi.scanDirectory!.mockResolvedValue(fiveBookDiscoveries);
      mockApi.getMatchJob!.mockResolvedValue({
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

      await firePoll();
      await waitFor(() => {
        expect(screen.getByText('1 review')).toBeInTheDocument();
      });

      await userEvent.click(screen.getByRole('button', { name: /select all/i }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /deselect all/i })).toBeInTheDocument();
      });
      expect(screen.getByText('1 review')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: /deselect all/i }));
      await waitFor(() => {
        expect(screen.getByText(/0 of \d+ new selected/i)).toBeInTheDocument();
      });
      expect(screen.getByText('1 review')).toBeInTheDocument();

    });

    it('noMatchCount = all none confidence rows', async () => {

      mockApi.scanDirectory!.mockResolvedValue(fiveBookDiscoveries);
      mockApi.getMatchJob!.mockResolvedValue({
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

      await firePoll();
      await waitFor(() => {
        expect(screen.getByText('1 no match')).toBeInTheDocument();
      });

    });

    it('pendingCount = no matchResult + non-duplicate rows', async () => {

      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Matched', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Still Pending', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/B/B3', parsedTitle: 'Dup', parsedAuthor: 'B', parsedSeries: null, fileCount: 1, totalSize: 40000, isDuplicate: true, duplicateReason: 'path' },
        ],
        totalFolders: 3,
      });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'matching', total: 2, matched: 1,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Matched', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
        ],
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Matched')).toBeInTheDocument();
      });

      await firePoll();
      await waitFor(() => {
        expect(screen.getByText('1 matching')).toBeInTheDocument();
      });

    });

    it('duplicateCount = all isDuplicate rows', async () => {
      mockApi.startMatchJob!.mockRejectedValue(new Error('skip'));
      mockApi.scanDirectory!.mockResolvedValue({
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

      expect(screen.getByText('2 already in library')).toBeInTheDocument();
    });
  });

  describe('match-job polling (deterministic engine clock)', () => {
    it('Import button enabled after poll resolves with completed job', async () => {
      wireStagedComplete(stagedMocks, { source: 'library', items: [acceptedRow(0, '/audiobooks/AuthorA/Book1', 'Book One')] });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 1, matched: 1,
        results: [{ path: '/audiobooks/AuthorA/Book1', confidence: 'high', bestMatch: { title: 'Book One', authors: [{ name: 'Author A' }], asin: 'A1' }, alternatives: [] }],
      });
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/AuthorA/Book1', parsedTitle: 'Book One', parsedAuthor: 'Author A', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('Book One')).toBeInTheDocument();
      });
      await firePoll();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /import/i })).not.toBeDisabled();
      });

      await userEvent.click(screen.getByRole('button', { name: /import/i }));

      await waitFor(() => {
        expect(mockApi.createImportSubmission).toHaveBeenCalled();
      });
    });
  });

  describe('processing progress label (#1902)', () => {
    it('a still-processing poll renders a non-zero "Registering X of Y" label', async () => {
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/A/B1', parsedTitle: 'Book 1', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
          { path: '/audiobooks/A/B2', parsedTitle: 'Book 2', parsedAuthor: 'A', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 2,
      });
      mockApi.getMatchJob!.mockResolvedValue({
        id: 'job-1', status: 'completed', total: 2, matched: 2,
        results: [
          { path: '/audiobooks/A/B1', confidence: 'high', bestMatch: { title: 'Book 1', authors: [{ name: 'A' }], asin: 'A1' }, alternatives: [] },
          { path: '/audiobooks/A/B2', confidence: 'high', bestMatch: { title: 'Book 2', authors: [{ name: 'A' }], asin: 'A2' }, alternatives: [] },
        ],
      });
      mockApi.createImportSubmission!.mockResolvedValue(summaryResponse({ id: 9, source: 'library', status: 'receiving', expectedCount: 2 }));
      mockApi.putImportSubmissionItems!.mockResolvedValue(summaryResponse({ id: 9, source: 'library', status: 'receiving', expectedCount: 2 }));
      mockApi.finalizeImportSubmission!.mockResolvedValue(summaryResponse({ id: 9, source: 'library', status: 'processing', expectedCount: 2, processedCount: 0 }));
      mockApi.getImportSubmission!.mockResolvedValue(summaryResponse({ id: 9, source: 'library', status: 'processing', expectedCount: 2, processedCount: 1 }));

      renderWithProviders(<LibraryImportPage />);
      await waitFor(() => { expect(screen.getByText('Book 1')).toBeInTheDocument(); });
      await firePoll();
      await waitFor(() => { expect(screen.getByRole('button', { name: /import 2 books/i })).toBeEnabled(); });

      await userEvent.click(screen.getByRole('button', { name: /import 2 books/i }));

      await waitFor(() => { expect(screen.getByText(/Registering 1 of 2/)).toBeInTheDocument(); });
      expect(screen.queryByText(/Registering 0 of 2/)).not.toBeInTheDocument();
    });
  });

  describe('relative path computation (AC1: uses segment-based pathUtils, not startsWith)', () => {
    it('passes relative portion as relativePath prop to ImportCard when book path is inside library root', async () => {
      mockApi.scanDirectory!.mockResolvedValue({
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
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks-old/AuthorB/Book2', parsedTitle: 'Book Two', parsedAuthor: 'Author B', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('audiobooks-old/AuthorB/Book2')).toBeInTheDocument();
      });
    });

    it('passes undefined as relativePath when book path uses .. traversal that escapes library root', async () => {
      // Normalize segments: startsWith would accept traversal outside the library root.
      mockApi.scanDirectory!.mockResolvedValue({
        discoveries: [
          { path: '/audiobooks/../secret/Author/Book', parsedTitle: 'Secret Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: false },
        ],
        totalFolders: 1,
      });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText('secret/Author/Book')).toBeInTheDocument();
      });
      expect(screen.queryByText('../secret/Author/Book')).not.toBeInTheDocument();
    });

    it('passes undefined as relativePath when library root is not set in settings', async () => {
      mockApi.getSettings!.mockResolvedValue(mockSettingsNoPath);

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText(/no library path/i)).toBeInTheDocument();
      });
    });
  });

  describe('former within-scan rows — visibility and toggle (#1925)', () => {
    const scanResultWithWithinScan = {
      discoveries: [
        { path: '/audiobooks/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false },
        { path: '/audiobooks/Copy/Author/Book', parsedTitle: 'Book', parsedAuthor: 'Author', parsedSeries: null, fileCount: 3, totalSize: 100000, isDuplicate: false, reviewReason: 'Possible duplicate folder in this scan' },
        { path: '/audiobooks/DbDup/DbBook', parsedTitle: 'DbBook', parsedAuthor: 'DbAuthor', parsedSeries: null, fileCount: 1, totalSize: 50000, isDuplicate: true, duplicateReason: 'slug' },
      ],
      totalFolders: 3,
    };

    it('former within-scan rows are visible by default (not hidden by showExisting toggle)', async () => {
      mockApi.scanDirectory!.mockResolvedValue(scanResultWithWithinScan);
      mockApi.startMatchJob!.mockResolvedValue({ jobId: 'job-1' });
      mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'complete', total: 2, matched: 2, results: [] });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText(/Copy\/Author\/Book/)).toBeInTheDocument();
      });
    });

    it('DB duplicates (path/slug) are hidden by default behind toggle', async () => {
      mockApi.scanDirectory!.mockResolvedValue(scanResultWithWithinScan);
      mockApi.startMatchJob!.mockResolvedValue({ jobId: 'job-1' });
      mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'complete', total: 2, matched: 2, results: [] });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText(/Copy\/Author\/Book/)).toBeInTheDocument();
      });

      expect(screen.queryByText(/DbDup\/DbBook/)).not.toBeInTheDocument();
    });

    it('show existing toggle count reflects only DB duplicates, not former within-scan rows', async () => {
      mockApi.scanDirectory!.mockResolvedValue(scanResultWithWithinScan);
      mockApi.startMatchJob!.mockResolvedValue({ jobId: 'job-1' });
      mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'complete', total: 2, matched: 2, results: [] });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText(/1 existing/)).toBeInTheDocument();
      });
    });

    it('N of M new selected denominator counts a former within-scan row as new and default-selected', async () => {
      mockApi.scanDirectory!.mockResolvedValue(scanResultWithWithinScan);
      mockApi.startMatchJob!.mockResolvedValue({ jobId: 'job-1' });
      mockApi.getMatchJob!.mockResolvedValue({ id: 'job-1', status: 'complete', total: 2, matched: 2, results: [] });

      renderWithProviders(<LibraryImportPage />);

      await waitFor(() => {
        expect(screen.getByText(/2 of 2 new selected/)).toBeInTheDocument();
      });
    });
  });

  describe('attention banner host (#1894, F21)', () => {
    const abandonedLibrary = {
      id: 7, clientSubmissionId: 'c', source: 'library' as const, status: 'receiving' as const,
      expectedCount: 3, receivedCount: 1, processedCount: 0,
      aggregates: { accepted: 0, held: 0, skipped: 0, failed: 0 }, detailsPruned: false,
      itemsIncluded: false as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      attention: { kind: 'abandoned' as const },
    };

    it('mounts the source-scoped panel + banner and "Import again" re-triggers the library scan', async () => {
      const user = userEvent.setup();
      mockApi.listImportSubmissions!.mockResolvedValue({ data: [], total: 0 });
      mockApi.getImportSubmissionAttention!.mockResolvedValue({ data: abandonedLibrary, watch: true });
      renderWithProviders(<LibraryImportPage />);
      await waitFor(() => expect(mockApi.getImportSubmissionAttention).toHaveBeenCalledWith({ source: 'library' }));
      await waitFor(() => expect(mockApi.listImportSubmissions).toHaveBeenCalledWith({ source: 'library', limit: 1 }));
      await waitFor(() => expect(mockApi.scanDirectory).toHaveBeenCalledTimes(1));
      const banner = await screen.findByTestId('import-attention-banner');
      await user.click(within(banner).getByRole('button', { name: 'Import again' }));
      await waitFor(() => expect(mockApi.scanDirectory).toHaveBeenCalledTimes(2));
    });
  });
});
