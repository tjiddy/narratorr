/**
 * Pins the import layer of #2235 against the REAL eslint.config.js.
 *
 * Two hazards are load-bearing and neither is observable from a whole-run `pnpm lint` pass:
 * flat config REPLACES a rule's options rather than merging them (so a server-wide block can
 * silently erase the pre-existing routes ban), and `@typescript-eslint/no-unused-vars` is globally
 * enabled (so a fixture that merely adds an unused import reds whether or not the ban exists).
 * Every assertion here therefore reads the resolved options directly or pins `ruleId`.
 *
 * Runtime: every timing cost in this file is ONE cold `calculateConfigForFile`, and `beforeAll`
 * pays it deliberately (1,106ms cold on Windows; 9ms for any later path, 0ms for a repeat). It
 * used to fall on whichever case ran first, under the 15s `testTimeout`, where full-suite worker
 * pressure inflated it past the ceiling on 2 of 3 consecutive `pnpm verify` runs — invisible on
 * Linux CI, which is why it survived. The hook carries an explicit 60s ceiling rather than
 * inheriting the 30s `hookTimeout`, because the failure mode being guarded is inflation under
 * load, not a slow call. If a CASE here ever creeps toward seconds, the cause is type-aware config
 * resolution — see `banLinter`, not the ceiling.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The paths under test, shared by the resolved-options arm and the reporting arm.
const NON_ALLOWLISTED = 'src/server/services/match-job.helpers.ts';
const ROUTE = 'src/server/routes/library-scan.ts';
const JOB = 'src/server/jobs/discovery.ts';
const UTIL = 'src/server/utils/serialize-error.ts';
const BOOK_SERVICE = 'src/server/services/book.service.ts';
const BOOK_INTAKE = 'src/server/services/book-intake/decide-intake.ts';
// #2258's client half: a production add surface, and the barrel that must not re-offer the parser.
const CLIENT_SURFACE = 'src/client/pages/search/SearchBookCard.tsx';
const CLIENT_BARREL = 'src/client/lib/api/index.ts';
const CLIENT_TEST = 'src/client/pages/search/SearchBookCard.test.tsx';

let eslint;
let banLinter;
beforeAll(async () => {
  // The untouched real config. Every resolved-options assertion below must read exactly what
  // `pnpm lint` reads, so this instance takes no overrides.
  eslint = new ESLint({ cwd: REPO_ROOT });

  // Pay the one-time config resolution HERE rather than in whichever case calls `patternsFor`
  // first. Measured on Windows: 1,106ms cold, 9ms for any later path, 0ms for a repeat — so the
  // file's whole timing exposure is this single call, and leaving it in a case put it under the
  // 15s `testTimeout`, where full-suite worker pressure inflated it past the ceiling (2 of 3
  // consecutive `pnpm verify` runs). The explicit hook timeout below is the real headroom; every
  // case then runs warm.
  await eslint.calculateConfigForFile(path.join(REPO_ROOT, NON_ALLOWLISTED));

  // The SAME config, narrowed for the synthetic lints only. `projectService: true`
  // (eslint.config.js) makes the first lint of any `src/server/**` path stand up the TypeScript
  // project service and build the repo's program: measured at 5,939ms for that one lint against
  // 15ms for a repeat of the same path, which is what pushed this file past the 15s testTimeout on
  // slower hardware. `no-restricted-imports` is purely syntactic and needs none of it. The two
  // overrides are co-required in this direction, not independent tuning knobs: dropping the project
  // service alone throws `You have used a rule which requires type information` from the first
  // type-aware rule still enabled for `src/server/**` (`@typescript-eslint/return-await`).
  banLinter = new ESLint({
    cwd: REPO_ROOT,
    ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-imports',
    overrideConfig: { languageOptions: { parserOptions: { projectService: false, project: false } } },
  });
}, 60_000);

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
const hasServerBan = (patterns) => hasGroup(patterns, '**/server/**') && hasGroup(patterns, '**/server/*');
const hasDedupBans = (patterns) =>
  hasBan(patterns, '**/book-dedup.js', 'resolveDuplicate') && hasBan(patterns, '**/book-create.js', 'buildNewBookValues');

/**
 * Only the diagnostics from the rule under test; other rules may legitimately fire on a fixture.
 *
 * Both guards are load-bearing rather than defensive: every negative case below asserts
 * `toHaveLength(0)`, so a lint that never ran must throw instead of returning an empty array. An
 * ignored path produces no result at all; a fatal parse error produces `ruleId: null`, which the
 * filter below would otherwise drop on the floor.
 */
async function banMessages(relPath, code) {
  // `warnIgnored: false` so an ignored path is an absent result rather than a null-ruleId warning.
  const results = await banLinter.lintText(code, { filePath: path.join(REPO_ROOT, relPath), warnIgnored: false });
  if (results.length !== 1) {
    throw new Error(
      `ESLint produced no result for ${relPath} (got ${results.length}) — the path is ignored by eslint.config.js or otherwise unlintable, so this fixture asserts nothing.`
    );
  }
  const fatal = results[0].messages.filter((m) => m.ruleId === null);
  if (fatal.length > 0) {
    throw new Error(`ESLint could not lint ${relPath}: ${fatal.map((m) => m.message).join('; ')}`);
  }
  // Redundant while `ruleFilter` is in place, load-bearing the moment it is not: without it
  // no-unused-vars reds any fixture with an unused import.
  return results[0].messages.filter((m) => m.ruleId === 'no-restricted-imports');
}

describe('resolved config — the routes ban survives the server-wide dedup block', () => {
  it('keeps BOTH the routes patterns and the dedup bans for a non-allowlisted services file', async () => {
    const patterns = await patternsFor(NON_ALLOWLISTED);

    // The replacement hazard in one assertion: an erased routes pattern fails here deterministically.
    expect(hasRoutesBan(patterns)).toBe(true);
    expect(hasDedupBans(patterns)).toBe(true);
  });

  it.each([
    ['a route', ROUTE],
    ['a job', JOB],
    ['a util', UTIL],
    ['a top-level server file', 'src/server/config.ts'],
  ])('reaches beyond services/ — %s carries the dedup bans', async (_label, relPath) => {
    expect(hasDedupBans(await patternsFor(relPath))).toBe(true);
  });

  it('keeps the pre-existing jobs routes ban alongside the dedup bans', async () => {
    const patterns = await patternsFor(JOB);

    expect(hasRoutesBan(patterns)).toBe(true);
  });

  it('keeps the pre-existing utils services-values ban alongside the dedup bans', async () => {
    const patterns = await patternsFor(UTIL);

    const servicesBan = patterns.find((p) => (p.group ?? []).includes('**/services/**'));
    expect(servicesBan).toBeDefined();
    expect(servicesBan.allowTypeImports).toBe(true);
  });
});

describe('resolved config — the allowlist', () => {
  it.each([
    ['book.service.ts', BOOK_SERVICE],
    ['book-intake', BOOK_INTAKE],
  ])('drops the dedup bans but keeps the routes ban for %s', async (_label, relPath) => {
    const patterns = await patternsFor(relPath);

    expect(hasDedupBans(patterns)).toBe(false);
    // Losing the routes ban for the two sanctioned files would be the same hazard in miniature.
    expect(hasRoutesBan(patterns)).toBe(true);
  });
});

describe('the ban actually reports', () => {
  // Bindings are USED in every fixture, so no-unused-vars can never be the cause of a diagnostic.
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
    // book-intake/add-book.ts imports exactly this, and must stay clean.
    const code = "import { OwnedRecordingError } from './book-dedup.js';\nexport const x = OwnedRecordingError;\n";

    expect(await banMessages(NON_ALLOWLISTED, code)).toHaveLength(0);
  });

  it('does NOT report the banned imports from book.service.ts', async () => {
    const code = "import { resolveDuplicate } from './book-dedup.js';\nimport { buildNewBookValues } from './book-create.js';\nexport const x = [resolveDuplicate, buildNewBookValues];\n";

    expect(await banMessages(BOOK_SERVICE, code)).toHaveLength(0);
  });

  it('does NOT report the banned imports from inside book-intake', async () => {
    const code = "import { resolveDuplicate } from '../book-dedup.js';\nexport const x = resolveDuplicate;\n";

    expect(await banMessages(BOOK_INTAKE, code)).toHaveLength(0);
  });
});

// #2258 — the add-path 409 gate has one home; the barrel no longer offers the raw parser, and this
// ban is what stops a fifth surface (or a re-added barrel line) from respelling the gate.
describe('resolved config — the client add-conflict ban rides alongside the server bans', () => {
  it.each([
    ['a production add surface', CLIENT_SURFACE],
    ['the api barrel', CLIENT_BARREL],
  ])('keeps BOTH the server patterns and the parseAddBookConflict ban for %s', async (_label, relPath) => {
    const patterns = await patternsFor(relPath);

    // Adding a second client-scoped block instead of extending the existing one erases these two
    // silently — flat config replaces a rule's options rather than merging them.
    expect(hasServerBan(patterns)).toBe(true);
    expect(hasBan(patterns, '**/add-book-conflict.js', 'parseAddBookConflict')).toBe(true);
  });

  it('leaves client test files exempt', async () => {
    expect(hasBan(await patternsFor(CLIENT_TEST), '**/add-book-conflict.js', 'parseAddBookConflict')).toBe(false);
  });
});

describe('the client add-conflict ban actually reports', () => {
  it.each([
    ['a direct import', "import { parseAddBookConflict } from '@/lib/api/add-book-conflict.js';\nexport const x = parseAddBookConflict;\n"],
    ['a relative import', "import { parseAddBookConflict } from '../../lib/api/add-book-conflict.js';\nexport const x = parseAddBookConflict;\n"],
    // Re-adding the barrel line is the realistic bypass of the removed re-export, so the ban has to
    // reach export-from specifiers and not just imports.
    ['a re-export', "export { parseAddBookConflict } from './add-book-conflict.js';\n"],
  ])('reports %s of parseAddBookConflict from client production code', async (_label, code) => {
    expect(await banMessages(CLIENT_SURFACE, code)).toHaveLength(1);
  });

  it('does NOT report the reader or the copy from the same module — importNames scoping', async () => {
    const code = "import { readAddBookConflict, formatReviewConflictMessage } from '@/lib/api/add-book-conflict.js';\nexport const x = [readAddBookConflict, formatReviewConflictMessage];\n";

    expect(await banMessages(CLIENT_SURFACE, code)).toHaveLength(0);
  });

  it('does NOT report parseAddBookConflict from a client test file', async () => {
    const code = "import { parseAddBookConflict } from '@/lib/api/add-book-conflict.js';\nexport const x = parseAddBookConflict;\n";

    expect(await banMessages(CLIENT_TEST, code)).toHaveLength(0);
  });
});

describe('banMessages refuses to green a lint that never ran', () => {
  // Every negative above asserts toHaveLength(0), so a helper that returns [] for a lint that did
  // not happen passes all of them for the wrong reason. These pin the two shapes that produce it.
  it('surfaces a fatal parse error instead of filtering it out', async () => {
    // Also carries a banned import: the correct answer is 1, and a ruleId filter alone returns 0.
    const code = "import { resolveDuplicate } from './book-dedup.js';\nexport const = ;\n";

    await expect(banMessages(NON_ALLOWLISTED, code)).rejects.toThrow(/Parsing error/);
  });

  it('fails loudly when ESLint returns no result for the path', async () => {
    // eslint.config.js ignores `eslint-rules/**`, so an ignored path yields zero results rather
    // than a result with zero messages — the shape a future path typo lands in.
    await expect(banMessages('eslint-rules/config-import-bans.test.js', 'export const x = 1;\n')).rejects.toThrow(
      /no result/
    );
  });
});
