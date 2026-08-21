import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { BookDetailsContent } from './BookDetailsContent';
import { createMockBook } from '@/__tests__/factories';
import type { BookWithAuthor } from '@/lib/api';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/hooks/useLibrary', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useBookFiles: vi.fn().mockReturnValue({ data: [], isLoading: false, isError: false }),
  };
});

// vi.hoisted makes these mocks available when vi.mock's factory runs.
const { getBookSeriesMock, getCompanionEbookStateMock, getCompanionEbookMetadataMock } = vi.hoisted(() => ({
  getBookSeriesMock: vi.fn(),
  getCompanionEbookStateMock: vi.fn(),
  getCompanionEbookMetadataMock: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      getBookSeries: getBookSeriesMock,
      refreshBookSeries: vi.fn(),
      getCompanionEbookState: getCompanionEbookStateMock,
      getCompanionEbookMetadata: getCompanionEbookMetadataMock,
    },
  };
});

beforeEach(() => {
  getBookSeriesMock.mockReset();
  getBookSeriesMock.mockResolvedValue({ series: null });
  // Every book with a path queries Ebook state; rejection renders no panel.
  getCompanionEbookStateMock.mockReset();
  getCompanionEbookStateMock.mockRejectedValue(new Error('no companion state in this fixture'));
  // Stub metadata too so an available fixture cannot reach the real barrel export.
  getCompanionEbookMetadataMock.mockReset();
  getCompanionEbookMetadataMock.mockRejectedValue(new Error('no companion metadata in this fixture'));
});

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({ audioCodec: 'AAC', ...overrides });
}

// Partial API mocks can silently fall through to real fetches; render with every query-firing child mounted.
describe('BookDetailsContent — no real network', () => {
  it('issues no real network request while rendering with every section mounted', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      renderWithProviders(
        <BookDetailsContent
          libraryBook={makeBook({ status: 'imported', path: '/library/book', seriesName: 'Stormlight' })}
          merged={{ genres: ['Fantasy'] }}
        />,
      );
      await waitFor(() => expect(screen.getByRole('heading', { name: /^location$/i })).toBeInTheDocument());
      await waitFor(() => expect(fetchSpy.mock.calls.map((call) => String(call[0]))).toEqual([]));
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('BookDetailsContent — Location section wiring', () => {
  it('renders the Location section when libraryBook.path is a non-empty string', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '/library/book/story.m4b' })}
        merged={{}}
      />,
    );

    expect(screen.getByRole('heading', { name: /^location$/i })).toBeInTheDocument();
    expect(screen.getByText('/library/book/story.m4b')).toBeInTheDocument();
  });

  it('does not render the Location section when libraryBook.path is null', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'wanted', path: null })}
        merged={{}}
      />,
    );

    expect(screen.queryByRole('heading', { name: /^location$/i })).not.toBeInTheDocument();
  });

  // Assert no query, not just no heading: failed loads also render nothing.
  const pathlessCases: Array<[string, string | null]> = [['null', null], ['an empty string', '']];

  for (const [label, path] of pathlessCases) {
    it(`issues no companion-ebook state request when libraryBook.path is ${label}`, () => {
      renderWithProviders(
        <BookDetailsContent
          libraryBook={makeBook({ status: path === null ? 'wanted' : 'imported', path })}
          merged={{}}
        />,
      );

      expect(screen.queryByRole('heading', { name: 'Ebook' })).not.toBeInTheDocument();
      expect(getCompanionEbookStateMock).not.toHaveBeenCalled();
    });
  }

  it('does mount the companion-ebook query, for that book, once it has a path', async () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ id: 4242, status: 'imported', path: '/library/book' })}
        merged={{}}
      />,
    );

    // The positive call prevents pathless assertions from passing if the panel never queries.
    await waitFor(() => expect(getCompanionEbookStateMock).toHaveBeenCalledWith(4242));
  });

  it('does not render the Location section when libraryBook.path is an empty string', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '' })}
        merged={{}}
      />,
    );

    expect(screen.queryByRole('heading', { name: /^location$/i })).not.toBeInTheDocument();
  });

  it('renders the Location section before the Files section in document order', () => {
    renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '/library/book/story.m4b' })}
        merged={{}}
      />,
    );

    const locationHeading = screen.getByRole('heading', { name: /^location$/i });
    const filesButton = screen.getByRole('button', { name: /^files \(/i });

    expect(
      locationHeading.compareDocumentPosition(filesButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('BookDetailsContent — series sidebar gate (#1071)', () => {
  it('renders sidebar with Series card when only seriesName is set (no audio/genres/path)', async () => {
    const seriesOnlyBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: 'The Band', seriesPosition: 1 });
    getBookSeriesMock.mockResolvedValueOnce({
      series: {
        id: null,
        name: 'The Band',
        hardcoverSeriesId: null,
        seriesAuthor: null,
        lastFetchedAt: null,
        members: [{ hardcoverBookId: null, slug: null, title: seriesOnlyBook.title, position: 1, imageUrl: null, inLibrary: true, libraryBookId: seriesOnlyBook.id, libraryBucket: 'imported' }],
      },
    });
    renderWithProviders(
      <BookDetailsContent
        libraryBook={seriesOnlyBook}
        merged={{}}
      />,
    );

    expect(await screen.findByRole('heading', { name: /^series$/i })).toBeInTheDocument();
  });

  it('renders sidebar with Series card when ONLY a DB-cache link exists (no scalar seriesName) — F9', async () => {
    getBookSeriesMock.mockResolvedValueOnce({
      series: {
        id: 7,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        members: [
          { hardcoverBookId: 1001, slug: 'kings', title: 'Kings of the Wyld', position: 1, imageUrl: null, inLibrary: true, libraryBookId: 1, libraryBucket: 'imported' },
        ],
      },
    });
    const cacheOnlyBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: null, seriesPosition: null, asin: 'B01NA0JA51' });
    renderWithProviders(
      <BookDetailsContent
        libraryBook={cacheOnlyBook}
        merged={{}}
      />,
    );

    expect(await screen.findByRole('heading', { name: /^series$/i })).toBeInTheDocument();
  });

  it('renders nothing when there is no scalar series AND no DB-cache series AND nothing else for the sidebar', async () => {
    getBookSeriesMock.mockResolvedValueOnce({ series: null });
    const bareBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: null, seriesPosition: null });
    const { container } = renderWithProviders(
      <BookDetailsContent libraryBook={bareBook} merged={{}} />,
    );
    // Let the resolved query update the sidebar gate.
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('h2')).toBeNull();
  });
});

// Require adjacency, not mere order; the fixture mounts every possible intervening section.
describe('BookDetailsContent — Ebook section placement', () => {
  it('renders the Ebook heading immediately before the Location heading', async () => {
    getBookSeriesMock.mockResolvedValue({ series: { name: 'Stormlight', position: 1, members: [] } });
    getCompanionEbookStateMock.mockResolvedValue({
      status: 'none', filename: null, sizeBytes: null, validationCode: null,
      candidateCount: 0, selectedFilename: null, candidates: [],
    });

    const { container } = renderWithProviders(
      <BookDetailsContent
        libraryBook={makeBook({ status: 'imported', path: '/library/book', seriesName: 'Stormlight', audioCodec: 'AAC' })}
        merged={{ genres: ['Fantasy', 'Epic'] }}
      />,
    );

    const ebookHeading = await screen.findByRole('heading', { name: 'Ebook' });
    const headings = screen.getAllByRole('heading').map((h) => h.textContent);
    const ebookIndex = headings.indexOf('Ebook');
    expect(headings[ebookIndex + 1]).toBe('Location');

    // The heading's section wrapper is two levels up.
    const section = ebookHeading.parentElement!.parentElement!;
    expect(section.nextElementSibling?.querySelector('h2')?.textContent).toBe('Location');
    expect(container.querySelectorAll('h2')).not.toHaveLength(0);
  });
});
