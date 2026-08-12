import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BookSkeleton } from './BookSkeleton';

describe('BookSkeleton', () => {
  it('renders a square cover placeholder matching the loaded BookHero cover footprint', () => {
    const { container } = render(<BookSkeleton />);

    const cover = container.querySelector('.aspect-square');
    expect(cover).not.toBeNull();

    expect(cover).toHaveClass('w-44', 'sm:w-48', 'lg:w-56', 'aspect-square');

    expect(cover).toHaveClass('skeleton', 'rounded-2xl', 'shrink-0', 'mx-auto', 'sm:mx-0');

    expect(cover).not.toHaveClass('aspect-[2/3]', 'w-48', 'sm:w-56', 'lg:w-72');
  });
});
