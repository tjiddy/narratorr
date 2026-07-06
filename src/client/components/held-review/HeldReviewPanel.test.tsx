import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeldReviewPanel } from './HeldReviewPanel';
import type { HeldReviewItem } from '@/lib/api';

const HELD: HeldReviewItem[] = [
  { path: '/a/Book One', title: 'Book One', reason: 'recording-review-required' },
  { path: '/a/Book Two', title: 'Book Two', reason: 'recording-review-required' },
];

describe('HeldReviewPanel', () => {
  it('renders nothing when there are no held items', () => {
    const { container } = render(
      <HeldReviewPanel heldReview={[]} onReconfirm={vi.fn()} isPending={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the held titles, count, and a re-confirm button', () => {
    render(<HeldReviewPanel heldReview={HELD} onReconfirm={vi.fn()} isPending={false} />);

    const panel = screen.getByTestId('held-review-panel');
    expect(within(panel).getByText('2 items held for recording review')).toBeInTheDocument();
    expect(within(panel).getByText('Book One')).toBeInTheDocument();
    expect(within(panel).getByText('Book Two')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /re-confirm and import/i })).toBeEnabled();
  });

  it('singularizes the count for a single held item', () => {
    render(<HeldReviewPanel heldReview={[HELD[0]!]} onReconfirm={vi.fn()} isPending={false} />);
    expect(screen.getByText('1 item held for recording review')).toBeInTheDocument();
  });

  it('fires onReconfirm when the button is clicked', async () => {
    const onReconfirm = vi.fn();
    render(<HeldReviewPanel heldReview={HELD} onReconfirm={onReconfirm} isPending={false} />);

    await userEvent.click(screen.getByRole('button', { name: /re-confirm and import/i }));
    expect(onReconfirm).toHaveBeenCalledTimes(1);
  });

  it('disables the button and shows a pending label while importing', () => {
    render(<HeldReviewPanel heldReview={HELD} onReconfirm={vi.fn()} isPending />);
    const btn = screen.getByRole('button', { name: /importing/i });
    expect(btn).toBeDisabled();
  });
});
