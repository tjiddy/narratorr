import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { SearchBookCard } from './SearchBookCard';
import { mapBookMetadataToPayload } from '@/lib/helpers';
import { createMockBookMetadata, createMockBook } from '@/__tests__/factories';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      addBook: vi.fn(),
      getSettings: vi.fn().mockResolvedValue({
        quality: { grabFloor: 0, protocolPreference: 'none', minSeeders: 0, searchImmediately: false, rejectWords: '', requiredWords: '' },
      }),
    },
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { api, ApiError, type BookIdentifier, type LibraryEntry } from '@/lib/api';
import { toast } from 'sonner';
import { queryKeys } from '@/lib/queryKeys';

function renderCard(bookOverrides = {}, libraryBooks?: LibraryEntry[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries');
  const book = createMockBookMetadata(bookOverrides);
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SearchBookCard book={book} index={0} {...(libraryBooks !== undefined && { libraryBooks })} queryClient={queryClient} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
    invalidateQueries,
  };
}

function identifier(overrides: Partial<BookIdentifier> = {}): BookIdentifier {
  return {
    id: 1,
    asin: 'B003P2WO5E',
    title: 'The Way of Kings',
    authorName: 'Brandon Sanderson',
    authorSlug: 'brandon-sanderson',
    ...overrides,
  };
}

describe('SearchBookCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders book title and author', () => {
    renderCard();
    expect(screen.getByText('The Way of Kings')).toBeInTheDocument();
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
  });

  it('renders cover image when coverUrl is provided', () => {
    renderCard();
    expect(screen.getByAltText('The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback icon when no coverUrl', () => {
    renderCard({ coverUrl: undefined });
    expect(screen.queryByAltText('The Way of Kings')).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    renderCard();
    expect(screen.getByText(/Narrated by Michael Kramer, Kate Reading/)).toBeInTheDocument();
  });

  it('renders genre badges up to 3 max', () => {
    renderCard({ genres: ['Fantasy', 'Epic', 'Adventure', 'Romance'] });
    expect(screen.getByText('Fantasy')).toBeInTheDocument();
    expect(screen.getByText('Epic')).toBeInTheDocument();
    expect(screen.getByText('Adventure')).toBeInTheDocument();
    expect(screen.queryByText('Romance')).not.toBeInTheDocument();
  });

  it('renders formatted duration badge', () => {
    renderCard({ duration: 90 });
    expect(screen.getByText('1h 30m')).toBeInTheDocument();
  });

  it('hides duration badge when duration is falsy', () => {
    renderCard({ duration: null });
    expect(screen.queryByText(/\d+[hm]/)).not.toBeInTheDocument();
  });

  it('renders seriesPrimary instead of series[0] when both are present (#1097)', () => {
    renderCard({
      seriesPrimary: { name: 'The Stormlight Archive', position: 2 },
      series: [
        { name: 'Cosmere', position: 5 },
        { name: 'The Stormlight Archive', position: 2 },
      ],
    });
    expect(screen.getByText(/The Stormlight Archive/)).toBeInTheDocument();
    expect(screen.getByText(/#2/)).toBeInTheDocument();
    expect(screen.queryByText(/Cosmere/)).not.toBeInTheDocument();
  });

  it('falls back to series[0] when seriesPrimary is absent (#1097)', () => {
    renderCard({ seriesPrimary: undefined, series: [{ name: 'Discworld', position: 9 }] });
    expect(screen.getByText(/Discworld/)).toBeInTheDocument();
  });

  it('shows Add button when not in library', () => {
    renderCard();
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('shows In Library badge (no Add) on an exact-ASIN library match', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [createMockBook(book.asin !== undefined ? { asin: book.asin } : {})];
    renderCard({}, libraryBooks);
    expect(screen.getByText('In Library')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add book/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Edition in library')).not.toBeInTheDocument();
  });

  it('renders In Library badge as a link to the matched library book detail page', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [createMockBook({ id: 42, ...(book.asin !== undefined ? { asin: book.asin } : {}) })];
    renderCard({}, libraryBooks);
    const link = screen.getByRole('link', { name: /view this book in your library/i });
    expect(link).toHaveAttribute('href', '/books/42');
  });

  it('shows the related-edition badge AND a working Add on a title-identity match', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 1, title: 'The Way of Kings' } as never);
    // Same title and author but a different ASIN forces title identity.
    const libraryBooks = [createMockBook({ id: 1, asin: 'B00DIFFEDN' })];
    const user = userEvent.setup();
    renderCard({}, libraryBooks);

    expect(screen.getByText('Edition in library')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view this book in your library/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add book/i }));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);
    // Add must submit the searched edition, never the title-matched incumbent.
    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledWith(
        mapBookMetadataToPayload(createMockBookMetadata(), { searchImmediately: false }),
      );
    });
    expect(api.addBook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.addBook).mock.calls[0]![0]!.asin).toBe('B003P2WO5E');
  });

  it('links to the exact-ASIN incumbent (no Add) even when a title-identity entry is listed first', () => {
    const book = createMockBookMetadata();
    const libraryBooks = [
      // Title-identity first catches naive Array.find ownership.
      createMockBook({ id: 1, asin: 'B00OTHERED' }),
      createMockBook({ id: 42, ...(book.asin !== undefined ? { asin: book.asin } : {}) }),
    ];
    renderCard({}, libraryBooks);
    expect(screen.getByRole('link', { name: /view this book in your library/i }))
      .toHaveAttribute('href', '/books/42');
    expect(screen.queryByText('Edition in library')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add book/i })).not.toBeInTheDocument();
  });

  it('shows the Booktrack edition in the related-edition state with a working Add (specimen)', () => {
    const libraryBooks = [
      createMockBook({
        id: 3,
        title: 'The Lovely Bones',
        asin: 'B002V1A380',
        authors: [{ id: 1, name: 'Alice Sebold', slug: 'alice-sebold' }],
      }),
    ];
    renderCard(
      { title: 'The Lovely Bones: Booktrack Edition', asin: 'B00BOOKTRK', authors: [{ name: 'Alice Sebold' }] },
      libraryBooks,
    );
    expect(screen.getByText('Edition in library')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add book/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view this book in your library/i })).not.toBeInTheDocument();
  });

  it('flips the related-edition state to linked In Library at the created id after a successful add', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
    const libraryBooks = [createMockBook({ id: 1, asin: 'B00DIFFEDN' })];
    const user = userEvent.setup();
    renderCard({}, libraryBooks);

    await user.click(screen.getByRole('button', { name: /add book/i }));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
    // The completed add replaces the original title-identity match.
    expect(screen.getByRole('link', { name: /view this book in your library/i }))
      .toHaveAttribute('href', '/books/99');
    expect(screen.queryByText('Edition in library')).not.toBeInTheDocument();
  });

  it('flips the related-edition state to the 409 incumbent id when the server rejects the add', async () => {
    vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { id: 7 }));
    const libraryBooks = [createMockBook({ id: 1, asin: 'B00DIFFEDN' })];
    const user = userEvent.setup();
    renderCard({}, libraryBooks);

    await user.click(screen.getByRole('button', { name: /add book/i }));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('Already in library');
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /view this book in your library/i }))
      .toHaveAttribute('href', '/books/7');
  });

  it('renders AddBookPopover with no /books link when no library match', () => {
    renderCard({}, []);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.queryByText('Edition in library')).not.toBeInTheDocument();
  });

  it('calls addBook via popover flow', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 1, title: 'The Way of Kings' } as never);
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(api.addBook).toHaveBeenCalledTimes(1);
    });
  });

  it('shows In Library after successful add, linked to the created book', async () => {
    vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Added 'The Way of Kings' to library");
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /view this book in your library/i }))
      .toHaveAttribute('href', '/books/99');
  });

  it('handles 409 duplicate gracefully, linking to the existing book id from the 409 body', async () => {
    vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { id: 7 }));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith('Already in library');
      expect(screen.getByText('In Library')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /view this book in your library/i }))
      .toHaveAttribute('href', '/books/7');
  });

  describe('#1916 identifiers-backed ownership', () => {
    it('links the In Library badge at the exact-ASIN incumbent even when it sits past row 120', () => {
      const book = createMockBookMetadata();
      // Exact ASIN last catches both capped results and naive first-match selection.
      const libraryBooks: BookIdentifier[] = [
        identifier({ id: 1, asin: 'B00OTHERED' }),
        ...Array.from({ length: 120 }, (_, i) =>
          identifier({ id: 100 + i, asin: `B00FILLER${i}`, title: `Filler ${i}`, authorName: 'Someone Else', authorSlug: 'someone-else' }),
        ),
        identifier({ id: 42, ...(book.asin !== undefined ? { asin: book.asin } : {}) }),
      ];
      expect(libraryBooks.length).toBeGreaterThan(120);

      renderCard({}, libraryBooks);

      expect(screen.getByRole('link', { name: /view this book in your library/i })).toHaveAttribute('href', '/books/42');
      expect(screen.queryByRole('button', { name: /add book/i })).not.toBeInTheDocument();
      expect(screen.queryByText('Edition in library')).not.toBeInTheDocument();
    });

    it('reads entry.id off a BookIdentifier-only exact-ASIN match', () => {
      renderCard({}, [identifier({ id: 55 })]);
      expect(screen.getByRole('link', { name: /view this book in your library/i })).toHaveAttribute('href', '/books/55');
    });

    it('keeps Add and the related-edition badge for a BookIdentifier-only title-identity match', () => {
      renderCard({}, [identifier({ id: 55, asin: 'B00DIFFEDN' })]);
      expect(screen.getByText('Edition in library')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add book/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /view this book in your library/i })).not.toBeInTheDocument();
    });

    // bookIdentifiers is nested under the books query-key prefix.
    it('invalidates the books prefix (which covers the identifiers cache) after a successful add', async () => {
      vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
      const user = userEvent.setup();
      const { invalidateQueries } = renderCard({}, []);

      await user.click(screen.getByRole('button', { name: /add book/i }));
      await user.click(await screen.findByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
      expect(queryKeys.bookIdentifiers().slice(0, queryKeys.books().length)).toEqual([...queryKeys.books()]);
    });

    it('invalidates the books prefix on the 409-with-incumbent path too', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { id: 7 }));
      const user = userEvent.setup();
      const { invalidateQueries } = renderCard({}, []);

      await user.click(screen.getByRole('button', { name: /add book/i }));
      await user.click(await screen.findByRole('button', { name: /add to library/i }));

      await waitFor(() => {
        expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.books() });
      });
    });
  });

  // The route used to flatten review into the same bare 409 as an owned recording, so the card
  // claimed ownership of a book the resolver refused to call a duplicate (#2199).
  describe('#2199 an undecided review is not an ownership claim', () => {
    const reviewBody = { conflict: 'review', id: 88, title: 'Piranesi' };

    async function addOnce() {
      const user = userEvent.setup();
      const rendered = renderCard();
      await user.click(screen.getByRole('button', { name: /add book/i }));
      await user.click(await screen.findByRole('button', { name: /add to library/i }));
      return { user, ...rendered };
    }

    it('keeps the Add control mounted and shows no In Library badge on a review 409', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, reviewBody));

      await addOnce();

      await waitFor(() => {
        expect(screen.getByText('Possible duplicate (review)')).toBeInTheDocument();
      });
      expect(screen.queryByText('In Library')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /view this book in your library/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add book/i })).toBeInTheDocument();
      expect(toast.info).not.toHaveBeenCalledWith('Already in library');
    });

    it('names the incumbent the resolver could not separate this recording from', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, reviewBody));

      await addOnce();

      expect(await screen.findByText(/Piranesi/)).toBeInTheDocument();
    });

    it('falls back to generic wording when the 409 body carries no incumbent title', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { conflict: 'review', id: 88 }));

      await addOnce();

      expect(await screen.findByText(/already in your library/i)).toBeInTheDocument();
    });

    it('re-issues the add with the override and flips to In Library once it succeeds', async () => {
      vi.mocked(api.addBook).mockRejectedValueOnce(new ApiError(409, reviewBody));
      const { user } = await addOnce();
      await screen.findByRole('button', { name: /add anyway/i });

      vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => {
        expect(screen.getByText('In Library')).toBeInTheDocument();
      });
      expect(vi.mocked(api.addBook).mock.calls[1]![0]).toMatchObject({ overrideRecordingReview: true });
      expect(screen.queryByText('Possible duplicate (review)')).not.toBeInTheDocument();
    });

    it('carries the popover search choice through to the overriding add', async () => {
      vi.mocked(api.addBook).mockRejectedValueOnce(new ApiError(409, reviewBody));
      const user = userEvent.setup();
      renderCard();

      await user.click(screen.getByRole('button', { name: /add book/i }));
      await user.click(await screen.findByRole('checkbox'));
      await user.click(await screen.findByRole('button', { name: /add to library/i }));
      await screen.findByRole('button', { name: /add anyway/i });

      vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => { expect(api.addBook).toHaveBeenCalledTimes(2); });
      expect(vi.mocked(api.addBook).mock.calls[1]![0]).toMatchObject({
        searchImmediately: true, overrideRecordingReview: true,
      });
    });

    it('leaves the review affordance mounted when the overriding add is itself refused', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, reviewBody));
      const { user } = await addOnce();
      await screen.findByRole('button', { name: /add anyway/i });

      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => { expect(api.addBook).toHaveBeenCalledTimes(2); });
      expect(screen.getByText('Possible duplicate (review)')).toBeInTheDocument();
      expect(screen.queryByText('In Library')).not.toBeInTheDocument();
    });

    // The override is a create with no ASIN fence in front of it, so a double click would commit
    // two rows; only the button's pending guard stands between the two clicks (F1).
    it('disables Add anyway while its request is in flight, so a second click issues no second create', async () => {
      vi.mocked(api.addBook).mockRejectedValueOnce(new ApiError(409, reviewBody));
      const { user } = await addOnce();
      await screen.findByRole('button', { name: /add anyway/i });

      let release!: (created: { id: number; title: string }) => void;
      vi.mocked(api.addBook).mockImplementation(
        () => new Promise((resolve) => { release = resolve as typeof release; }) as never,
      );
      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /add anyway/i })).toBeDisabled();
      });
      expect(api.addBook).toHaveBeenCalledTimes(2);

      await user.click(screen.getByRole('button', { name: /add anyway/i }));
      expect(api.addBook).toHaveBeenCalledTimes(2);

      release({ id: 99, title: 'The Way of Kings' });
      await waitFor(() => { expect(screen.getByText('In Library')).toBeInTheDocument(); });
    });

    // The two-step flow can fail after the affordance is already mounted; clearing it there would
    // strand the operator with no way back to the override (F2).
    it('surfaces a non-409 override failure and leaves the review affordance retryable', async () => {
      vi.mocked(api.addBook).mockRejectedValueOnce(new ApiError(409, reviewBody));
      const { user } = await addOnce();
      await screen.findByRole('button', { name: /add anyway/i });

      vi.mocked(api.addBook).mockRejectedValueOnce(new Error('Network error'));
      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => {
        expect(toast.error).toHaveBeenCalledWith('Failed to add book: Network error');
      });
      expect(screen.getByText('Possible duplicate (review)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add anyway/i })).toBeEnabled();
      expect(screen.queryByText('In Library')).not.toBeInTheDocument();

      // Retryable in the literal sense: the same control still completes the add.
      vi.mocked(api.addBook).mockResolvedValue({ id: 99, title: 'The Way of Kings' } as never);
      await user.click(screen.getByRole('button', { name: /add anyway/i }));

      await waitFor(() => { expect(screen.getByText('In Library')).toBeInTheDocument(); });
      expect(vi.mocked(api.addBook).mock.calls[2]![0]).toMatchObject({ overrideRecordingReview: true });
    });

    it('still claims ownership and offers no override on a same-recording 409', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { conflict: 'same-recording', id: 7, title: 'Owned' }));

      await addOnce();

      await waitFor(() => {
        expect(toast.info).toHaveBeenCalledWith('Already in library');
        expect(screen.getByText('In Library')).toBeInTheDocument();
      });
      expect(screen.queryByRole('button', { name: /add anyway/i })).not.toBeInTheDocument();
    });

    it('still claims ownership on an owned-race 409', async () => {
      vi.mocked(api.addBook).mockRejectedValue(new ApiError(409, { conflict: 'owned-race', id: 7, title: 'Owned' }));

      await addOnce();

      await waitFor(() => { expect(screen.getByText('In Library')).toBeInTheDocument(); });
      expect(screen.getByRole('link', { name: /view this book in your library/i })).toHaveAttribute('href', '/books/7');
    });
  });

  it('shows error toast for non-409 errors', async () => {
    vi.mocked(api.addBook).mockRejectedValue(new Error('Network error'));
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByRole('button'));
    const addToLibrary = await screen.findByRole('button', { name: /add to library/i });
    await user.click(addToLibrary);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Failed to add book: Network error');
    });
  });
});
