import { readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTreeSync } from '../src/core/utils/remove-tree.js';
import {
  getAllRuns,
  isHarnessTempRoot,
  readManifestRunsForCleanup,
  runTempRoots,
  HARNESS_TEMP_PREFIX,
  RUN_MANIFEST_ENV,
  SWEEP_MAX_AGE_MS,
} from './fixtures/temp-dirs.js';
import { getRegisteredFakes, clearRegisteredFakes } from './fixtures/run-state.js';
import { cleanupRunPathsFile } from './global-setup.js';

/**
 * Three independently guarded stages — close the fakes, remove the paths this invocation owns,
 * sweep stale strays — in that order. A failure in one never skips a later one, and teardown never
 * rejects: a Windows `EPERM` on a directory that held a libSQL database is expected, not an error.
 */
export default async function globalTeardown(): Promise<void> {
  for (const fake of getRegisteredFakes()) {
    try {
      await fake.close();
    } catch {
      // Best-effort — a dangling listener is better than a failed teardown.
    }
  }
  clearRegisteredFakes();

  try {
    cleanupRunPathsFile();
    for (const target of ownedTargets()) {
      try {
        removeTreeSync(target);
      } catch {
        // Best-effort cleanup.
      }
    }
  } catch {
    // The sweep below is the second line and must run regardless.
  }

  sweepStaleHarnessTempDirs();
}

/**
 * The second line for batches allocated by processes that never run teardown (Playwright evaluates
 * the config in tooling processes too). Unconditional — gating it on a manifest would leave exactly
 * the strays it exists to collect. `now` is injectable so the age boundary is testable without
 * sleeping, and the floor is strictly exclusive so a concurrent invocation's dirs are never touched.
 */
export function sweepStaleHarnessTempDirs(now: number = Date.now()): void {
  const root = tmpdir();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }

  const cutoff = now - SWEEP_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.startsWith(HARNESS_TEMP_PREFIX)) continue;
    const candidate = join(root, entry);
    if (!isHarnessTempRoot(candidate)) continue;

    let stats;
    try {
      stats = statSync(candidate);
    } catch {
      // A concurrent run's teardown can unlink between `readdir` and `stat`.
      continue;
    }
    if (!stats.isDirectory() || stats.mtimeMs >= cutoff) continue;

    try {
      removeTreeSync(candidate);
    } catch {
      // Best-effort cleanup.
    }
  }
}

/**
 * Every directory this invocation owns: the manifest's runs plus whatever this process allocated
 * itself. Confinement is re-checked here rather than trusted, because the manifest is durable state
 * on disk and `removeTreeSync` validates nothing of its own.
 *
 * Targets and dedup key are both whatever `runTempRoots` yields, which is the canonical identity —
 * the same value `isHarnessTempRoot` approved. That equality is the point: a manifest is
 * hand-editable durable state, and validating one spelling while deleting another is how an
 * accepted-but-aliased root (`<dir>\.`) silently no-ops on POSIX and leaks the real directory.
 */
function ownedTargets(): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];

  for (const run of [...readManifestRunsForCleanup(process.env[RUN_MANIFEST_ENV]), ...getAllRuns()]) {
    for (const dir of runTempRoots(run)) {
      if (!isHarnessTempRoot(dir) || seen.has(dir)) continue;
      seen.add(dir);
      targets.push(dir);
    }
  }

  return targets;
}
