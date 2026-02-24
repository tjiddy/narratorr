import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BookHero } from './BookHero';

const defaultProps = {
  title: 'The Way of Kings',
  authorName: 'Brandon Sanderson',
  coverUrl: 'https://example.com/cover.jpg',
  metaDots: ['45h 0m', 'Fantasy', 'The Stormlight Archive #1'],
  statusLabel: 'Wanted',
  statusDotClass: 'bg-yellow-500',
  hasPath: true,
  onBackClick: vi.fn(),
  onSearchClick: vi.fn(),
  onEditClick: vi.fn(),
  onRenameClick: vi.fn(),
  isRenaming: false,
};

function renderHero(overrides = {}) {
  return render(
    <MemoryRouter>
      <BookHero {...defaultProps} {...overrides} />
    </MemoryRouter>,
  );
}

describe('BookHero', () => {
  it('renders title', () => {
    renderHero();
    expect(screen.getByRole('heading', { level: 1, name: 'The Way of Kings' })).toBeInTheDocument();
  });

  it('renders subtitle when provided', () => {
    renderHero({ subtitle: 'Book One of the Stormlight Archive' });
    expect(screen.getByText('Book One of the Stormlight Archive')).toBeInTheDocument();
  });

  it('renders author as link when authorAsin is provided', () => {
    renderHero({ authorAsin: 'B001IGFHW6' });
    const link = screen.getByRole('link', { name: 'Brandon Sanderson' });
    expect(link).toHaveAttribute('href', '/authors/B001IGFHW6');
  });

  it('renders author as plain text when no authorAsin', () => {
    renderHero({ authorAsin: null });
    expect(screen.getByText('Brandon Sanderson')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Brandon Sanderson' })).not.toBeInTheDocument();
  });

  it('renders narrator names', () => {
    renderHero({ narratorNames: 'Michael Kramer, Kate Reading' });
    expect(screen.getByText('Narrated by Michael Kramer, Kate Reading')).toBeInTheDocument();
  });

  it('renders meta dots joined with separator', () => {
    renderHero({ metaDots: ['45h 0m', 'Fantasy'] });
    expect(screen.getByText('45h 0m · Fantasy')).toBeInTheDocument();
  });

  it('renders status badge', () => {
    renderHero();
    expect(screen.getByText('Wanted')).toBeInTheDocument();
  });

  it('renders cover image when coverUrl is provided', () => {
    renderHero();
    expect(screen.getByAltText('Cover of The Way of Kings')).toBeInTheDocument();
  });

  it('renders fallback icon when no coverUrl', () => {
    renderHero({ coverUrl: undefined });
    expect(screen.queryByAltText('Cover of The Way of Kings')).not.toBeInTheDocument();
  });

  it('calls onBackClick when Library button is clicked', async () => {
    const onBackClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onBackClick });

    await user.click(screen.getByText('Library'));
    expect(onBackClick).toHaveBeenCalledTimes(1);
  });

  it('calls onSearchClick when Search Releases button is clicked', async () => {
    const onSearchClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onSearchClick });

    await user.click(screen.getByText('Search Releases'));
    expect(onSearchClick).toHaveBeenCalledTimes(1);
  });

  it('calls onEditClick when Edit button is clicked', async () => {
    const onEditClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onEditClick });

    await user.click(screen.getByText('Edit'));
    expect(onEditClick).toHaveBeenCalledTimes(1);
  });

  it('calls onRenameClick when Rename button is clicked', async () => {
    const onRenameClick = vi.fn();
    const user = userEvent.setup();
    renderHero({ onRenameClick });

    await user.click(screen.getByText('Rename'));
    expect(onRenameClick).toHaveBeenCalledTimes(1);
  });

  it('hides Rename button when book has no path', () => {
    renderHero({ hasPath: false });
    expect(screen.queryByText('Rename')).not.toBeInTheDocument();
  });

  it('disables Rename button when renaming is in progress', () => {
    renderHero({ isRenaming: true });
    expect(screen.getByText('Renaming...')).toBeInTheDocument();
    expect(screen.getByText('Renaming...').closest('button')).toBeDisabled();
  });
});
