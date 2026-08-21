import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImportListExclusionRow } from './ImportListExclusionRow';
import type { ImportListExclusion } from '@/lib/api';

const entry: ImportListExclusion = {
  id: 1,
  asin: 'B0ABC12345',
  title: 'The Reckoning',
  authorName: 'Jane Doe',
  authorSlug: 'jane-doe',
  importListId: 5,
  importListName: 'NYT Bestsellers',
  kind: 'deleted',
  createdAt: '2026-06-15T12:00:00Z',
};

const added: ImportListExclusion = { ...entry, id: 3, title: 'General Thinking Concepts', kind: 'added' };

const bare: ImportListExclusion = {
  ...entry,
  id: 2,
  asin: null,
  title: 'A Nameless Source',
  authorName: null,
  authorSlug: null,
  importListId: null,
  importListName: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImportListExclusionRow', () => {
  it('renders the title, author, source list and ASIN', () => {
    render(<ImportListExclusionRow entry={entry} index={0} onRemove={vi.fn()} />);

    expect(screen.getByText('The Reckoning')).toBeInTheDocument();
    expect(screen.getByText('Jane Doe')).toBeInTheDocument();
    expect(screen.getByText('NYT Bestsellers')).toBeInTheDocument();
    expect(screen.getByText('B0ABC12345')).toBeInTheDocument();
  });

  it('names the kind on the card so a mixed reading of the page is impossible (#2530)', () => {
    const { rerender } = render(<ImportListExclusionRow entry={entry} index={0} onRemove={vi.fn()} />);
    expect(screen.getByText('Deleted')).toBeInTheDocument();
    expect(screen.queryByText('Added by a list')).not.toBeInTheDocument();

    rerender(<ImportListExclusionRow entry={added} index={0} onRemove={vi.fn()} />);

    expect(screen.getByText('Added by a list')).toBeInTheDocument();
    expect(screen.queryByText('Deleted')).not.toBeInTheDocument();
  });

  it('omits the author and ASIN chips and names the source when the row carries neither', () => {
    render(<ImportListExclusionRow entry={bare} index={0} onRemove={vi.fn()} />);

    expect(screen.getByText('A Nameless Source')).toBeInTheDocument();
    expect(screen.getByText('Unknown list')).toBeInTheDocument();
    expect(screen.queryByText('B0ABC12345')).not.toBeInTheDocument();
    expect(screen.queryByText('Jane Doe')).not.toBeInTheDocument();
  });

  it('hands the whole entry back to onRemove so the page needs no per-row closure', async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();

    render(<ImportListExclusionRow entry={entry} index={0} onRemove={onRemove} />);
    await user.click(screen.getByLabelText('Remove exclusion for The Reckoning'));

    expect(onRemove).toHaveBeenCalledWith(entry);
  });

  it('does not re-run its body when the parent rerenders with identical props (REACT-2)', () => {
    // `toLocaleDateString` runs once per executed render, so its call count is the observable for
    // whether memo actually held. A per-row closure in the page's `.map()` would break this.
    const onRemove = vi.fn();
    const dateSpy = vi.spyOn(Date.prototype, 'toLocaleDateString');

    const { rerender } = render(<ImportListExclusionRow entry={entry} index={0} onRemove={onRemove} />);
    expect(dateSpy).toHaveBeenCalledTimes(1);

    rerender(<ImportListExclusionRow entry={entry} index={0} onRemove={onRemove} />);

    expect(dateSpy).toHaveBeenCalledTimes(1);
  });

  it('does re-run when the entry it renders actually changes', () => {
    const onRemove = vi.fn();
    const dateSpy = vi.spyOn(Date.prototype, 'toLocaleDateString');

    const { rerender } = render(<ImportListExclusionRow entry={entry} index={0} onRemove={onRemove} />);
    rerender(<ImportListExclusionRow entry={bare} index={0} onRemove={onRemove} />);

    expect(dateSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByText('A Nameless Source')).toBeInTheDocument();
  });
});
