import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../__tests__/helpers';
import { NoMatchState } from './NoMatchState';

describe('NoMatchState', () => {
  it('renders heading message', () => {
    renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="" />);
    expect(screen.getByText('No books match your filters')).toBeInTheDocument();
  });

  it('renders helper text', () => {
    renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="" />);
    expect(screen.getByText('Try adjusting your filters to see more results')).toBeInTheDocument();
  });

  it('renders Clear Filters button', () => {
    renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="" />);
    expect(screen.getByText('Clear Filters')).toBeInTheDocument();
  });

  it('calls onClearFilters when button is clicked', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    renderWithProviders(<NoMatchState onClearFilters={onClearFilters} searchQuery="" />);

    await user.click(screen.getByText('Clear Filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  describe('#322 Add Book button', () => {
    it('renders Add Book link alongside Clear Filters button', () => {
      renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="" />);
      expect(screen.getByText('Add Book')).toBeInTheDocument();
      expect(screen.getByText('Clear Filters')).toBeInTheDocument();
    });

    it('links to /search with no query param when searchQuery is empty', () => {
      renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="" />);
      const link = screen.getByText('Add Book').closest('a');
      expect(link).toHaveAttribute('href', '/search');
    });

    it('links to /search?q=<encoded-query> when searchQuery is present', () => {
      renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="the tower" />);
      const link = screen.getByText('Add Book').closest('a');
      expect(link).toHaveAttribute('href', '/search?q=the+tower');
    });

    it('URL-encodes special characters in search query', () => {
      renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="king's cage & more" />);
      const link = screen.getByText('Add Book').closest('a');
      const href = link?.getAttribute('href') ?? '';
      expect(href).toContain('/search?q=');
      // URLSearchParams encodes & and ' correctly
      expect(href).not.toContain('&more');
      const params = new URLSearchParams(href.split('?')[1]);
      expect(params.get('q')).toBe("king's cage & more");
    });

    it('omits ?q= when searchQuery is whitespace-only', () => {
      renderWithProviders(<NoMatchState onClearFilters={vi.fn()} searchQuery="   " />);
      const link = screen.getByText('Add Book').closest('a');
      expect(link).toHaveAttribute('href', '/search');
    });
  });
});
