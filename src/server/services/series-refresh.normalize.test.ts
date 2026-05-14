import { describe, expect, it } from 'vitest';
import { normalizeSeriesMemberWorkTitle } from './series-refresh.dedupe.js';

describe('normalizeSeriesMemberWorkTitle (#1116)', () => {
  it('strips (Part N of M) split suffixes', () => {
    expect(normalizeSeriesMemberWorkTitle('Golden Son (Part 1 of 2)')).toBe('golden son');
    expect(normalizeSeriesMemberWorkTitle('Golden Son (Part 2 of 2)')).toBe('golden son');
    expect(normalizeSeriesMemberWorkTitle('Way of Kings (Part 1 of 3)')).toBe('way of kings');
  });

  it('strips (N of M) split suffixes without the "Part" prefix', () => {
    expect(normalizeSeriesMemberWorkTitle('Morning Star (1 of 2)')).toBe('morning star');
    expect(normalizeSeriesMemberWorkTitle('Morning Star (2 of 2)')).toBe('morning star');
  });

  it('strips dramatized adaptation suffixes', () => {
    expect(normalizeSeriesMemberWorkTitle('Red Rising (Dramatized Adaptation)')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('Red Rising (Dramatized Adaptation: Special)')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('Red Rising (Dramatized)')).toBe('red rising');
  });

  it('strips edition descriptor suffixes', () => {
    expect(normalizeSeriesMemberWorkTitle('Foundation (Unabridged)')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Foundation (Abridged)')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Hitchhiker (Original Recording)')).toBe('hitchhiker');
  });

  it('strips stacked suffixes', () => {
    expect(normalizeSeriesMemberWorkTitle('Golden Son (Part 1 of 2) (Dramatized Adaptation)')).toBe('golden son');
    expect(normalizeSeriesMemberWorkTitle('Golden Son (Dramatized Adaptation) (Part 1 of 2)')).toBe('golden son');
    expect(normalizeSeriesMemberWorkTitle('Foundation (Abridged) (Original Recording)')).toBe('foundation');
  });

  it('does NOT strip real subtitles in parens', () => {
    expect(normalizeSeriesMemberWorkTitle('Foo (A Novel)')).toBe('foo a novel');
    expect(normalizeSeriesMemberWorkTitle('Bar (The Sequel)')).toBe('bar the sequel');
  });

  it('matches normalizeSeriesName output when no descriptor suffix is present', () => {
    // Tier-1 cleanTitleScore in pickCanonical depends on this equality holding
    // for unsuffixed titles so the "clean wins" tier doesn't fire spuriously.
    expect(normalizeSeriesMemberWorkTitle('Red Rising')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('  Red   Rising  ')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('Wax & Wayne')).toBe('wax wayne');
  });

  it('is case-insensitive across descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Foo (PART 1 OF 2)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo (DRAMATIZED ADAPTATION)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo (UNABRIDGED)')).toBe('foo');
  });

  it('strips bracket-wrapped descriptors (Audible surfaces some as [Dramatized Adaptation])', () => {
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized Adaptation]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Foundation [Unabridged]')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Foundation [Abridged]')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Hitchhiker [Original Recording]')).toBe('hitchhiker');
    expect(normalizeSeriesMemberWorkTitle('Morning Star [1 of 2]')).toBe('morning star');
    expect(normalizeSeriesMemberWorkTitle('Way of Kings [Part 1 of 3]')).toBe('way of kings');
  });

  it('strips bracket descriptors combined with paren descriptors (the original Dark Age case)', () => {
    // Real-world row from Audnexus relationships:
    // "Dark Age (3 of 3) [Dramatized Adaptation]" — must collapse to "dark age"
    // so it dedupes against the canonical "Dark Age" member at the same position.
    expect(normalizeSeriesMemberWorkTitle('Dark Age (3 of 3) [Dramatized Adaptation]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized Adaptation] (3 of 3)')).toBe('dark age');
  });

  it('is case-insensitive on bracket descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Foo [DRAMATIZED ADAPTATION]')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo [UNABRIDGED]')).toBe('foo');
  });

  it('does NOT strip real bracketed series tags that are not edition descriptors', () => {
    // Audible uses brackets for publisher/origin tags like [Audible Studios] and
    // [Audible Original]. Those are not editions of a work — they identify the
    // producer or production line — and must NOT collapse logical-work identity.
    expect(normalizeSeriesMemberWorkTitle('Foo [Audible Studios]')).toBe('foo audible studios');
    expect(normalizeSeriesMemberWorkTitle('Foo [Audible Original]')).toBe('foo audible original');
  });
});
