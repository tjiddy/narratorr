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

// vi.hoisted() so the mock fn exists before vi.mock's factory runs at the top of the module.
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
  // Every book with a path now issues the Ebook panel's /state query. A rejection is enough
  // for the cases that don't care: #1963 AC3 makes an initial-load failure silently absent.
  getCompanionEbookStateMock.mockReset();
  getCompanionEbookStateMock.mockRejectedValue(new Error('no companion state in this fixture'));
  // #2022 — the panel reads /metadata on `available`. Stubbed rather than left real, because a
  // spread-`actual.api` factory leaves an unstubbed method issuing a genuine fetch
  // (`vimock-barrel-replace-drops-named-exports`).
  getCompanionEbookMetadataMock.mockReset();
  getCompanionEbookMetadataMock.mockRejectedValue(new Error('no companion metadata in this fixture'));
});

function makeBook(overrides: Partial<BookWithAuthor> = {}): BookWithAuthor {
  return createMockBook({ audioCodec: 'AAC', ...overrides });
}

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

  // #1963 — the Ebook section shares Location's `hasPath` gate, so a pathless book must not
  // even MOUNT the panel. Asserting only that the heading is absent is not enough: the panel
  // renders nothing on a failed load either (AC3), so an unconditionally mounted section would
  // 404 and retry against every wanted/pathless book while the DOM assertions stayed green.
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

    // The paired positive case: without it, the two no-call assertions above would also pass
    // for a section that never queries at all. The id is pinned so this also proves the
    // section is keyed to the rendered book rather than to some ambient default.
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
    // Use a clean book without audioCodec — only series metadata
    const seriesOnlyBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: 'The Band', seriesPosition: 1 });
    // Simulate the no-key library-only response so the card renders
    getBookSeriesMock.mockResolvedValueOnce({
      series: {
        id: null,
        name: 'The Band',
        hardcoverSeriesId: null,
        seriesAuthor: null,
        lastFetchedAt: null,
        members: [{ hardcoverBookId: null, slug: null, title: seriesOnlyBook.title, position: 1, imageUrl: null, inLibrary: true, libraryBookId: seriesOnlyBook.id }],
      },
    });
    renderWithProviders(
      <BookDetailsContent
        libraryBook={seriesOnlyBook}
        merged={{}}
      />,
    );

    // Without the series-aware gate, the whole component returns null and Series header never renders.
    // With the fix, the sidebar renders and the SeriesCard's heading appears once the query settles.
    expect(await screen.findByRole('heading', { name: /^series$/i })).toBeInTheDocument();
  });

  it('renders sidebar with Series card when ONLY a DB-cache link exists (no scalar seriesName) — F9', async () => {
    // Book has no scalar seriesName but the backend has cached a series row
    // for it via member ASIN. The page should still surface the Series card.
    getBookSeriesMock.mockResolvedValueOnce({
      series: {
        id: 7,
        name: 'The Band',
        hardcoverSeriesId: 5523,
        seriesAuthor: 'Nicholas Eames',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        members: [
          { hardcoverBookId: 1001, slug: 'kings', title: 'Kings of the Wyld', position: 1, imageUrl: null, inLibrary: true, libraryBookId: 1 },
        ],
      },
    });
    // No scalar series fields — only the cache link should surface the card
    const cacheOnlyBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: null, seriesPosition: null, asin: 'B01NA0JA51' });
    renderWithProviders(
      <BookDetailsContent
        libraryBook={cacheOnlyBook}
        merged={{}}
      />,
    );

    // F9: the sidebar gate must trigger on the cached series result.
    // The card's internal name/member rendering is covered by SeriesCard.test.tsx.
    expect(await screen.findByRole('heading', { name: /^series$/i })).toBeInTheDocument();
  });

  it('renders nothing when there is no scalar series AND no DB-cache series AND nothing else for the sidebar', async () => {
    getBookSeriesMock.mockResolvedValueOnce({ series: null });
    const bareBook = createMockBook({ status: 'wanted', audioCodec: null, path: null, seriesName: null, seriesPosition: null });
    const { container } = renderWithProviders(
      <BookDetailsContent libraryBook={bareBook} merged={{}} />,
    );
    // Wait a tick so the resolved query updates state
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector('h2')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #1963 AC1 — the Ebook section sits IMMEDIATELY before Location.
//
// Adjacency, not mere ordering: the `none` copy says "shown under Location below", so an
// interposed sidebar section would make that sentence wrong while a precedes-check stayed
// green. The fixture deliberately carries series, audio, and genres so an interposed section
// would actually be caught.
// ---------------------------------------------------------------------------
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

    // Same claim through the DOM: the section wrapper's next sibling holds Location.
    // The h2 sits inside the header's flex wrapper (label + icon row, the Series idiom),
    // so the SECTION wrapper is two levels up, not one.
    const section = ebookHeading.parentElement!.parentElement!;
    expect(section.nextElementSibling?.querySelector('h2')?.textContent).toBe('Location');
    expect(container.querySelectorAll('h2')).not.toHaveLength(0);
  });
});
