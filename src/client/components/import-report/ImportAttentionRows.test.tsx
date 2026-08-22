import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { ImportAttentionRows } from './ImportAttentionRows';
import type { StagedItemResultDto } from '@/lib/api';

describe('ImportAttentionRows (#1894, F19)', () => {
  it('renders ONLY attention rows in held → failed → skipped order, excluding accepted/pending', () => {
    const items: StagedItemResultDto[] = [
      { disposition: 'accepted', ordinal: 0, path: '/a', title: 'Accepted Book', bookId: 1 },
      { disposition: 'skipped', ordinal: 1, path: '/s', title: 'Skipped Book', reason: 'already-importing' },
      { disposition: 'pending', ordinal: 2, path: '/p', title: 'Pending Book' },
      { disposition: 'failed', ordinal: 3, path: '/f', title: 'Failed Book', message: 'kaboom' },
      { disposition: 'held', ordinal: 4, path: '/h', title: 'Held Book', reason: 'recording-review-required' },
    ];
    renderWithProviders(<ImportAttentionRows items={items} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((r) => within(r).getByText(/Book$/).textContent)).toEqual([
      'Held Book', 'Failed Book', 'Skipped Book',
    ]);
    expect(screen.queryByText('Accepted Book')).not.toBeInTheDocument();
    expect(screen.queryByText('Pending Book')).not.toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
  });

  it('renders nothing when there are no attention rows', () => {
    const { container } = renderWithProviders(
      <ImportAttentionRows items={[{ disposition: 'accepted', ordinal: 0, path: '/a', title: 'A', bookId: 1 }]} />,
    );
    expect(container.querySelector('[data-testid="import-attention-rows"]')).toBeNull();
  });

  it('renders every skipped optional-field/reason arm (F65)', () => {
    const items: StagedItemResultDto[] = [
      { disposition: 'skipped', ordinal: 0, path: '/0', title: 'Both Present', reason: 'already-in-library', existingBookId: 9, existingTitle: 'Dune' },
      { disposition: 'skipped', ordinal: 1, path: '/1', title: 'Title Only', reason: 'already-in-library', existingTitle: 'Foundation' },
      { disposition: 'skipped', ordinal: 2, path: '/2', title: 'Id Only', reason: 'already-in-library', existingBookId: 12 },
      { disposition: 'skipped', ordinal: 3, path: '/3', title: 'Neither', reason: 'already-in-library' },
      { disposition: 'skipped', ordinal: 4, path: '/4', title: 'Importing', reason: 'already-importing' },
    ];
    renderWithProviders(<ImportAttentionRows items={items} />);

    expect(screen.getByRole('link', { name: 'Dune' })).toHaveAttribute('href', '/books/9');
    expect(screen.getByText('Foundation')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Foundation' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'existing book' })).toHaveAttribute('href', '/books/12');
    expect(screen.getByText('already in library')).toBeInTheDocument();
    expect(screen.getByText('already importing')).toBeInTheDocument();
  });

  /**
   * #2091 AC18 — the whole value of the distinct reason is that the report names BOTH folders:
   * the candidate that was skipped and the library copy that made it a duplicate. The incumbent's
   * id and title remain independently optional, so the link-vs-text ladder still applies.
   */
  describe('duplicate-copy-at-other-path skips (#2091)', () => {
    const row = (ordinal: number, extra: Record<string, unknown>): StagedItemResultDto => ({
      disposition: 'skipped', ordinal,
      path: '/library/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin',
      title: 'Royal Assassin',
      reason: 'duplicate-copy-at-other-path',
      ...extra,
    } as StagedItemResultDto);

    it('names the candidate folder and the snapshotted library path, linking a surviving book', () => {
      renderWithProviders(<ImportAttentionRows items={[row(0, {
        existingBookId: 9, existingTitle: 'Royal Assassin (Farseer)',
        existingPath: '/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
      })]} />);

      const item = screen.getByRole('listitem');
      expect(within(item).getByText('/library/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin')).toBeInTheDocument();
      expect(within(item).getByText('/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin')).toBeInTheDocument();
      expect(within(item).getByRole('link', { name: 'Royal Assassin (Farseer)' })).toHaveAttribute('href', '/books/9');
      expect(within(item).queryByText('already in library')).not.toBeInTheDocument();
    });

    it('renders the incumbent as plain text once the book id is gone (set-null FK)', () => {
      renderWithProviders(<ImportAttentionRows items={[row(0, {
        existingTitle: 'Royal Assassin (Farseer)',
        existingPath: '/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
      })]} />);

      const item = screen.getByRole('listitem');
      expect(within(item).getByText('Royal Assassin (Farseer)')).toBeInTheDocument();
      expect(within(item).queryByRole('link')).not.toBeInTheDocument();
      expect(within(item).getByText('/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin')).toBeInTheDocument();
    });

    it('falls back to the generic incumbent label when neither id nor title survived', () => {
      renderWithProviders(<ImportAttentionRows items={[row(0, {
        existingPath: '/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin',
      })]} />);

      const item = screen.getByRole('listitem');
      expect(within(item).getByText('already in library')).toBeInTheDocument();
      expect(within(item).getByText('/library/Robin Hobb/Farseer Trilogy/02 - Royal Assassin')).toBeInTheDocument();
    });

    it('still renders the candidate folder when no incumbent path was snapshotted', () => {
      renderWithProviders(<ImportAttentionRows items={[row(0, { existingBookId: 9, existingTitle: 'Elsewhere' })]} />);

      const item = screen.getByRole('listitem');
      expect(within(item).getByText('/library/Robin Hobb/Realms of the Elderlings/02 - Royal Assassin')).toBeInTheDocument();
      expect(within(item).getByRole('link', { name: 'Elsewhere' })).toHaveAttribute('href', '/books/9');
      expect(within(item).queryByText(/undefined/)).not.toBeInTheDocument();
    });
  });
});
