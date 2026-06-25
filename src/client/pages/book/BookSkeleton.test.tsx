import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BookSkeleton } from './BookSkeleton';

describe('BookSkeleton', () => {
  it('renders a square cover placeholder matching the loaded BookHero cover footprint', () => {
    const { container } = render(<BookSkeleton />);

    // The cover placeholder is the skeleton block inside the hero row that
    // mirrors BookHero's cover box (w-44 sm:w-48 lg:w-56 aspect-square).
    const cover = container.querySelector('.aspect-square');
    expect(cover).not.toBeNull();

    // Square at all three breakpoints — same footprint as the loaded cover,
    // so the hero layout does not shift when the real cover appears.
    expect(cover).toHaveClass('w-44', 'sm:w-48', 'lg:w-56', 'aspect-square');

    // Positioning + styling preserved from the original placeholder.
    expect(cover).toHaveClass('skeleton', 'rounded-2xl', 'shrink-0', 'mx-auto', 'sm:mx-0');

    // Guard against the old portrait geometry regressing.
    expect(cover).not.toHaveClass('aspect-[2/3]', 'w-48', 'sm:w-56', 'lg:w-72');
  });
});
