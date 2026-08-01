import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The one recursive source scanner behind every static architecture guard in
 * `src/core/epub/` (#2000).
 *
 * Those guards used to hand-roll the same "read every production file in this
 * folder, then assert no source matches pattern X" scaffolding six times over,
 * with quietly different roots, file filters, and comment handling. The
 * *patterns* stay with the runtime property each one guards; only the
 * scaffolding lives here.
 *
 * **Deliberately outside `src/core/epub/`**, beside the fixture builders, so
 * the folder's own layer guard cannot mistake it for a production module.
 *
 * **Only `readdir` and `readFile`, never `open` or `lstat`.** All three large
 * EPUB suites partially mock `node:fs/promises` and replace `open` (plus
 * `lstat` in `validate.test.ts`); every factory spreads the real module, so
 * these two pass through. Reaching for a third primitive would hand the scan a
 * spy instead of the filesystem.
 */

export interface SourceScanOptions {
  /** Absolute directory to enumerate, recursively. */
  root: string;
  /** Suffixes to keep. Default `['.ts']`. */
  extensions?: readonly string[] | undefined;
  /** Keep `*.test.ts` / `*.test.tsx` as well. Default `false`. */
  includeTests?: boolean | undefined;
  /** Apply the comment transform documented on `stripCommentText`. Default `false`. */
  stripComments?: boolean | undefined;
  /** Absolute directories to prune, matched by path segment. Default none. */
  excludeDirs?: readonly string[] | undefined;
}

export interface ScannedSource {
  /** Path relative to the scan root, POSIX-separated on every platform. */
  file: string;
  /** The file's text, comment-stripped when the caller asked for it. */
  code: string;
}

const TEST_FILE = /\.test\.tsx?$/;

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Block comments first, then line comments — the order is load-bearing and the
 * transform is deliberately text-only, not syntax-aware.
 *
 * It truncates a line at a `//` that sits inside a string literal, and it
 * removes a block comment that itself contains `//`. Both are relied on by the
 * guards that enable stripping; a parser-based or reordered implementation is a
 * behaviour change even though ordinary comments still disappear. Pinned by
 * exact expected output in `source-scan.test.ts` ›
 * `describe('scanSources comment stripping')`.
 */
function stripCommentText(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Segment-aware containment, so pruning `foo/` leaves a sibling `foox/` alone. */
function isUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * Enumerate `root` recursively and read every file the options select.
 *
 * Throws when the selection is empty. Nearly every caller asserts only that an
 * offender list `toEqual([])`, so a scan that silently looked at nothing would
 * turn those guards green while guarding nothing — the failure mode this throw
 * exists to prevent.
 *
 * Reads are **strictly sequential**: at most one `readFile` is in flight at any
 * moment, for every caller and every root. The widest caller sweeps the whole
 * of `src/`, where any fan-out large enough to be worth having is also large
 * enough to exhaust file descriptors on a low-`ulimit` host.
 */
export async function scanSources(options: SourceScanOptions): Promise<ScannedSource[]> {
  const {
    root,
    extensions = ['.ts'],
    includeTests = false,
    stripComments = false,
    excludeDirs = [],
  } = options;

  const pruned = excludeDirs
    .map((dir) => toPosix(path.relative(root, dir)))
    .filter((relative) => relative !== '');

  const entries = await readdir(root, { recursive: true });
  const files = entries
    .map(toPosix)
    .filter((file) => extensions.some((extension) => file.endsWith(extension)))
    .filter((file) => includeTests || !TEST_FILE.test(file))
    .filter((file) => !pruned.some((dir) => isUnder(file, dir)));

  if (files.length === 0) {
    throw new Error(
      `source scan matched no files under ${root} — the guard using it would assert nothing`,
    );
  }

  const scanned: ScannedSource[] = [];
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    scanned.push({ file, code: stripComments ? stripCommentText(source) : source });
  }
  return scanned;
}

/**
 * The selection every `src/core/epub/` guard shares: production `*.ts` in one
 * folder, tests excluded, recursive so a new module is in scope with no edit.
 *
 * Comment stripping is the only thing those guards differ on. Going through
 * this one preset is what lets `validate.test.ts` ›
 * `describe('public surface and guardrails')` prove the layer guard's *real*
 * reach rather than re-deriving it.
 */
export async function scanProductionSources(
  root: string,
  options: { stripComments?: boolean | undefined } = {},
): Promise<ScannedSource[]> {
  return scanSources({
    root,
    extensions: ['.ts'],
    includeTests: false,
    stripComments: options.stripComments ?? false,
  });
}
