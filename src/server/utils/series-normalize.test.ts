import { describe, expect, it } from 'vitest';
import { normalizeSeriesName } from './series-normalize.js';
import { normalizeSeriesMemberWorkTitle } from './series-match.js';

describe('normalizeSeriesName', () => {
  it('lowercases and collapses non-alphanumeric runs', () => {
    expect(normalizeSeriesName('The Stormlight Archive')).toBe('the stormlight archive');
    expect(normalizeSeriesName('Wax & Wayne')).toBe('wax wayne');
    expect(normalizeSeriesName("Hitchhiker's Guide")).toBe('hitchhiker s guide');
    expect(normalizeSeriesName('  multiple   spaces  ')).toBe('multiple spaces');
  });
});

describe('normalizeSeriesMemberWorkTitle (relocated from series-refresh.normalize.test.ts)', () => {
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
    expect(normalizeSeriesMemberWorkTitle('Red Rising')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('  Red   Rising  ')).toBe('red rising');
    expect(normalizeSeriesMemberWorkTitle('Wax & Wayne')).toBe('wax wayne');
  });

  it('is case-insensitive across descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Foo (PART 1 OF 2)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo (DRAMATIZED ADAPTATION)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo (UNABRIDGED)')).toBe('foo');
  });

  it('strips bracket-wrapped descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized Adaptation]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Foundation [Unabridged]')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Foundation [Abridged]')).toBe('foundation');
    expect(normalizeSeriesMemberWorkTitle('Hitchhiker [Original Recording]')).toBe('hitchhiker');
    expect(normalizeSeriesMemberWorkTitle('Morning Star [1 of 2]')).toBe('morning star');
    expect(normalizeSeriesMemberWorkTitle('Way of Kings [Part 1 of 3]')).toBe('way of kings');
  });

  it('strips bracket descriptors combined with paren descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Dark Age (3 of 3) [Dramatized Adaptation]')).toBe('dark age');
    expect(normalizeSeriesMemberWorkTitle('Dark Age [Dramatized Adaptation] (3 of 3)')).toBe('dark age');
  });

  it('does NOT strip real bracketed series tags that are not edition descriptors', () => {
    expect(normalizeSeriesMemberWorkTitle('Foo [Audible Studios]')).toBe('foo audible studios');
    expect(normalizeSeriesMemberWorkTitle('Foo [Audible Original]')).toBe('foo audible original');
  });

  it('strips omnibus/edition/collection/bundle/complete/box-set container suffixes', () => {
    expect(normalizeSeriesMemberWorkTitle('Wool Omnibus Edition (Wool 1 - 5)')).toBe('wool');
    expect(normalizeSeriesMemberWorkTitle('Shift Omnibus Edition')).toBe('shift');
    expect(normalizeSeriesMemberWorkTitle('The Wheel of Time: The Complete Collection')).toBe('the wheel of time');
    expect(normalizeSeriesMemberWorkTitle('The Stormlight Archive Box Set')).toBe('the stormlight archive');
    expect(normalizeSeriesMemberWorkTitle('Foundation Bundle')).toBe('foundation');
  });

  it('strips trailing parenthetical position ranges', () => {
    expect(normalizeSeriesMemberWorkTitle('Mistborn: The Original Trilogy (Books 1 - 3)')).toBe('mistborn the original trilogy');
    expect(normalizeSeriesMemberWorkTitle('Foo (Wool 1 - 5)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo (1-5)')).toBe('foo');
    expect(normalizeSeriesMemberWorkTitle('Foo [Books 1 - 3]')).toBe('foo');
  });

  it('does NOT over-strip when keywords appear at the head/middle of legitimate work titles', () => {
    expect(normalizeSeriesMemberWorkTitle('The Complete Sherlock Holmes')).toBe('the complete sherlock holmes');
    expect(normalizeSeriesMemberWorkTitle('Box of Bones')).toBe('box of bones');
    expect(normalizeSeriesMemberWorkTitle('Edition Wars')).toBe('edition wars');
    expect(normalizeSeriesMemberWorkTitle('Bundle of Joy')).toBe('bundle of joy');
  });
});
