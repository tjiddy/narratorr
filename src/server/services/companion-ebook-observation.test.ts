import { describe, it, expect } from 'vitest';
import {
  companionEbookObservationSchema,
  isPersistableCompanionBasename,
} from './companion-ebook-observation.js';

describe('isPersistableCompanionBasename', () => {
  const accepted = [
    'book.epub',
    'Book.EPUB',
    'book.Epub',
    'book.tmp.epub',
    'book.part.epub',
    'Том 1.epub',
    'a, b & c.epub',
    '.book.epub',
  ];

  const rejected = [
    '',
    'a/b.epub',
    'a\\b.epub',
    ' book.epub',
    'book.epub ',
    '.',
    '..',
  ];

  it.each(accepted)('accepts %j', (name) => {
    expect(isPersistableCompanionBasename(name)).toBe(true);
  });

  it.each(rejected)('rejects %j', (name) => {
    expect(isPersistableCompanionBasename(name)).toBe(false);
  });

  it.each(rejected)('agrees with the observation write boundary on %j', (name) => {
    const parsed = companionEbookObservationSchema.safeParse({
      status: 'available',
      filename: name,
      sizeBytes: 10,
      mtimeMs: 1,
      ctimeMs: 1,
      candidateCount: 1,
      selected: false,
    });
    expect(parsed.success).toBe(false);
    expect(isPersistableCompanionBasename(name)).toBe(false);
  });

  it('agrees with the observation write boundary on an accepted name', () => {
    const parsed = companionEbookObservationSchema.safeParse({
      status: 'available',
      filename: 'book.epub',
      sizeBytes: 10,
      mtimeMs: 1,
      ctimeMs: 1,
      candidateCount: 1,
      selected: false,
    });
    expect(parsed.success).toBe(true);
    expect(isPersistableCompanionBasename('book.epub')).toBe(true);
  });
});
