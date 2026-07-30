import { describe, it, expect } from 'vitest';
import { scanProductionSources } from '../__tests__/source-scan.js';

/**
 * Static source guard for `src/core/epub/`.
 *
 * Half of this is lint-enforced and half is not. The import half duplicates
 * `eslint.config.js`'s core layer guard so a refactor that reaches into
 * `server/utils/fs-errno.ts` fails in the suite too. The **no-logging** half is
 * the one lint cannot catch at all: `eslint.config.js` turns `no-console` *off*
 * for `src/core/**`, so a `console.warn` in this folder passes `pnpm verify`
 * today while violating the cross-cutting AC and `CONTRIBUTING.md`.
 *
 * **Production modules only.** `*.test.ts` is excluded — this very file
 * necessarily contains every forbidden literal, and scanning it would either
 * fail on itself or push the matchers into obfuscated string construction. The
 * scan is recursive, so future production EPUB modules stay in scope. It makes
 * no claim about the rest of `src/core/`.
 *
 * **Comments are not stripped**, so the patterns below are written to avoid
 * matching their own prose. Turning stripping on would be a separate,
 * reviewable decision that requires re-verifying every pattern.
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
    // Pins that the scan below is not silently looking at nothing. Named rather
    // than counted, so a sibling adding `xml.ts` or `zip-source.ts` extends the
    // guard's reach without editing this list.
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
