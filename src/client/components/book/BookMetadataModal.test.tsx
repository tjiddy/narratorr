import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookMetadataModal } from './BookMetadataModal';
import { createMockBook } from '@/__tests__/factories';

const mockBook = createMockBook({
  title: 'The Way of Kings',
  narrators: [{ id: 1, name: 'Michael Kramer', slug: 'michael-kramer' }],
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  path: '/library/Brandon Sanderson/The Way of Kings',
  status: 'imported',
  authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
  subtitle: 'Book One of the Stormlight Archive',
  description: 'An epic fantasy novel.',
  publisher: 'Macmillan Audio',
  coverUrl: 'https://example.com/cover.jpg',
  publishedDate: '2010-08-31',
  genres: ['Fantasy', 'Epic'],
});

const defaultProps = {
  book: mockBook,
  onSave: vi.fn(),
  onClose: vi.fn(),
  isSaving: false,
};

function renderModal(overrides = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BookMetadataModal {...defaultProps} {...overrides} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BookMetadataModal', () => {
  describe('edit view', () => {
    it('opens with current metadata pre-filled', () => {
      renderModal();

      expect(screen.getByLabelText(/^title/i)).toHaveValue('The Way of Kings');
      expect(screen.getByLabelText(/^author$/i)).toHaveValue('Brandon Sanderson');
      expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
      expect(screen.getByLabelText(/position/i)).toHaveValue('1');
      expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer');
      expect(screen.getByLabelText(/description/i)).toHaveValue('An epic fantasy novel.');
      expect(screen.getByLabelText(/subtitle/i)).toHaveValue('Book One of the Stormlight Archive');
      expect(screen.getByLabelText(/publisher/i)).toHaveValue('Macmillan Audio');
      expect(screen.getByLabelText(/published date/i)).toHaveValue('2010-08-31');
      expect(screen.getByLabelText(/genres/i)).toHaveValue('Fantasy, Epic');
    });

    it('calls onSave with updated data when Save is clicked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const titleInput = screen.getByLabelText(/^title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Words of Radiance');

      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'Words of Radiance' }),
          false,
        );
      });
    });

    it('calls onSave with rename=true when checkbox is checked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.click(screen.getByLabelText(/rename files/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.any(Object),
          true,
        );
      });
    });

    it('prevents saving with empty title', () => {
      renderModal();
      expect(screen.getByText('Save')).not.toBeDisabled();
    });

    it('disables Save when title is cleared', async () => {
      const user = userEvent.setup();
      renderModal();

      const titleInput = screen.getByLabelText(/^title/i);
      await user.clear(titleInput);

      await waitFor(() => {
        expect(screen.getByText('Save')).toBeDisabled();
      });
    });

    it('calls onClose when Cancel is clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderModal({ onClose });

      await user.click(screen.getByText('Cancel'));
      await waitFor(() => {
        expect(onClose).toHaveBeenCalledTimes(1);
      });
    });

    it('hides rename checkbox when book has no path', () => {
      const bookNoPath = { ...mockBook, path: null };
      renderModal({ book: bookNoPath });

      expect(screen.queryByLabelText(/rename files/i)).not.toBeInTheDocument();
    });

    it('shows Saving... text when isSaving is true', () => {
      renderModal({ isSaving: true });
      expect(screen.getByText('Saving...')).toBeInTheDocument();
      expect(screen.getByText('Saving...')).toBeDisabled();
    });

    it('sends seriesPosition as number', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, '2.5');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ seriesPosition: 2.5 }),
          false,
        );
      });
    });

    it('sends null seriesName when cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const seriesInput = screen.getByLabelText(/series$/i);
      await user.clear(seriesInput);
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({ seriesName: null }),
          false,
        );
      });
    });

    it('sends trimmed split narrators when narrator field is edited', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const narratorInput = screen.getByLabelText(/narrator/i);
      await user.clear(narratorInput);
      await user.type(narratorInput, 'Kate Reading, Tim Gerard Reynolds');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            narrators: ['Kate Reading', 'Tim Gerard Reynolds'],
          }),
          false,
        );
      });
    });

    it('excludes seriesPosition from payload when user types non-numeric value', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      // Change title so onSave gets called with some data
      const titleInput = screen.getByLabelText(/^title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Changed Title');

      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload.title).toBe('Changed Title');
        expect(payload).not.toHaveProperty('seriesPosition');
      });
    });

    it('shows inline error when series position is non-numeric', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });
    });

    it('clears error when series position is corrected to valid number', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');
      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });

      await user.clear(posInput);
      await user.type(posInput, '3');
      await waitFor(() => {
        expect(screen.queryByText('Must be a number')).not.toBeInTheDocument();
      });
    });

    it('clears error when series position is cleared', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');
      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });

      await user.clear(posInput);
      await waitFor(() => {
        expect(screen.queryByText('Must be a number')).not.toBeInTheDocument();
      });
    });

    it('shows inline error for partial parse like "1.2.3"', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, '1.2.3');

      await waitFor(() => {
        expect(screen.getByText('Must be a number')).toBeInTheDocument();
      });
    });

    it('does not disable Save when series position is invalid', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      await waitFor(() => {
        expect(screen.getByText('Save')).not.toBeDisabled();
      });
    });
  });

  describe('new metadata fields (#1609)', () => {
    it('sends authors when the author field is edited', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const authorInput = screen.getByLabelText(/^author$/i);
      await user.clear(authorInput);
      await user.type(authorInput, 'Robert Jordan, Brandon Sanderson');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(
          expect.objectContaining({
            authors: [{ name: 'Robert Jordan' }, { name: 'Brandon Sanderson' }],
          }),
          false,
        );
      });
    });

    it('omits authors (does not send []) when the author field is blanked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.clear(screen.getByLabelText(/^author$/i));
      // Change title so save still fires with a payload
      const titleInput = screen.getByLabelText(/^title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Changed Title');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload).not.toHaveProperty('authors');
      });
    });

    it('sends edited description; untouched fields are omitted', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const descInput = screen.getByLabelText(/description/i);
      await user.clear(descInput);
      await user.type(descInput, 'A revised description.');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload.description).toBe('A revised description.');
        expect(payload).not.toHaveProperty('title');
        expect(payload).not.toHaveProperty('genres');
      });
    });

    it('sends null (not "") when description is cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.clear(screen.getByLabelText(/description/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload.description).toBeNull();
      });
    });

    it('does not render a Cover URL input (#1614)', () => {
      renderModal();
      expect(screen.queryByLabelText(/cover url/i)).not.toBeInTheDocument();
    });

    it('sends edited subtitle and null when cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const subtitleInput = screen.getByLabelText(/subtitle/i);
      await user.clear(subtitleInput);
      await user.type(subtitleInput, 'A New Subtitle');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].subtitle).toBe('A New Subtitle');
      });

      onSave.mockClear();
      await user.clear(screen.getByLabelText(/subtitle/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].subtitle).toBeNull();
      });
    });

    it('sends edited publisher and null when cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const publisherInput = screen.getByLabelText(/publisher/i);
      await user.clear(publisherInput);
      await user.type(publisherInput, 'Tor Books');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].publisher).toBe('Tor Books');
      });

      onSave.mockClear();
      await user.clear(screen.getByLabelText(/publisher/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].publisher).toBeNull();
      });
    });

    it('sends the full raw publishedDate string when edited (no year truncation)', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const dateInput = screen.getByLabelText(/published date/i);
      await user.clear(dateInput);
      await user.type(dateInput, '2015-03-14');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].publishedDate).toBe('2015-03-14');
      });
    });

    it('omits an untouched publishedDate from the payload (never truncated to a year)', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      // Touch a different field so save fires with a payload
      const titleInput = screen.getByLabelText(/^title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Changed Title');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload).not.toHaveProperty('publishedDate');
      });
    });

    it('sends null when publishedDate is cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.clear(screen.getByLabelText(/published date/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].publishedDate).toBeNull();
      });
    });

    it('parses comma-separated genres into a string[] payload', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const genresInput = screen.getByLabelText(/genres/i);
      await user.clear(genresInput);
      await user.type(genresInput, 'Science Fiction, Horror');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].genres).toEqual(['Science Fiction', 'Horror']);
      });
    });

    it('sends null (not []) when the genres field is blanked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.clear(screen.getByLabelText(/genres/i));
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        expect(onSave.mock.calls[0]![0].genres).toBeNull();
      });
    });

    it('editing only the author leaves other fields out of the payload', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const authorInput = screen.getByLabelText(/^author$/i);
      await user.clear(authorInput);
      await user.type(authorInput, 'Robert Jordan');
      await user.click(screen.getByText('Save'));

      await waitFor(() => {
        const payload = onSave.mock.calls[0]![0];
        expect(payload).toHaveProperty('authors');
        expect(payload).not.toHaveProperty('title');
        expect(payload).not.toHaveProperty('subtitle');
        expect(payload).not.toHaveProperty('description');
        expect(payload).not.toHaveProperty('publisher');
        expect(payload).not.toHaveProperty('publishedDate');
        expect(payload).not.toHaveProperty('genres');
        expect(payload).not.toHaveProperty('narrators');
        expect(payload).not.toHaveProperty('seriesName');
      });
    });
  });

  describe('embedded search removed (#1609)', () => {
    it('does not render a "Search for metadata" button', () => {
      renderModal();
      expect(screen.queryByText('Search for metadata')).not.toBeInTheDocument();
    });

    it('does not render a Search Metadata header or search query input', () => {
      renderModal();
      expect(screen.queryByText('Search Metadata')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Search query')).not.toBeInTheDocument();
      expect(screen.getByText('Edit Metadata')).toBeInTheDocument();
    });
  });

  it('does not call onClose when the backdrop is clicked (backdrop-click dismissal removed)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ onClose });
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderModal({ onClose });
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Cancel and Save footer buttons have explicit type="button"', () => {
    renderModal();

    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: /^save$/i })).toHaveAttribute('type', 'button');
  });

  describe('Strategy B migration (#484)', () => {
    it('renders when isOpen is not provided (defaults to true)', () => {
      renderModal();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('returns null when isOpen is false', () => {
      renderModal({ isOpen: false });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Edit Metadata')).not.toBeInTheDocument();
    });

    it('calls onClose when Escape is pressed with isOpen=true', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderModal({ onClose });
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('does not call onClose when Escape is pressed with isOpen=false', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderModal({ isOpen: false, onClose });
      await user.keyboard('{Escape}');
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe('ARIA attributes (#484)', () => {
    it('renders aria-labelledby linked to the heading id instead of aria-label', () => {
      renderModal();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-labelledby', 'book-metadata-modal-title');
      expect(dialog).not.toHaveAttribute('aria-label');
      const heading = document.getElementById('book-metadata-modal-title');
      expect(heading).toBeInTheDocument();
      expect(heading!.tagName).toBe('H2');
    });
  });
});

// ─── #2069 AC25: the modal diffs against what the operator SEES ───
//
// For a post-import book the series exists only as a provider fallback
// (`series_name = NULL`, `enrichmentStatus: 'enriched'` forever), so a
// stored-value baseline renders the input empty and blanking it produces no diff —
// the clear would be inexpressible for the most common book in the library.
describe('BookMetadataModal — displayed baseline (#2069 AC25)', () => {
  /** A book at `enriched` whose clearable columns are all empty. */
  const providerOnlyBook = createMockBook({
    title: 'Tress of the Emerald Sea',
    authors: [{ id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' }],
    narrators: [],
    enrichmentStatus: 'enriched',
    seriesName: null, seriesPosition: null, subtitle: null, description: null,
    publisher: null, publishedDate: null, genres: null,
    path: '/library/Brandon Sanderson/Tress of the Emerald Sea',
    status: 'imported',
  });

  const providerDisplayed = {
    seriesName: 'Secret Projects',
    seriesPosition: 1,
    subtitle: 'Provider Subtitle',
    description: 'Provider description',
    publisher: 'Dragonsteel',
    publishedDate: '2023-01-10',
    genres: ['Fantasy', 'Epic'],
  };

  /** The resolver output for a fully-tombstoned book — every field resolves to nothing. */
  const clearedDisplayed = {
    seriesName: undefined, seriesPosition: undefined, subtitle: undefined,
    description: undefined, publisher: undefined, publishedDate: undefined, genres: undefined,
  };

  function renderProviderOnly(overrides = {}) {
    return renderModal({ book: providerOnlyBook, displayed: providerDisplayed, ...overrides });
  }

  it('F11: renders the provider-only series and turns blanking it into a real null diff', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderProviderOnly({ onSave });

    expect(screen.getByLabelText(/series$/i)).toHaveValue('Secret Projects');

    await user.clear(screen.getByLabelText(/series$/i));
    await user.click(screen.getByText('Save'));

    // Without the displayed baseline the payload is empty and no tombstone can
    // ever exist for this book.
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ seriesName: null }), false);
    });
  });

  it('does NOT promote a provider value into the DB on an unrelated edit', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderProviderOnly({ onSave });

    await user.clear(screen.getByLabelText(/^title/i));
    await user.type(screen.getByLabelText(/^title/i), 'New Title');
    await user.click(screen.getByText('Save'));

    // This is the arm that makes the prefill change safe.
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.title).toBe('New Title');
    for (const key of ['seriesName', 'subtitle', 'description', 'publisher', 'publishedDate', 'genres']) {
      expect(payload).not.toHaveProperty(key);
    }
  });

  it('replacing a provider-only value sends the typed value, not null', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderProviderOnly({ onSave });

    await user.clear(screen.getByLabelText(/series$/i));
    await user.type(screen.getByLabelText(/series$/i), 'Cosmere');
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ seriesName: 'Cosmere' }), false);
    });
  });

  describe('F19 — reopening after a clear shows the field BLANK', () => {
    it.each([
      ['series', /series$/i],
      ['subtitle', /subtitle/i],
      ['description', /description/i],
      ['publisher', /publisher/i],
      ['published date', /published date/i],
      ['genres', /genres/i],
    ])('%s renders empty for a tombstoned book', (_label, labelMatcher) => {
      renderModal({ book: providerOnlyBook, displayed: clearedDisplayed });

      // An implementation that baselines on `stored ?? providerFallback` shows the
      // value the operator just removed.
      expect(screen.getByLabelText(labelMatcher)).toHaveValue('');
    });

    it('saving that reopened modal untouched sends no clearable key, so the tombstone survives', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ book: providerOnlyBook, displayed: clearedDisplayed, onSave });

      await user.click(screen.getByText('Save'));

      await waitFor(() => expect(onSave).toHaveBeenCalled());
      const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
      for (const key of ['seriesName', 'seriesPosition', 'subtitle', 'description', 'publisher', 'publishedDate', 'genres']) {
        expect(payload).not.toHaveProperty(key);
      }
    });
  });

  it('a stored empty string on a || field renders the provider value and IS clearable', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    // The resolver already applied `'' || provider`; the modal consumes its output.
    renderModal({
      book: createMockBook({ ...providerOnlyBook, publisher: '' }),
      displayed: providerDisplayed,
      onSave,
    });

    expect(screen.getByLabelText(/publisher/i)).toHaveValue('Dragonsteel');
    await user.clear(screen.getByLabelText(/publisher/i));
    await user.click(screen.getByText('Save'));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ publisher: null }), false);
    });
  });

  it('a stored genres: [] renders blank — the ?? override means there is no provider list to clear', () => {
    renderModal({
      book: createMockBook({ ...providerOnlyBook, genres: [] }),
      displayed: { ...providerDisplayed, genres: [] },
    });

    expect(screen.getByLabelText(/genres/i)).toHaveValue('');
  });

  it('seriesPosition is pre-filled from the resolved pair, not the stored column', () => {
    renderModal({ book: providerOnlyBook, displayed: providerDisplayed });
    expect(screen.getByLabelText(/position/i)).toHaveValue('1');
  });

  it('seriesPosition renders blank when the pair resolves to nothing', () => {
    renderModal({ book: providerOnlyBook, displayed: clearedDisplayed });
    expect(screen.getByLabelText(/position/i)).toHaveValue('');
  });

  describe('F22 — the baseline can settle AFTER the modal mounts', () => {
    it('adopts a late-arriving provider baseline for untouched fields, without reopening', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      // Opened BEFORE the provider metadata query resolved.
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <BookMetadataModal {...defaultProps} book={providerOnlyBook} onSave={onSave} />
        </QueryClientProvider>,
      );
      expect(screen.getByLabelText(/series$/i)).toHaveValue('');

      rerender(
        <QueryClientProvider client={queryClient}>
          <BookMetadataModal {...defaultProps} book={providerOnlyBook} displayed={providerDisplayed} onSave={onSave} />
        </QueryClientProvider>,
      );

      await waitFor(() => expect(screen.getByLabelText(/series$/i)).toHaveValue('Secret Projects'));

      await user.clear(screen.getByLabelText(/series$/i));
      await user.click(screen.getByText('Save'));
      await waitFor(() => {
        expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ seriesName: null }), false);
      });
    });

    it('never overwrites a field the operator has already typed into', async () => {
      const user = userEvent.setup();
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <BookMetadataModal {...defaultProps} book={providerOnlyBook} />
        </QueryClientProvider>,
      );

      await user.type(screen.getByLabelText(/series$/i), 'My Own Series');

      rerender(
        <QueryClientProvider client={queryClient}>
          <BookMetadataModal {...defaultProps} book={providerOnlyBook} displayed={providerDisplayed} />
        </QueryClientProvider>,
      );

      expect(screen.getByLabelText(/series$/i)).toHaveValue('My Own Series');
      // …while an untouched sibling still adopts the settled baseline.
      await waitFor(() => expect(screen.getByLabelText(/publisher/i)).toHaveValue('Dragonsteel'));
    });
  });

  it('with the prop absent every existing behavior holds (optional-prop compatibility)', () => {
    renderModal();

    expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
    expect(screen.getByLabelText(/publisher/i)).toHaveValue('Macmillan Audio');
    expect(screen.getByLabelText(/genres/i)).toHaveValue('Fantasy, Epic');
  });
});
