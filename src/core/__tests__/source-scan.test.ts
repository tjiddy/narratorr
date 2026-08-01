import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { scanProductionSources, scanSources } from './source-scan.js';

/**
 * Unit coverage for the shared recursive source scanner (#2000).
 *
 * The `src/core/epub/` suites that consume this helper mock `node:fs/promises`
 * but deliberately pass `readdir`/`readFile` through to the real
 * implementations. This suite is the one place free to *replace* `readFile`,
 * which is what makes the sequencing probe below deterministic rather than a
 * completion race.
 */

const h = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  real: {} as {
    readdir: (typeof import('node:fs/promises'))['readdir'];
    readFile: (typeof import('node:fs/promises'))['readFile'];
  },
  /** Reads currently between entry and resolution — the concurrency probe. */
  inFlight: 0,
  peak: 0,
  /** Every path handed to `readFile`, in order. */
  read: [] as string[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  h.real.readdir = actual.readdir;
  h.real.readFile = actual.readFile;
  return { ...actual, default: actual, readdir: h.readdir, readFile: h.readFile };
});

/**
 * Discriminates the mandated text-only, block-then-line transform from a
 * syntax-aware or reordered one. Every line is load-bearing — see the exact
 * expectations in `STRIPPED`.
 */
const STRIP_FIXTURE = [
  "const u = 'https://x/y';",
  '/* a // b */ const x = 1;',
  'const y = 2; // trailing',
  '/* unterminated with // inside',
  '',
].join('\n');

const STRIPPED = [
  // Text-only: the line regex truncates inside a string literal.
  "const u = 'https:",
  // Block-first: a line-first pass would delete `// b */` and strand `/* a `.
  ' const x = 1;',
  // Code before a `//` survives, trailing space and all.
  'const y = 2; ',
  // No closing marker, so the block pass leaves it for the line pass to cut.
  '/* unterminated with ',
  '',
].join('\n');

let treeRoot: string;
let stripRoot: string;
let emptyRoot: string;
let otherRoot: string;

/** Every candidate in `treeRoot`, relative and POSIX-separated. */
const TREE_ALL = ['a.test.ts', 'a.ts', 'c.tsx', 'nested/b.ts', 'skip/x.ts', 'skipx/y.ts'];

beforeAll(async () => {
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const base = await mkdtemp(path.join(tmpdir(), 'narratorr-source-scan-'));
  treeRoot = path.join(base, 'tree');
  stripRoot = path.join(base, 'strip');
  emptyRoot = path.join(base, 'empty');
  otherRoot = path.join(base, 'other');

  for (const dir of [treeRoot, stripRoot, emptyRoot, otherRoot]) await mkdir(dir, { recursive: true });
  for (const dir of ['nested', 'skip', 'skipx']) await mkdir(path.join(treeRoot, dir));

  for (const file of TREE_ALL) await writeFile(path.join(treeRoot, file), `// ${file}\n`);
  await writeFile(path.join(stripRoot, 'fixture.ts'), STRIP_FIXTURE);
  await writeFile(path.join(otherRoot, 'readme.md'), 'not a source file\n');
});

afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  try {
    await rm(path.dirname(treeRoot), { recursive: true, force: true });
  } catch {
    /* Windows keeps handles open longer; a leaked tmpdir is cheaper than a red suite. */
  }
});

beforeEach(() => {
  h.inFlight = 0;
  h.peak = 0;
  h.read = [];
  h.readdir.mockReset();
  h.readFile.mockReset();
  h.readdir.mockImplementation((dir: string, options: { recursive: boolean }) =>
    h.real.readdir(dir, options),
  );
  h.readFile.mockImplementation(async (file: string) => {
    h.inFlight += 1;
    h.peak = Math.max(h.peak, h.inFlight);
    h.read.push(file);
    try {
      // Yield, so a `Promise.all` implementation has every read in flight at once.
      await Promise.resolve();
      return await h.real.readFile(file, 'utf8');
    } finally {
      h.inFlight -= 1;
    }
  });
});

describe('scanSources selection', () => {
  it('recurses by default, keeps .ts, and drops test files', async () => {
    const files = (await scanSources({ root: treeRoot })).map(({ file }) => file);

    expect(files.sort()).toEqual(['a.ts', 'nested/b.ts', 'skip/x.ts', 'skipx/y.ts']);
  });

  it('keeps test files and extra extensions when asked', async () => {
    const files = (
      await scanSources({ root: treeRoot, extensions: ['.ts', '.tsx'], includeTests: true })
    ).map(({ file }) => file);

    expect(files.sort()).toEqual(TREE_ALL);
  });

  it('prunes an excluded subtree by path segment, not by string prefix', async () => {
    // The sibling `skipx/` merely *extends* the excluded name and must survive —
    // the one intentional semantic correction in #2000.
    const files = (
      await scanSources({ root: treeRoot, excludeDirs: [path.join(treeRoot, 'skip')] })
    ).map(({ file }) => file);

    expect(files.sort()).toEqual(['a.ts', 'nested/b.ts', 'skipx/y.ts']);
  });

  it('returns root-relative POSIX paths on every platform', async () => {
    const files = (await scanSources({ root: treeRoot })).map(({ file }) => file);

    expect(files).toContain('nested/b.ts');
    expect(files.filter((file) => file.includes('\\'))).toEqual([]);
    expect(files.filter((file) => path.isAbsolute(file))).toEqual([]);
  });
});

describe('scanSources comment stripping', () => {
  it('applies the block-then-line text transform byte-for-byte', async () => {
    const [scanned] = await scanSources({ root: stripRoot, stripComments: true });

    expect(scanned?.code).toBe(STRIPPED);
  });

  it('returns the file unchanged when stripping is off', async () => {
    const [scanned] = await scanSources({ root: stripRoot });

    expect(scanned?.code).toBe(STRIP_FIXTURE);
  });

  it('leaves stripping off for the production-source preset', async () => {
    const [scanned] = await scanProductionSources(stripRoot);

    expect(scanned?.code).toBe(STRIP_FIXTURE);
  });
});

describe('scanSources vacuity guard', () => {
  it('throws and names the root when the directory is empty', async () => {
    await expect(scanSources({ root: emptyRoot })).rejects.toThrow(emptyRoot);
  });

  it('throws and names the root when nothing matches the extension set', async () => {
    await expect(scanSources({ root: otherRoot })).rejects.toThrow(otherRoot);
  });

  it('throws and names the root when readdir itself yields nothing', async () => {
    h.readdir.mockResolvedValueOnce([]);

    await expect(scanSources({ root: treeRoot })).rejects.toThrow(treeRoot);
  });
});

describe('scanSources read sequencing', () => {
  it('holds at most one read in flight and still reads every candidate', async () => {
    const scanned = await scanSources({
      root: treeRoot,
      extensions: ['.ts', '.tsx'],
      includeTests: true,
    });

    // Exactly 1, not "bounded": a `Promise.all` reports a peak equal to the file
    // count here regardless of the host's descriptor limit.
    expect(h.peak).toBe(1);
    expect(h.read.length).toBe(TREE_ALL.length);
    expect(h.read.map((file) => path.relative(treeRoot, file).split(path.sep).join('/')).sort()).toEqual(
      TREE_ALL,
    );
    expect(scanned.map(({ file }) => file).sort()).toEqual(TREE_ALL);
  });
});
