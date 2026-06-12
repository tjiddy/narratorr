import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PathDiffRow } from './parts';

/**
 * F5 (#1439): `PathDiffRow` diffs a from→to path pair positionally on `/`,
 * dimming the segments that stayed the same and leaving the changed segment(s)
 * full-tone so the eye lands on exactly the rename delta. Unchanged segments
 * carry `opacity-50`; changed segments carry no opacity class.
 */
describe('PathDiffRow segment emphasis (F5)', () => {
  it('dims unchanged segments and emphasizes the single changed one', () => {
    render(
      <PathDiffRow
        from="Ursula K. Le Guin/The Earthsea Quartet/01 - A Wizard of Earthsea"
        to="Ursula K. Le Guin/Earthsea Cycle/01 - A Wizard of Earthsea"
      />,
    );

    // Unchanged segments appear on both the − and + lines, all dimmed.
    for (const el of screen.getAllByText('Ursula K. Le Guin')) {
      expect(el.className).toContain('opacity-50');
    }
    for (const el of screen.getAllByText('01 - A Wizard of Earthsea')) {
      expect(el.className).toContain('opacity-50');
    }

    // The one changed segment per line is full-tone (no opacity class).
    expect(screen.getByText('The Earthsea Quartet').className).not.toContain('opacity-50');
    expect(screen.getByText('Earthsea Cycle').className).not.toContain('opacity-50');
  });

  it('dims every segment when the paths are identical', () => {
    render(<PathDiffRow from="Author/Series" to="Author/Series" />);

    for (const el of [...screen.getAllByText('Author'), ...screen.getAllByText('Series')]) {
      expect(el.className).toContain('opacity-50');
    }
  });

  it('treats a single-segment path (no slash) as one full-tone segment when it differs', () => {
    render(<PathDiffRow from="Book" to="Other" />);

    expect(screen.getByText('Book').className).not.toContain('opacity-50');
    expect(screen.getByText('Other').className).not.toContain('opacity-50');
  });

  it('dims a single-segment path when it is identical', () => {
    render(<PathDiffRow from="Book" to="Book" />);

    for (const el of screen.getAllByText('Book')) {
      expect(el.className).toContain('opacity-50');
    }
  });

  it('emphasizes the longer path’s trailing segment when segment counts differ', () => {
    render(<PathDiffRow from="A/B/C" to="A/B" />);

    // A and B match positionally on both lines → dimmed.
    for (const el of [...screen.getAllByText('A'), ...screen.getAllByText('B')]) {
      expect(el.className).toContain('opacity-50');
    }
    // C has no counterpart in the shorter path → full-tone.
    expect(screen.getByText('C').className).not.toContain('opacity-50');
  });

  it('preserves a trailing-slash difference in display instead of swallowing it', () => {
    const { container } = render(<PathDiffRow from="A/B/" to="A/B" />);
    const [fromLine, toLine] = Array.from(container.querySelectorAll('div'));

    // The − (from) line keeps its trailing slash; the + (to) line does not.
    expect(fromLine?.textContent?.endsWith('/')).toBe(true);
    expect(toLine?.textContent?.endsWith('/')).toBe(false);
  });
});
