/**
 * Two arms. The RuleTester arm pins what the rule reports; the config arm pins WHERE it runs,
 * against the real eslint.config.js — including the single-file helper exemption, which is the
 * only thing standing between `pnpm lint` and an unresolvable contradiction (the helper is
 * required to write the exact call shape the rule reports).
 *
 * Runtime: the config arm's whole cost is one cold `calculateConfigForFile`, paid in `beforeAll`
 * with an explicit ceiling (see config-import-bans.test.js for the measurements). The synthetic
 * lints use a second, narrowed instance: `projectService: true` would build the repo's TypeScript
 * program for a rule that is purely syntactic, and the rule filter is co-required with disabling
 * it, or the first type-aware rule still enabled for `src/server/**` throws.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { RuleTester, ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rule from './no-raw-recursive-rm.cjs';

// Wire RuleTester into Vitest so each case reports independently.
RuleTester.describe = describe;
RuleTester.it = it;

// Under this pnpm layout only the root `typescript-eslint` parser resolves here.
const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },
});

const FS_IMPORT = "import { rm, rmSync } from 'node:fs/promises';";
const errors = [{ messageId: 'rawRecursiveRm' }];

ruleTester.run('no-raw-recursive-rm', rule, {
  valid: [
    {
      name: 'non-recursive rm — the ten real production single-file removals',
      code: `${FS_IMPORT}\nawait rm(p, { force: true });`,
    },
    { name: 'rm with no options', code: `${FS_IMPORT}\nawait rm(p);` },
    { name: 'recursive: false', code: `${FS_IMPORT}\nawait rm(p, { recursive: false });` },
    { name: 'recursive absent', code: `${FS_IMPORT}\nrmSync(p, { force: true, maxRetries: 3 });` },
    {
      name: 'mkdir is not a removal',
      code: "import { mkdir } from 'node:fs/promises';\nawait mkdir(p, { recursive: true });",
    },
    {
      name: 'cp is not a removal',
      code: "import { cp } from 'node:fs/promises';\nawait cp(a, b, { recursive: true });",
    },
    {
      name: 'an unrelated recursive option',
      code: 'await collectAudioFilePaths(p, { recursive: true, skipHidden: true });',
    },
    { name: 'the helper itself', code: "import { removeTree } from '@core/utils/remove-tree.js';\nawait removeTree(p);" },
    {
      name: 'an options identifier the rule cannot resolve — no false positive',
      code: `${FS_IMPORT}\nawait rm(p, opts);`,
    },
  ],

  invalid: [
    {
      name: 'recursive + force',
      code: `${FS_IMPORT}\nawait rm(p, { recursive: true, force: true });`,
      errors,
    },
    { name: 'rmSync recursive', code: `${FS_IMPORT}\nrmSync(p, { recursive: true });`, errors },
    {
      name: 'member-accessed fs.rm',
      code: "import fs from 'node:fs/promises';\nfs.rm(p, { recursive: true });",
      errors,
    },
    {
      name: 'namespace alias with maxRetries already threaded through',
      code: "import * as fsp from 'node:fs/promises';\nawait fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });",
      errors,
    },
    {
      name: 'renamed import binding',
      code: "import { rm as nuke } from 'node:fs/promises';\nawait nuke(p, { recursive: true });",
      errors,
    },
    {
      name: 'spread plus an explicit recursive key',
      code: `${FS_IMPORT}\nawait rm(p, { ...base, recursive: true });`,
      errors,
    },
    {
      name: 'computed member access',
      code: "import fs from 'node:fs';\nfs['rmSync'](p, { recursive: true });",
      errors,
    },
    {
      name: 'quoted recursive key',
      code: `${FS_IMPORT}\nawait rm(p, { 'recursive': true });`,
      errors,
    },
  ],
});

describe('no-raw-recursive-rm config scope', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const RULE_ID = 'narratorr/no-raw-recursive-rm';

  const HELPER = 'src/core/utils/remove-tree.ts';
  const HELPER_SIBLING = 'src/core/utils/collect-audio-files.ts';
  const MERGE_SERVICE = 'src/server/services/merge.service.ts';
  const IMPORT_STAGING = 'src/server/utils/import-staging.ts';
  const COVER_CACHE = 'src/server/utils/cover-cache.ts';
  const MERGE_SERVICE_TEST = 'src/server/services/merge.service.test.ts';
  const E2E_HELPERS = 'src/server/__tests__/e2e-helpers.ts';

  const RAW_RECURSIVE_RM = "import { rm } from 'node:fs/promises';\nexport const go = (p: string) => rm(p, { recursive: true, force: true });\n";

  let eslint;
  let ruleLinter;

  beforeAll(async () => {
    // The untouched real config: every resolved-severity assertion must read what `pnpm lint` reads.
    eslint = new ESLint({ cwd: REPO_ROOT });
    await eslint.calculateConfigForFile(path.join(REPO_ROOT, MERGE_SERVICE));

    ruleLinter = new ESLint({
      cwd: REPO_ROOT,
      ruleFilter: ({ ruleId }) => ruleId === RULE_ID,
      overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: false } } },
    });
  }, 60_000);

  /**
   * The resolved severity of this rule for a path, or undefined when it is not configured there.
   * `calculateConfigForFile` normalizes severities to numbers, so 2 is the `'error'` this reads as.
   */
  async function severityFor(relPath) {
    const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, relPath));
    return config.rules[RULE_ID]?.[0];
  }

  /**
   * Messages this rule raises for synthetic text at a path. Fails loudly rather than returning []
   * when the lint did not actually run — a narrowed instance is exactly how a fixture goes vacuous.
   */
  async function messagesFor(relPath, text) {
    const results = await ruleLinter.lintText(text, { filePath: path.join(REPO_ROOT, relPath) });
    expect(results).toHaveLength(1);
    const fatal = results[0].messages.filter((m) => m.ruleId === null);
    expect(fatal).toEqual([]);
    return results[0].messages.filter((m) => m.ruleId === RULE_ID);
  }

  it.each([MERGE_SERVICE, IMPORT_STAGING, COVER_CACHE])('is an error for %s', async (relPath) => {
    expect(await severityFor(relPath)).toBe(2);
  });

  it('is off for the helper — the one file the rule cannot apply to', async () => {
    expect(await severityFor(HELPER)).toBeUndefined();
  });

  it('stays an error for the helper\'s SIBLING, so widening the exemption to a directory glob reds', async () => {
    expect(await severityFor(HELPER_SIBLING)).toBe(2);
  });

  it.each([MERGE_SERVICE_TEST, E2E_HELPERS])('is off for %s (test cleanups keep their own removals)', async (relPath) => {
    expect(await severityFor(relPath)).toBeUndefined();
  });

  it('reports a raw recursive rm reintroduced in a production file', async () => {
    const messages = await messagesFor(MERGE_SERVICE, RAW_RECURSIVE_RM);

    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/removeTree/);
  });

  it('reports nothing for the SAME text under the helper\'s path', async () => {
    expect(await messagesFor(HELPER, RAW_RECURSIVE_RM)).toHaveLength(0);
  });
});
