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

  it.each([
    ['book.service.ts', 'C:\\repo\\src\\server\\services\\book.service.ts'],
    ['book-intake', 'C:\\repo\\src\\server\\services\\book-intake\\decide-intake.ts'],
    ['routes/v1/books.ts', 'C:\\repo\\src\\server\\routes\\v1\\books.ts'],
    ['a test file', 'C:\\repo\\src\\server\\services\\caller.test.ts'],
  ])('exempts a backslash-separated %s', (_label, filename) => {
    expect(visitorKeys(filename)).toEqual([]);
  });

  it('still watches a backslash-separated NON-exempt path', () => {
    expect(visitorKeys('C:\\repo\\src\\server\\services\\match-job.helpers.ts')).toEqual(['CallExpression']);
  });

  it('watches the same path spelled with forward slashes', () => {
    expect(visitorKeys('/repo/src/server/services/match-job.helpers.ts')).toEqual(['CallExpression']);
  });
});
