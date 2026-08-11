/**
 * Ambient-mode entry for the no-direct-duplicate-check RuleTester suite.
 *
 * Sets NO parser environment variable, so it runs in whatever mode typescript-eslint infers — the
 * long-running program locally, single-run under `CI=true`. That is deliberate: it is the only entry
 * that exercises the long-running path, so the forced-single-run assignment lives in
 * `no-direct-duplicate-check.single-run.test.js` and must never be added here (an explicit
 * `TSESTREE_SINGLE_RUN` wins ahead of every other signal in `inferSingleRun()`, so an in-file
 * assignment would silently convert this entry too and leave the ambient mode untested).
 *
 * The shared case set lives in `no-direct-duplicate-check.cases.js`; see its header for why the
 * parser uses `projectService` rather than `project` (#2239).
 */
import { describe, it, expect } from 'vitest';
import rule from './no-direct-duplicate-check.cjs';
import { runSharedCases } from './no-direct-duplicate-check.cases.js';

runSharedCases({ describe, it });

// Path handling is separator-agnostic. A backslash filename cannot be a RuleTester case — it would
// not resolve to a real file in the TS program — so observe `create()` directly: it returns an
// empty visitor object for an exempt path and a live CallExpression visitor otherwise. This block
// never parses, so it is parser-mode independent and stays in this entry only.
describe('exemption matching is separator-agnostic', () => {
  const visitorKeys = (filename) => Object.keys(rule.create({ filename, sourceCode: {} }));
  const V1_BACKSLASH = 'C:\\repo\\src\\server\\routes\\v1\\books.ts';
  const V1_FORWARD = '/repo/src/server/routes/v1/books.ts';

  it.each([
    ['book.service.ts', 'C:\\repo\\src\\server\\services\\book.service.ts'],
    ['book-intake', 'C:\\repo\\src\\server\\services\\book-intake\\decide-intake.ts'],
    ['a test file', 'C:\\repo\\src\\server\\services\\caller.test.ts'],
  ])('exempts a backslash-separated %s for every guarded method', (_label, filename) => {
    expect(visitorKeys(filename)).toEqual([]);
  });

  it('still watches a backslash-separated NON-exempt path', () => {
    expect(visitorKeys('C:\\repo\\src\\server\\services\\match-job.helpers.ts')).toEqual(['CallExpression']);
  });

  it('watches the same path spelled with forward slashes', () => {
    expect(visitorKeys('/repo/src/server/services/match-job.helpers.ts')).toEqual(['CallExpression']);
  });

  // v1 is method-scoped since #2251, so it must be VISITED — the per-call check is what lets its
  // `create` through while reporting `findDuplicate`. This pins the visiting, not the separator
  // fold: an unmatched path returns the same keys, so it would stay green if folding broke.
  it.each([['backslash', V1_BACKSLASH], ['forward-slash', V1_FORWARD]])(
    'installs a live visitor for the method-scoped v1 path (%s)',
    (_label, filename) => {
      expect(visitorKeys(filename)).toEqual(['CallExpression']);
    },
  );

  // So the fold is observed through the resolver instead, where a match and a non-match differ.
  describe('resolveExemption', () => {
    it('returns the unscoped entry for a fully exempt backslash path', () => {
      expect(rule.resolveExemption('C:\\repo\\src\\server\\services\\book.service.ts')).toEqual({
        kind: 'file',
        path: 'src/server/services/book.service.ts',
      });
    });

    it('returns the method-scoped entry for the v1 path', () => {
      expect(rule.resolveExemption(V1_FORWARD)).toEqual({
        kind: 'file',
        path: 'src/server/routes/v1/books.ts',
        methods: ['create'],
      });
    });

    it('resolves both spellings of the v1 path identically', () => {
      expect(rule.resolveExemption(V1_BACKSLASH)).toEqual(rule.resolveExemption(V1_FORWARD));
    });

    it('returns null for a non-exempt backslash path', () => {
      expect(rule.resolveExemption('C:\\repo\\src\\server\\services\\match-job.helpers.ts')).toBeNull();
    });
  });
});
