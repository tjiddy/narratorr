import { describe, it, expect } from 'vitest';
import {
  companionEbookObservationSchema,
  isPersistableCompanionBasename,
} from './companion-ebook-observation.js';

/**
 * `isPersistableCompanionBasename` (#1974 AC10 term 3) is the ONE basename domain shared by
 * discovery, the opener, and the observation write boundary. It is defined *from*
 * `filenameSchema`, so these cases double as the proof that the three sites cannot drift:
 * each rejected name below is also rejected by a full `companionEbookObservationSchema.parse`.
 */
describe('isPersistableCompanionBasename', () => {
  const accepted = [
    'book.epub',
    'Book.EPUB',
    'book.Epub',
    'book.tmp.epub',
    'book.part.epub',
    'Том 1.epub',
    'a, b & c.epub',
    '.book.epub', // dotfiles are a DISCOVERY exclusion, not a persistability one
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

  // The predicate is derived from `filenameSchema`, never a restatement of its rules.
  // If someone re-spells the rules, this drifts and fails.
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
