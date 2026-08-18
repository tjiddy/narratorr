import { describe, it, expect } from 'vitest';
import { bookHoldsFile } from './book-holds-file.js';

describe('bookHoldsFile', () => {
  // The trim policy is pinned here and nowhere else; every consumer delegates.
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty string', '', false],
    ['spaces only', '   ', false],
    ['tab only', '\t', false],
    ['newline only', '\n', false],
    ['a real path', '/library/A/B', true],
    ['a padded real path', '  /library/A/B  ', true],
    ['a windows path', 'C:\\library\\A\\B', true],
  ])('returns %s -> %s', (_label, input, expected) => {
    expect(bookHoldsFile(input as string | null | undefined)).toBe(expected);
  });
});
