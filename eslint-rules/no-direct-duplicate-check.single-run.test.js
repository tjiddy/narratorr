/**
 * Regression guard for #2239: runs the shared case set with single-run parsing FORCED on.
 *
 * Single-run mode is what breaks this suite, and typescript-eslint infers it from `CI === 'true'` —
 * so without this entry the defect is only reachable on a CI runner, and a fix that merely dodges
 * the CI inference looks green. Forcing it here makes the failure mode reachable with no ambient
 * environment at all: revert `no-direct-duplicate-check.cases.js` to `parserOptions.project` and
 * this file reds 8 while the ambient entry stays green.
 *
 * Why the assignment is load-bearing, since the code cannot say it: in single-run mode
 * typescript-estree's `parser.js` counts `parseAndGenerateServices` calls PER `filePath`, and from
 * the second call for a given path onwards it discards the project program for a one-file
 * `createIsolatedProgram`. Eleven cases share the `caller.ts` filename, so all but the first parse
 * against a program in which their `./book.service.js` import resolves to nothing. Do not delete
 * this assignment to "clean up" the file — it is the entire point of the entry.
 */
import { afterAll, describe, expect, it } from 'vitest';

const PRIOR_SINGLE_RUN = process.env.TSESTREE_SINGLE_RUN;
process.env.TSESTREE_SINGLE_RUN = 'true';

const { runSharedCases } = await import('./no-direct-duplicate-check.cases.js');

runSharedCases({ describe, it });

// Vitest's default `forks` pool with `isolate: true` already gives this file its own process, so
// the override cannot reach the ambient entry. Restoring anyway is defence in depth against a
// future `--no-isolate`, which would otherwise hand forced single-run to whatever typed RuleTester
// suite happens to run next in this worker.
afterAll(() => {
  if (PRIOR_SINGLE_RUN === undefined) delete process.env.TSESTREE_SINGLE_RUN;
  else process.env.TSESTREE_SINGLE_RUN = PRIOR_SINGLE_RUN;
  expect(process.env.TSESTREE_SINGLE_RUN).toBe(PRIOR_SINGLE_RUN);
});
