import { describe, it, expect } from 'vitest';
import { scanProductionSources } from '../__tests__/source-scan.js';

/**
 * Recursively guards production EPUB modules against cross-layer imports and logging.
 * Tests are excluded because their literals self-match; comments remain in the scan.
 */

const EPUB_DIR = import.meta.dirname;

const FORBIDDEN: Array<[label: string, pattern: RegExp]> = [
  ['a server-layer import', /from\s+['"][^'"]*server\//],
  ['a fastify import', /from\s+['"]fastify['"]/],
  ['a fastify require', /require\(\s*['"]fastify['"]\s*\)/],
  ['a console call', /\bconsole\s*\./],
  ['a logger call', /\b(?:log|logger)\s*\.\s*(?:trace|debug|info|warn|error|fatal)\b/],
];

describe('src/core/epub layer guard', () => {
  it('scans every production module in the folder', async () => {
    // Named baseline proves the recursive scan is non-empty without limiting future files.
    const files = (await scanProductionSources(EPUB_DIR)).map((s) => s.file);
    expect(files).toEqual(
      expect.arrayContaining([
        'counting-stream.ts',
        'errors.ts',
        'limits.ts',
        'paths.ts',
        'result.ts',
      ]),
    );
  });

  it.each(FORBIDDEN)('contains no %s', async (_label, pattern) => {
    const sources = await scanProductionSources(EPUB_DIR);
    const offenders = sources.filter(({ code }) => pattern.test(code)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});
