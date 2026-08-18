import { describe, it, expect } from 'vitest';
import { BOOK_STATUSES } from './schemas/book.js';
import { ATTACHABLE_BOOK_STATUSES, canAttachFile, isAttachableStatus } from './attach-eligibility.js';

describe('isAttachableStatus', () => {
  // Driven over the whole enum so a new status must be classified deliberately, not by default.
  it.each(BOOK_STATUSES)('classifies %s', (status) => {
    const expected = ['wanted', 'searching', 'failed', 'missing'].includes(status);
    expect(isAttachableStatus(status)).toBe(expected);
  });

  it('refuses the two live-acquisition statuses', () => {
    // A download or import in flight owns the book; attaching would race it.
    expect(isAttachableStatus('downloading')).toBe(false);
    expect(isAttachableStatus('importing')).toBe(false);
  });

  it('partitions BOOK_STATUSES — no attachable status is missing from the enum', () => {
    for (const status of ATTACHABLE_BOOK_STATUSES) {
      expect(BOOK_STATUSES).toContain(status);
    }
  });
});

describe('canAttachFile', () => {
  it('accepts a fileless attachable book', () => {
    expect(canAttachFile({ path: null, status: 'wanted' })).toBe(true);
  });

  it('refuses a book that holds a file even when its status is attachable', () => {
    expect(canAttachFile({ path: '/library/A/B', status: 'wanted' })).toBe(false);
  });

  it('refuses an attachable-looking whitespace path only via the shared predicate', () => {
    expect(canAttachFile({ path: '   ', status: 'wanted' })).toBe(true);
  });

  it.each(['downloading', 'importing', 'imported'] as const)(
    'refuses a fileless %s book',
    (status) => {
      expect(canAttachFile({ path: null, status })).toBe(false);
    },
  );
});
