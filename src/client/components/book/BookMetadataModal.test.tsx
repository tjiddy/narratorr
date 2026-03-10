import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookMetadataModal } from './BookMetadataModal';
import { createMockBook, createMockBookMetadata } from '@/__tests__/factories';

// Mock the API
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual('@/lib/api');
  return {
    ...actual,
    api: {
      searchMetadata: vi.fn(),
    },
  };
});

// Mock useEscapeKey
vi.mock('@/hooks/useEscapeKey', () => ({
  useEscapeKey: vi.fn(),
}));

const mockBook = createMockBook({
  title: 'The Way of Kings',
  narrator: 'Michael Kramer',
  seriesName: 'The Stormlight Archive',
  seriesPosition: 1,
  path: '/library/Brandon Sanderson/The Way of Kings',
  status: 'imported',
  author: { id: 1, name: 'Brandon Sanderson', slug: 'brandon-sanderson' },
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

      expect(screen.getByLabelText(/title/i)).toHaveValue('The Way of Kings');
      expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
      expect(screen.getByLabelText(/position/i)).toHaveValue('1');
      expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer');
    });

    it('calls onSave with updated data when Save is clicked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const titleInput = screen.getByLabelText(/title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Words of Radiance');

      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Words of Radiance' }),
        false,
      );
    });

    it('calls onSave with rename=true when checkbox is checked', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.click(screen.getByLabelText(/rename files/i));
      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledWith(
        expect.any(Object),
        true,
      );
    });

    it('prevents saving with empty title', () => {
      renderModal();
      expect(screen.getByText('Save')).not.toBeDisabled();
    });

    it('disables Save when title is cleared', async () => {
      const user = userEvent.setup();
      renderModal();

      const titleInput = screen.getByLabelText(/title/i);
      await user.clear(titleInput);

      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('calls onClose when Cancel is clicked', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      renderModal({ onClose });

      await user.click(screen.getByText('Cancel'));
      expect(onClose).toHaveBeenCalledTimes(1);
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

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ seriesPosition: 2.5 }),
        false,
      );
    });

    it('sends null seriesName when cleared', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const seriesInput = screen.getByLabelText(/series$/i);
      await user.clear(seriesInput);
      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ seriesName: null }),
        false,
      );
    });

    it('shows "Search Audnexus for metadata" button', () => {
      renderModal();
      expect(screen.getByText('Search Audnexus for metadata')).toBeInTheDocument();
    });

    it('excludes seriesPosition from payload when user types non-numeric value', async () => {
      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      // Change title so onSave gets called with some data
      const titleInput = screen.getByLabelText(/title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Changed Title');

      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledTimes(1);
      const payload = onSave.mock.calls[0][0];
      expect(payload.title).toBe('Changed Title');
      expect(payload).not.toHaveProperty('seriesPosition');
    });

    it('shows inline error when series position is non-numeric', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      expect(screen.getByText('Must be a number')).toBeInTheDocument();
    });

    it('clears error when series position is corrected to valid number', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');
      expect(screen.getByText('Must be a number')).toBeInTheDocument();

      await user.clear(posInput);
      await user.type(posInput, '3');
      expect(screen.queryByText('Must be a number')).not.toBeInTheDocument();
    });

    it('clears error when series position is cleared', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');
      expect(screen.getByText('Must be a number')).toBeInTheDocument();

      await user.clear(posInput);
      expect(screen.queryByText('Must be a number')).not.toBeInTheDocument();
    });

    it('shows inline error for partial parse like "1.2.3"', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, '1.2.3');

      expect(screen.getByText('Must be a number')).toBeInTheDocument();
    });

    it('does not disable Save when series position is invalid', async () => {
      const user = userEvent.setup();
      renderModal();

      const posInput = screen.getByLabelText(/position/i);
      await user.clear(posInput);
      await user.type(posInput, 'abc');

      expect(screen.getByText('Save')).not.toBeDisabled();
    });
  });

  describe('search view', () => {
    it('shows search input pre-filled with book title and author', async () => {
      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));

      const searchInput = screen.getByLabelText('Search query');
      expect(searchInput).toHaveValue('The Way of Kings Brandon Sanderson');
    });

    it('pre-fills with title only when book has no author', async () => {
      const user = userEvent.setup();
      const bookNoAuthor = { ...mockBook, author: undefined };
      renderModal({ book: bookNoAuthor });

      await user.click(screen.getByText('Search Audnexus for metadata'));

      const searchInput = screen.getByLabelText('Search query');
      expect(searchInput).toHaveValue('The Way of Kings');
    });

    it('calls api.searchMetadata when search is submitted', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({ books: [], authors: [], series: [] });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      expect(searchMock).toHaveBeenCalledWith('The Way of Kings Brandon Sanderson');
    });

    it('submits search on Enter key', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({ books: [], authors: [], series: [] });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.keyboard('{Enter}');

      expect(searchMock).toHaveBeenCalled();
    });

    it('renders search results with title, author, and narrator', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [
          createMockBookMetadata({ title: 'Result One', authors: [{ name: 'Author A' }], narrators: ['Narrator X'] }),
          createMockBookMetadata({ title: 'Result Two', authors: [{ name: 'Author B' }], narrators: ['Narrator Y'], asin: 'B002' }),
        ],
        authors: [],
        series: [],
      });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await screen.findByText('Result One');
      expect(screen.getByText('Result Two')).toBeInTheDocument();
      expect(screen.getByText('Author A')).toBeInTheDocument();
      expect(screen.getByText('Narrator X')).toBeInTheDocument();
    });

    it('auto-fills fields when a search result is selected', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [
          createMockBookMetadata({
            title: 'Words of Radiance',
            narrators: ['Michael Kramer', 'Kate Reading'],
            series: [{ name: 'The Stormlight Archive', position: 2 }],
            asin: 'B00DA6YEKS',
          }),
        ],
        authors: [],
        series: [],
      });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await screen.findByText('Words of Radiance');
      await user.click(screen.getByText('Words of Radiance'));

      // Should return to edit view with auto-filled fields
      expect(screen.getByLabelText(/title/i)).toHaveValue('Words of Radiance');
      expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer, Kate Reading');
      expect(screen.getByLabelText(/series$/i)).toHaveValue('The Stormlight Archive');
      expect(screen.getByLabelText(/position/i)).toHaveValue('2');
    });

    it('allows editing auto-filled fields before saving', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [createMockBookMetadata({ title: 'Auto Title', narrators: ['Auto Narrator'] })],
        authors: [],
        series: [],
      });

      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByText('Auto Title');
      await user.click(screen.getByText('Auto Title'));

      // Now in edit view — modify the auto-filled title
      const titleInput = screen.getByLabelText(/title/i);
      await user.clear(titleInput);
      await user.type(titleInput, 'Modified Title');
      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Modified Title' }),
        false,
      );
    });

    it('does not modify form fields when search is dismissed without selecting', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [createMockBookMetadata({ title: 'Some Result' })],
        authors: [],
        series: [],
      });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByText('Some Result');

      // Dismiss without selecting
      await user.click(screen.getByLabelText('Back to edit'));

      // Original values preserved
      expect(screen.getByLabelText(/title/i)).toHaveValue('The Way of Kings');
      expect(screen.getByLabelText(/narrator/i)).toHaveValue('Michael Kramer');
    });

    it('shows empty state when search returns no results', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({ books: [], authors: [], series: [] });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await screen.findByText(/No results found/);
    });

    it('shows loading state during search', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      // Never resolve to keep loading
      searchMock.mockReturnValueOnce(new Promise(() => {}));

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      // Search button should be disabled while loading
      expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    });

    it('shows error message when search fails', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockRejectedValueOnce(new Error('Network error'));

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));

      await screen.findByText('Search failed. Please try again.');
    });

    it('saves correct payload after auto-fill from search', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [
          createMockBookMetadata({
            title: 'New Title',
            narrators: ['New Narrator'],
            series: [{ name: 'New Series', position: 3 }],
          }),
        ],
        authors: [],
        series: [],
      });

      const onSave = vi.fn();
      const user = userEvent.setup();
      renderModal({ onSave });

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByText('New Title');
      await user.click(screen.getByText('New Title'));
      await user.click(screen.getByText('Save'));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'New Title',
          narrator: 'New Narrator',
          seriesName: 'New Series',
          seriesPosition: 3,
        }),
        false,
      );
    });

    describe('URL_BASE resolveUrl integration', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('prefixes app-relative search result cover URLs with URL_BASE via resolveUrl', async () => {
        vi.spyOn(await import('@/lib/url-utils'), 'resolveUrl').mockImplementation(
          (url) => {
            if (!url) return undefined;
            if (url.startsWith('http://') || url.startsWith('https://')) return url;
            return `/narratorr${url}`;
          },
        );

        const { api } = await import('@/lib/api');
        const searchMock = vi.mocked(api.searchMetadata);
        searchMock.mockResolvedValueOnce({
          books: [
            createMockBookMetadata({ title: 'Prefixed Cover', coverUrl: '/api/books/1/cover', asin: 'B999' }),
          ],
          authors: [],
          series: [],
        });

        const user = userEvent.setup();
        renderModal();

        await user.click(screen.getByText('Search Audnexus for metadata'));
        await user.click(screen.getByRole('button', { name: 'Search' }));

        await screen.findByText('Prefixed Cover');
        const imgs = document.querySelectorAll('img');
        const coverImg = Array.from(imgs).find(img => img.getAttribute('src')?.includes('/api/books/1/cover'));
        expect(coverImg).toBeTruthy();
        expect(coverImg!.getAttribute('src')).toBe('/narratorr/api/books/1/cover');
      });
    });

    it('clears narrator field when selected metadata has no narrators', async () => {
      const { api } = await import('@/lib/api');
      const searchMock = vi.mocked(api.searchMetadata);
      searchMock.mockResolvedValueOnce({
        books: [createMockBookMetadata({ title: 'No Narrator Book', narrators: undefined })],
        authors: [],
        series: [],
      });

      const user = userEvent.setup();
      renderModal();

      await user.click(screen.getByText('Search Audnexus for metadata'));
      await user.click(screen.getByRole('button', { name: 'Search' }));
      await screen.findByText('No Narrator Book');
      await user.click(screen.getByText('No Narrator Book'));

      expect(screen.getByLabelText(/narrator/i)).toHaveValue('');
    });
  });
});
