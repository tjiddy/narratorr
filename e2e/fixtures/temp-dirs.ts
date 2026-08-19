import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { canonicalPath } from '../../src/server/utils/path-identity.js';

export interface RunTempDirs {
  dbPath: string;
  libraryPath: string;
  configPath: string;
  /** Per-run qBit save path; torrent adds omit `savepath` and use this default. */
  downloadsPath: string;
  /** Manual-import source populated with a discoverable `silent.m4b` fixture. */
  sourcePath: string;
}

export const ROOT_RUN = 'root';

/** The `mkdtempSync` prefix, exported so the teardown sweep's glob cannot drift from the allocator. */
export const HARNESS_TEMP_PREFIX = 'narratorr-e2e-';

/** Strictly exclusive floor: a directory at exactly this age survives the sweep. */
export const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Config-time env carries the manifest location to worker processes; globalSetup env does not. */
export const RUN_MANIFEST_ENV = 'E2E_RUN_MANIFEST';

export const RUN_MANIFEST_FILENAME = '.run-manifest.json';

const RUN_FIELDS = ['dbPath', 'libraryPath', 'configPath', 'downloadsPath', 'sourcePath'] as const;

const runs = new Map<string, RunTempDirs>();

/**
 * The five *directories* a run owns. `dbPath` is a file one level deeper, so its enclosing
 * directory stands in for it — that is what carries libSQL's `-wal`/`-shm` sidecars away.
 */
export function runTempRoots(run: RunTempDirs): string[] {
  return [dirname(run.dbPath), run.libraryPath, run.configPath, run.downloadsPath, run.sourcePath];
}

/**
 * The one confinement predicate, shared by manifest validation, manifest-owned removal, and the
 * stale sweep: `p` is a directory the allocator could have minted. Purely lexical — it does not
 * stat, so an already-removed target still passes, which is what keeps teardown idempotent.
 *
 * `canonicalPath` is the repo's path-identity transform (fold → resolve → fold); it deliberately
 * does not fold case, so a `TMPDIR` respelled between manifest write and read reads as
 * non-conforming. That direction fails safe for a predicate guarding recursive deletion.
 */
export function isHarnessTempRoot(p: string): boolean {
  const canonical = canonicalPath(p);
  return dirname(canonical) === canonicalPath(tmpdir()) && basename(canonical).startsWith(HARNESS_TEMP_PREFIX);
}

/** Allocates five isolated temp roots and records them for teardown. */
export function createRunTempDirs(name: string = ROOT_RUN): RunTempDirs {
  const run = claimRun([]);
  runs.set(name, run);
  return run;
}

/**
 * The allocate-once entry point the Playwright config uses. The first process to load the config
 * allocates every run and publishes a manifest; every later load in the same invocation (worker
 * processes, tooling) adopts that manifest and allocates nothing.
 *
 * Allocation is all-or-nothing: any failure — a later `mkdtempSync` or the publication itself —
 * unwinds every directory recorded so far, leaves the manifest env var unpublished, and rethrows
 * the original error. A half-allocated run would strand directories no manifest names and that the
 * 24h sweep floor then protects for a full day.
 */
export function resolveRunTempDirs(names: readonly string[]): RunTempDirs[] {
  if (!names.includes(ROOT_RUN)) {
    throw new Error(`resolveRunTempDirs: the run set must include "${ROOT_RUN}"; got [${names.join(', ')}]`);
  }

  const manifestPath = process.env[RUN_MANIFEST_ENV];
  const resolved = manifestPath ? adoptManifest(manifestPath, names) : allocateAndPublish(names);

  for (const [name, run] of resolved) runs.set(name, run);
  return names.map((name) => resolved.get(name)!);
}

export function getCurrentRun(): RunTempDirs | undefined {
  return runs.get(ROOT_RUN);
}

export function getRun(name: string): RunTempDirs | undefined {
  return runs.get(name);
}

export function getAllRuns(): RunTempDirs[] {
  return [...runs.values()];
}

/**
 * Teardown's view of the manifest. A manifest that is missing, unreadable, malformed, or names any
 * path outside the harness temp namespace yields ZERO runs rather than an error — teardown must
 * never reject, and a partially trusted manifest must never authorize a recursive delete.
 */
export function readManifestRunsForCleanup(manifestPath: string | undefined): RunTempDirs[] {
  if (!manifestPath) return [];
  try {
    return [...loadManifest(manifestPath).values()];
  } catch {
    return [];
  }
}

export function _resetCurrentRunForTests(): void {
  runs.clear();
}

/** `recorded` is the unwind ledger: each directory lands in it the instant `mkdtempSync` returns. */
function claimRun(recorded: string[]): RunTempDirs {
  const prefix = join(tmpdir(), HARNESS_TEMP_PREFIX);
  const claim = (): string => {
    const dir = mkdtempSync(prefix);
    recorded.push(dir);
    return dir;
  };

  return {
    dbPath: join(claim(), 'narratorr.db'),
    libraryPath: claim(),
    configPath: claim(),
    downloadsPath: claim(),
    sourcePath: claim(),
  };
}

function allocateAndPublish(names: readonly string[]): Map<string, RunTempDirs> {
  const recorded: string[] = [];
  const allocated = new Map<string, RunTempDirs>();

  try {
    for (const name of names) {
      allocated.set(name, claimRun(recorded));
    }
    publishManifest(allocated.get(ROOT_RUN)!.configPath, allocated);
  } catch (error: unknown) {
    for (const dir of recorded) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A failed unwind removal never replaces the original error, and never stops the loop.
      }
    }
    throw error;
  }

  return allocated;
}

/**
 * Written to a temporary sibling and `renameSync`d into place so no reader can observe a torn
 * file, and the env var is exported only after the rename returns — publishing a pointer to a
 * manifest that does not exist yet is what would make the unwind's "unpublished on failure"
 * clause unenforceable.
 */
function publishManifest(rootConfigPath: string, allocated: Map<string, RunTempDirs>): void {
  const finalPath = join(rootConfigPath, RUN_MANIFEST_FILENAME);
  const stagingPath = join(rootConfigPath, `${RUN_MANIFEST_FILENAME}.${process.pid}.staging`);
  const payload = { version: 1, runs: Object.fromEntries(allocated) };

  writeFileSync(stagingPath, JSON.stringify(payload), 'utf-8');
  renameSync(stagingPath, finalPath);
  process.env[RUN_MANIFEST_ENV] = finalPath;
}

function adoptManifest(manifestPath: string, names: readonly string[]): Map<string, RunTempDirs> {
  const loaded = loadManifest(manifestPath);
  for (const name of names) {
    if (!loaded.has(name)) {
      throw new Error(`E2E run manifest ${manifestPath} is missing the "${name}" run`);
    }
  }
  return loaded;
}

/**
 * Parses, shape-checks, and confinement-checks a manifest. Every failure names the manifest path
 * and nothing is returned partially — the caller populates the run map only from a fully validated
 * result, so a rejected manifest can never leave a half-populated map behind.
 */
function loadManifest(manifestPath: string): Map<string, RunTempDirs> {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (error: unknown) {
    throw new Error(`E2E run manifest ${manifestPath} could not be read: ${describe(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error(`E2E run manifest ${manifestPath} is not valid JSON: ${describe(error)}`);
  }

  const entries = manifestEntries(parsed);
  if (!entries) {
    throw new Error(`E2E run manifest ${manifestPath} does not hold a { runs: Record<string, RunTempDirs> } shape`);
  }

  const loaded = new Map<string, RunTempDirs>();
  const seen = new Set<string>();
  for (const [name, run] of entries) {
    for (const dir of runTempRoots(run)) {
      if (!isHarnessTempRoot(dir)) {
        throw new Error(`E2E run manifest ${manifestPath} names a path outside the harness temp namespace: ${dir}`);
      }
      if (seen.has(dir)) {
        throw new Error(`E2E run manifest ${manifestPath} reuses one directory across runs: ${dir}`);
      }
      seen.add(dir);
    }
    loaded.set(name, run);
  }

  const root = loaded.get(ROOT_RUN);
  if (!root) {
    throw new Error(`E2E run manifest ${manifestPath} is missing the "${ROOT_RUN}" run`);
  }
  if (canonicalPath(dirname(manifestPath)) !== canonicalPath(root.configPath)) {
    throw new Error(
      `E2E run manifest ${manifestPath} was read from outside its own root run configPath (${root.configPath})`,
    );
  }

  return loaded;
}

function manifestEntries(parsed: unknown): Array<[string, RunTempDirs]> | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { runs: rawRuns } = parsed as { runs?: unknown };
  if (typeof rawRuns !== 'object' || rawRuns === null || Array.isArray(rawRuns)) return undefined;

  const entries: Array<[string, RunTempDirs]> = [];
  for (const [name, value] of Object.entries(rawRuns as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return undefined;
    const candidate = value as Record<string, unknown>;
    for (const field of RUN_FIELDS) {
      if (typeof candidate[field] !== 'string' || candidate[field] === '') return undefined;
    }
    entries.push([name, {
      dbPath: candidate.dbPath as string,
      libraryPath: candidate.libraryPath as string,
      configPath: candidate.configPath as string,
      downloadsPath: candidate.downloadsPath as string,
      sourcePath: candidate.sourcePath as string,
    }]);
  }
  return entries;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
