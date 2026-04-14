import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { MetadataSearchView } from './MetadataSearchView';
import { createMockBookMetadata } from '@/__tests__/factories';

type ViewProps = ComponentProps<typeof MetadataSearchView>;

const defaultProps: ViewProps = {
  searchQuery: '',
  onSearchQueryChange: vi.fn(),
  isPending: false,
  searchResults: [],
  hasSearched: false,
  searchError: null,
  onSearch: vi.fn(),
  onApplyMetadata: vi.fn(),
};

function renderView(overrides: Partial<ViewProps> = {}) {
  return render(<MetadataSearchView {...defaultProps} {...overrides} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MetadataSearchView', () => {
  describe('search input', () => {
    it('renders search input with current query value', () => {
      renderView({ searchQuery: 'Brandon Sanderson' });
      expect(screen.getByLabelText('Search query')).toHaveValue('Brandon Sanderson');
    });

    it('calls onSearchQueryChange when input changes', async () => {
      const onSearchQueryChange = vi.fn();
      renderView({ onSearchQueryChange });
      await userEvent.type(screen.getByLabelText('Search query'), 'a');
      expect(onSearchQueryChange).toHaveBeenCalledWith('a');
    });

    it('triggers search on Enter key press', async () => {
      const onSearch = vi.fn();
      renderView({ searchQuery: 'test', onSearch });
      await userEvent.type(screen.getByLabelText('Search query'), '{Enter}');
      expect(onSearch).toHaveBeenCalledOnce();
    });

    it('disables search button when query is empty', () => {
      renderView({ searchQuery: '' });
      expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
    });

    it('disables search button when query is whitespace only', () => {
      renderView({ searchQuery: '   ' });
      expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
    });

    it('disables search button when search is pending', () => {
      renderView({ searchQuery: 'test', isPending: true });
      expect(screen.getByRole('button', { name: /search/i })).toBeDisabled();
    });
  });

  describe('search results', () => {
    it('renders up to 8 search results', () => {
      const searchResults = Array.from({ length: 10 }, (_, i) =>
        createMockBookMetadata({ asin: `ASIN${i}`, title: `Book ${i}` }),
      );
      renderView({ searchResults });
      const buttons = screen.getAllByRole('button').filter(b => b.textContent?.includes('Book'));
      expect(buttons).toHaveLength(8);
    });

    it('displays title and authors', () => {
      const meta = createMockBookMetadata({ title: 'Test Book', authors: [{ name: 'Jane Doe', asin: 'A1' }] });
      renderView({ searchResults: [meta] });
      expect(screen.getByText('Test Book')).toBeInTheDocument();
      expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    });

    it('displays narrators when present', () => {
      const meta = createMockBookMetadata({ narrators: ['Narrator One'] });
      renderView({ searchResults: [meta] });
      expect(screen.getByText('Narrator One')).toBeInTheDocument();
    });

    it('displays series info when present', () => {
      const meta = createMockBookMetadata({ series: [{ name: 'Epic Series', position: 3 }] });
      renderView({ searchResults: [meta] });
      expect(screen.getByText('Epic Series #3')).toBeInTheDocument();
    });

    it('calls onApplyMetadata with selected metadata on click', async () => {
      const onApplyMetadata = vi.fn();
      const meta = createMockBookMetadata({ title: 'Click Me' });
      renderView({ searchResults: [meta], onApplyMetadata });
      await userEvent.click(screen.getByText('Click Me'));
      expect(onApplyMetadata).toHaveBeenCalledWith(meta);
    });
  });

  describe('empty and error states', () => {
    it('shows error message when searchError is non-null', () => {
      renderView({ searchError: 'Network error' });
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });

    it('shows "No results found" when hasSearched and results empty', () => {
      renderView({ hasSearched: true, searchResults: [] });
      expect(screen.getByText(/No results found/)).toBeInTheDocument();
    });

    it('does not show "No results found" when searchError exists', () => {
      renderView({ hasSearched: true, searchResults: [], searchError: 'error' });
      expect(screen.queryByText(/No results found/)).not.toBeInTheDocument();
    });

    it('shows initial state prompt before first search', () => {
      renderView({ hasSearched: false, isPending: false, searchError: null });
      expect(screen.getByText(/Search to find metadata/)).toBeInTheDocument();
    });

    it('hides initial state prompt when pending', () => {
      renderView({ hasSearched: false, isPending: true, searchError: null });
      expect(screen.queryByText(/Search to find metadata/)).not.toBeInTheDocument();
    });
  });
});
