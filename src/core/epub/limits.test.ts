import { describe, it, expect } from 'vitest';
import { MAX_COVER_SIZE } from '@shared/constants.js';
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_INSPECTION_BYTES,
  MAX_XML_BYTES,
  MAX_EPUB_COVER_BYTES,
  MAX_TOC_ENTRIES,
} from './limits.js';

// Exact-value pins only; at-the-limit behavior lives with each consumer.
describe('core/epub limits', () => {
  it('pins the exact value of each of the seven constants', () => {
    expect(MAX_ARCHIVE_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_ARCHIVE_ENTRIES).toBe(10000);
    expect(MAX_CENTRAL_DIRECTORY_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_INSPECTION_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_XML_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_EPUB_COVER_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_TOC_ENTRIES).toBe(2000);
  });

  it('keeps the EPUB cover cap distinct from the audiobook cover-download cap', () => {
    // Outbound audiobook downloads and inflated EPUB members have independent caps.
    expect(MAX_EPUB_COVER_BYTES).not.toBe(MAX_COVER_SIZE);
  });
});
