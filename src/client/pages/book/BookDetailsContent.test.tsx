import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
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
const { getBookSeriesMock } = vi.hoisted(() => ({ getBookSeriesMock: vi.fn() }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      getBookSeries: getBookSeriesMock,
      refreshBookSeries: vi.fn(),
    },
  };
});

beforeEach(() => {
  getBookSeriesMock.mockReset();
  getBookSeriesMock.mockResolvedValue({ series: null });
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
        providerSeriesId: 'B07DHQY7DX',
        lastFetchedAt: '2026-05-11T00:00:00.000Z',
        lastFetchStatus: 'success',
        nextFetchAfter: null,
        members: [
          { id: 1, providerBookId: 'B01NA0JA51', title: 'Kings of the Wyld', positionRaw: '1', position: 1, isCurrent: true, libraryBookId: 1, coverUrl: null, authorName: null, publishedDate: null, duration: null },
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
