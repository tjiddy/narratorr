import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Shared recursive scanner for EPUB architecture guards, deliberately outside their
 * production-scanned folder. Use only readdir and readFile because consuming suites
 * replace other fs primitives with spies.
 */

export interface SourceScanOptions {
  root: string;
  /** Suffixes to keep. Default `['.ts']`. */
  extensions?: readonly string[] | undefined;
  /** Keep `*.test.ts` / `*.test.tsx` as well. Default `false`. */
  includeTests?: boolean | undefined;
  /** Apply the text-only comment transform. Default false. */
  stripComments?: boolean | undefined;
  /** Absolute directories to prune by path segment. Default none. */
  excludeDirs?: readonly string[] | undefined;
}

export interface ScannedSource {
  /** Root-relative path, POSIX-separated on every platform. */
  file: string;
  /** File text, optionally comment-stripped. */
  code: string;
}

const TEST_FILE = /\.test\.tsx?$/;

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Text-only and order-sensitive: remove block comments before truncating lines at //,
 * including markers inside strings. Exact quirks are pinned by source-scan.test.ts.
 */
function stripCommentText(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Segment-aware containment, so pruning `foo/` leaves a sibling `foox/` alone. */
function isUnder(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * Recursively reads selected files. Empty selection throws so guards cannot pass
 * vacuously. Reads stay strictly sequential to avoid descriptor exhaustion on full-src scans.
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
 * Shared recursive production-TypeScript selection for EPUB guards. Tests are
 * excluded; callers vary only comment stripping.
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
