/**
 * Route-level URL restoration tests for LibraryPage (#352).
 *
 * Separate file because the main LibraryPage.test.tsx globally mocks
 * useNavigate, which blocks real router history navigation. These tests
 * use real router navigation to prove filter state is restored after
 * navigating to /books/:id and back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from './LibraryPage';
import { createMockBook, createMockAuthor, createMockSettings } from '@/__tests__/factories';
import type { BookListParams } from '@/lib/api';
import { matchesStatusFilter, sortBooks } from './helpers';
import type { StatusFilter, SortField, SortDirection } from './helpers';

// Mock api — same pattern as LibraryPage.test.tsx but WITHOUT mocking useNavigate
vi.mock('@/lib/api', () => ({
  api: {
    getBooks: vi.fn(),
    getBookStats: vi.fn(),
    getSettings: vi.fn(),
    deleteBook: vi.fn(),
    deleteMissingBooks: vi.fn(),
    rescanLibrary: vi.fn(),
    searchBooks: vi.fn(),
    searchGrab: vi.fn(),
    searchAllWanted: vi.fn(),
    searchBook: vi.fn(),
    updateBook: vi.fn(),
    getIndexers: vi.fn().mockResolvedValue([]),
    getBook: vi.fn(),
  },
  formatBytes: (bytes?: number) => {
    if (!bytes) return '0 B';
    return `${bytes} bytes`;
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api } from '@/lib/api';

const mockBooks = [
  createMockBook({
    id: 1,
    title: 'The Way of Kings',
    status: 'wanted',
    authors: [createMockAuthor({ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' })],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  createMockBook({
    id: 2,
    title: 'Project Hail Mary',
    status: 'imported',
    authors: [createMockAuthor({ id: 2, name: 'Andy Weir', slug: 'andy-weir' })],
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  }),
];

function mockLibraryData() {
  vi.mocked(api.getBooks).mockImplementation((params?: BookListParams) => {
    let filtered = [...mockBooks];
    if (params?.status) {
      filtered = filtered.filter(b => matchesStatusFilter(b.status, params.status as StatusFilter));
    }
    if (params?.sortField) {
      filtered = sortBooks(filtered, params.sortField as SortField, (params.sortDirection ?? 'desc') as SortDirection);
    }
    return Promise.resolve({ data: filtered, total: filtered.length });
  });
  vi.mocked(api.getBookStats).mockResolvedValue({
    counts: { wanted: 1, downloading: 0, imported: 1, failed: 0, missing: 0 },
    authors: ['Brandon Sanderson', 'Andy Weir'],
    series: [],
    narrators: [],
  });
  vi.mocked(api.getSettings).mockResolvedValue(createMockSettings());
}

/** Minimal book detail page with a back button for route-tree testing */
function BookDetailStub() {
  const navigate = useNavigate();
  return (
    <div data-testid="book-detail">
      Book Detail Page
      <button onClick={() => navigate(-1)}>Back to Library</button>
    </div>
  );
}

/** Render library + book routes with real navigation (no useNavigate mock) */
function renderWithRoutes(initialRoute: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialRoute]}>
        <Routes>
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/books/:id" element={<BookDetailStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LibraryPage — route-level URL param restoration (#352)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLibraryData();
  });

  it('restores filter state from URL after navigating to /books/:id and back', async () => {
    const user = userEvent.setup();

    // Start on filtered library page
    renderWithRoutes('/library?status=wanted&sortField=title&sortDirection=asc');

    // Wait for library to load with filtered results
    await waitFor(() => {
      expect(api.getBooks).toHaveBeenCalled();
    });

    // Verify first fetch used URL-derived params
    const firstCallArgs = vi.mocked(api.getBooks).mock.calls[0]?.[0];
    expect(firstCallArgs).toMatchObject({
      status: 'wanted',
      sortField: 'title',
      sortDirection: 'asc',
    });

    // Wait for book cards to render
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Click a book card to navigate to /books/:id
    await user.click(screen.getByText('The Way of Kings'));

    // Verify we navigated to book detail
    await waitFor(() => {
      expect(screen.getByTestId('book-detail')).toBeInTheDocument();
    });

    // Navigate back using router's history (MemoryRouter doesn't use window.history)
    await user.click(screen.getByText('Back to Library'));

    // Library page should be restored with the filtered view (status=wanted).
    // TanStack Query may serve cached data (no re-fetch), but the hook
    // re-initializes from URL params and the UI reflects the filtered state.
    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    // Verify we're back on the library page (not book detail)
    expect(screen.queryByTestId('book-detail')).not.toBeInTheDocument();

    // The restored view must differ from the default unfiltered view.
    // 'Project Hail Mary' has status='imported' — it should NOT appear
    // when status=wanted filter is active. This distinguishes restored
    // filtered state from default (which would show all books).
    expect(screen.queryByText('Project Hail Mary')).not.toBeInTheDocument();
  });
});
