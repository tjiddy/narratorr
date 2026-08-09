// This file uses real router history because LibraryPage.test.tsx mocks useNavigate.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LibraryPage } from './LibraryPage';
import { createMockLibraryBook, createMockAuthor, createMockSettings } from '@/__tests__/factories';
import type { BookListParams } from '@/lib/api';
import { simulateStatusFilter } from '@/__tests__/library-server-sim';
import type { StatusFilter } from './helpers';

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      ...(actual as { api: object }).api,
      listLibraryBooks: vi.fn(),
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
  };
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { api } from '@/lib/api';

const mockBooks = [
  createMockLibraryBook({
    id: 1,
    title: 'The Way of Kings',
    status: 'wanted',
    authors: [createMockAuthor({ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' })],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  }),
  createMockLibraryBook({
    id: 2,
    title: 'Project Hail Mary',
    status: 'imported',
    authors: [createMockAuthor({ id: 2, name: 'Andy Weir', slug: 'andy-weir' })],
    createdAt: '2024-01-02T00:00:00Z',
    updatedAt: '2024-01-02T00:00:00Z',
  }),
];

// Hand-authored order keeps the fixture independent of the server comparator it represents.
const MOCK_BOOKS_ORDER: Record<string, number[]> = {
  'createdAt:desc': [2, 1],
  'createdAt:asc': [1, 2],
  'title:asc': [2, 1],
  'title:desc': [1, 2],
};
const DEFAULT_ORDER_KEY = 'createdAt:desc';

function applyServerOrder(books: typeof mockBooks, sortField?: string, sortDirection?: string): typeof mockBooks {
  const key = `${sortField ?? 'createdAt'}:${sortDirection ?? 'desc'}`;
  const idOrder = MOCK_BOOKS_ORDER[key] ?? MOCK_BOOKS_ORDER[DEFAULT_ORDER_KEY]!;
  const byId = new Map(books.map(b => [b.id, b]));
  const ordered = idOrder.map(id => byId.get(id)).filter((b): b is typeof mockBooks[number] => b !== undefined);
  const covered = new Set(idOrder);
  return [...ordered, ...books.filter(b => !covered.has(b.id))];
}

function mockLibraryData() {
  vi.mocked(api.listLibraryBooks).mockImplementation((params?: BookListParams) => {
    let filtered = [...mockBooks];
    if (params?.status) {
      filtered = filtered.filter(b => simulateStatusFilter(b.status, params.status as StatusFilter));
    }
    filtered = applyServerOrder(filtered, params?.sortField, params?.sortDirection);
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

function BookDetailStub() {
  const navigate = useNavigate();
  return (
    <div data-testid="book-detail">
      Book Detail Page
      <button onClick={() => navigate(-1)}>Back to Library</button>
    </div>
  );
}

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

    renderWithRoutes('/library?status=wanted&sortField=title&sortDirection=asc');

    await waitFor(() => {
      expect(api.listLibraryBooks).toHaveBeenCalled();
    });

    const firstCallArgs = vi.mocked(api.listLibraryBooks).mock.calls[0]?.[0];
    expect(firstCallArgs).toMatchObject({
      status: 'wanted',
      sortField: 'title',
      sortDirection: 'asc',
    });

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    await user.click(screen.getByText('The Way of Kings'));

    await waitFor(() => {
      expect(screen.getByTestId('book-detail')).toBeInTheDocument();
    });

    await user.click(screen.getByText('Back to Library'));

    await waitFor(() => {
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(screen.queryByTestId('book-detail')).not.toBeInTheDocument();

    expect(screen.queryByText('Project Hail Mary')).not.toBeInTheDocument();
  });

  it('restores keyed fixture ordering for title:asc from URL params (id=2 before id=1)', async () => {
    // Server title sorting strips the leading article; input order is deliberately opposite.
    renderWithRoutes('/library?sortField=title&sortDirection=asc');

    await waitFor(() => {
      expect(screen.getByText('Project Hail Mary')).toBeInTheDocument();
      expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    });

    expect(vi.mocked(api.listLibraryBooks).mock.calls[0]?.[0]).toMatchObject({
      sortField: 'title',
      sortDirection: 'asc',
    });

    const cards = screen.getAllByRole('link').filter(el => el.getAttribute('tabindex') === '0');
    const titles = cards.map(card => card.querySelector('h3')?.textContent);
    expect(titles).toEqual(['Project Hail Mary', 'The Way of Kings']);
  });
});
