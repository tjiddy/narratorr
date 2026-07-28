import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Windows-hostile filesystem primitives, shared by the suites that need them.
 * Full taxonomy: `.workflume/learnings.md` → `windows-hostile-test-primitives`.
 */

/**
 * Can this machine create a symlink at all?
 *
 * Windows needs Developer Mode or an elevated shell for `symlink()`; without one
 * it raises `EPERM` and a symlink fixture cannot be built. A junction is not a
 * substitute — it is directory-only, and `lstat().isSymbolicLink()` is what the
 * production paths actually test.
 *
 * Probed rather than gated on `process.platform === 'win32'`, because a Windows
 * box with Developer Mode enabled *can* run these, and most symlink assertions
 * guard a security property (a symlink named `book.epub` pointing at
 * `<config>/secret.key`) that should be skipped as rarely as possible.
 */
export const CAN_SYMLINK = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'narratorr-symlink-probe-'));
  try {
    const target = join(probe, 'target');
    writeFileSync(target, '');
    symlinkSync(target, join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

/**
 * `rmSync(dir, { recursive: true, force: true })` that tolerates Windows EPERM.
 *
 * Windows refuses to delete a directory containing open handles, and a libSQL
 * database keeps one even after `client.close()` — documented repro at
 * `src/server/__tests__/e2e-helpers.ts:38` (create-client → close → rmSync
 * fails EPERM). On Linux the delete still runs strictly, so a genuine cleanup
 * regression is not masked where it can actually be observed. A leaked tmpdir
 * on Windows is cheaper than a red suite.
 */
export function removeDirTolerant(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}
