/**
 * Pins the import layer of #2235 against the REAL eslint.config.js.
 *
 * Two hazards are load-bearing and neither is observable from a whole-run `pnpm lint` pass:
 * flat config REPLACES a rule's options rather than merging them (so a server-wide block can
 * silently erase the pre-existing routes ban), and `@typescript-eslint/no-unused-vars` is globally
 * enabled (so a fixture that merely adds an unused import reds whether or not the ban exists).
 * Every assertion here therefore reads the resolved options directly or pins `ruleId`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let eslint;
beforeAll(() => {
  eslint = new ESLint({ cwd: REPO_ROOT });
});

/** The resolved `no-restricted-imports` pattern entries for a path, normalized to objects. */
async function patternsFor(relPath) {
  const config = await eslint.calculateConfigForFile(path.join(REPO_ROOT, relPath));
  const entry = config.rules['no-restricted-imports'];
  if (!entry) return [];
  const options = entry[1];
  return (options?.patterns ?? []).map((p) => (typeof p === 'string' ? { group: [p] } : p));
}

const hasGroup = (patterns, glob) => patterns.some((p) => (p.group ?? []).includes(glob));
const hasBan = (patterns, glob, importName) =>
  patterns.some((p) => (p.group ?? []).includes(glob) && (p.importNames ?? []).includes(importName));

const hasRoutesBan = (patterns) => hasGroup(patterns, '**/routes/**') && hasGroup(patterns, '**/routes/*');
const hasDedupBans = (patterns) =>
  hasBan(patterns, '**/book-dedup.js', 'resolveDuplicate') && hasBan(patterns, '**/book-create.js', 'buildNewBookValues');

/** Only the diagnostics from the rule under test; other rules may legitimately fire on a fixture. */
async function banMessages(relPath, code) {
  const results = await eslint.lintText(code, { filePath: path.join(REPO_ROOT, relPath) });
  return results[0].messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('resolved config — the routes ban survives the server-wide dedup block', () => {
  it('keeps BOTH the routes patterns and the dedup bans for a non-allowlisted services file', async () => {
    const patterns = await patternsFor('src/server/services/match-job.helpers.ts');

    // The replacement hazard in one assertion: an erased routes pattern fails here deterministically.
    expect(hasRoutesBan(patterns)).toBe(true);
    expect(hasDedupBans(patterns)).toBe(true);
  });

  it.each([
    ['a route', 'src/server/routes/library-scan.ts'],
    ['a job', 'src/server/jobs/discovery.ts'],
    ['a util', 'src/server/utils/serialize-error.ts'],
    ['a top-level server file', 'src/server/config.ts'],
  ])('reaches beyond services/ — %s carries the dedup bans', async (_label, relPath) => {
    expect(hasDedupBans(await patternsFor(relPath))).toBe(true);
  });

  it('keeps the pre-existing jobs routes ban alongside the dedup bans', async () => {
    const patterns = await patternsFor('src/server/jobs/discovery.ts');

    expect(hasRoutesBan(patterns)).toBe(true);
  });

  it('keeps the pre-existing utils services-values ban alongside the dedup bans', async () => {
    const patterns = await patternsFor('src/server/utils/serialize-error.ts');

    const servicesBan = patterns.find((p) => (p.group ?? []).includes('**/services/**'));
    expect(servicesBan).toBeDefined();
    expect(servicesBan.allowTypeImports).toBe(true);
  });
});

describe('resolved config — the allowlist', () => {
  it.each([
    ['book.service.ts', 'src/server/services/book.service.ts'],
    ['book-intake', 'src/server/services/book-intake/decide-intake.ts'],
  ])('drops the dedup bans but keeps the routes ban for %s', async (_label, relPath) => {
    const patterns = await patternsFor(relPath);

    expect(hasDedupBans(patterns)).toBe(false);
    // Losing the routes ban for the two sanctioned files would be the same hazard in miniature.
    expect(hasRoutesBan(patterns)).toBe(true);
  });
});

describe('the ban actually reports', () => {
  // Bindings are USED in every fixture, so no-unused-vars can never be the cause of a diagnostic.
  const NON_ALLOWLISTED = 'src/server/services/match-job.helpers.ts';
  const ROUTE = 'src/server/routes/library-scan.ts';
  const JOB = 'src/server/jobs/discovery.ts';

  it.each([
    ['resolveDuplicate from book-dedup', NON_ALLOWLISTED, "import { resolveDuplicate } from './book-dedup.js';\nexport const x = resolveDuplicate;\n"],
    ['buildNewBookValues from book-create', NON_ALLOWLISTED, "import { buildNewBookValues } from './book-create.js';\nexport const x = buildNewBookValues;\n"],
    // The alternate-specifier cases an exact-`paths` implementation passes while leaving the
    // bypass wide open — a route or job reaching into ../services/.
    ['resolveDuplicate via ../services from a route', ROUTE, "import { resolveDuplicate } from '../services/book-dedup.js';\nexport const x = resolveDuplicate;\n"],
    ['buildNewBookValues via ../services from a route', ROUTE, "import { buildNewBookValues } from '../services/book-create.js';\nexport const x = buildNewBookValues;\n"],
    ['resolveDuplicate via ../services from a job', JOB, "import { resolveDuplicate } from '../services/book-dedup.js';\nexport const x = resolveDuplicate;\n"],
    ['buildNewBookValues via ../services from a job', JOB, "import { buildNewBookValues } from '../services/book-create.js';\nexport const x = buildNewBookValues;\n"],
  ])('reports %s', async (_label, filePath, code) => {
    expect(await banMessages(filePath, code)).toHaveLength(1);
  });

  it('does NOT report OwnedRecordingError from the same module — importNames scoping', async () => {
    // book-intake/add-book.ts and book-add-resolved.ts both import exactly this, and must stay clean.
    const code = "import { OwnedRecordingError } from './book-dedup.js';\nexport const x = OwnedRecordingError;\n";

    expect(await banMessages(NON_ALLOWLISTED, code)).toHaveLength(0);
  });

  it('does NOT report the banned imports from book.service.ts', async () => {
    const code = "import { resolveDuplicate } from './book-dedup.js';\nimport { buildNewBookValues } from './book-create.js';\nexport const x = [resolveDuplicate, buildNewBookValues];\n";

    expect(await banMessages('src/server/services/book.service.ts', code)).toHaveLength(0);
  });

  it('does NOT report the banned imports from inside book-intake', async () => {
    const code = "import { resolveDuplicate } from '../book-dedup.js';\nexport const x = resolveDuplicate;\n";

    expect(await banMessages('src/server/services/book-intake/decide-intake.ts', code)).toHaveLength(0);
  });
});
