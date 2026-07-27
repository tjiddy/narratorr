import { describe, it, expect } from 'vitest';
import { MAX_COVER_SIZE } from '../../shared/constants.js';
import {
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_INSPECTION_BYTES,
  MAX_XML_BYTES,
  MAX_EPUB_COVER_BYTES,
  MAX_TOC_ENTRIES,
} from './limits.js';

/**
 * Exact-value pins only. The at-the-limit / limit+1 behavioural tests live with
 * the consumers: `MAX_XML_BYTES` with 1.1b, the entry counts with 1.1c, the
 * cover and TOC caps with 1.1e. A silent retune here is a test failure rather
 * than a behaviour change.
 */
describe('core/epub limits', () => {
  it('pins the exact value of each of the six constants', () => {
    expect(MAX_ARCHIVE_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_ARCHIVE_ENTRIES).toBe(10000);
    expect(MAX_INSPECTION_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_XML_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_EPUB_COVER_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_TOC_ENTRIES).toBe(2000);
  });

  it('keeps the EPUB cover cap distinct from the audiobook cover-download cap', () => {
    // MAX_COVER_SIZE bounds an *outbound download* of audiobook cover art;
    // MAX_EPUB_COVER_BYTES bounds an *inflated archive member*. They drift
    // independently — a future "unification" refactor must fail here.
    expect(MAX_EPUB_COVER_BYTES).not.toBe(MAX_COVER_SIZE);
  });
});
