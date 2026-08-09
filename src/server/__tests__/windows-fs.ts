import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Probe symlink capability directly so security tests run on Developer Mode Windows hosts. */
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

/** Tolerate Windows EPERM from lingering libSQL handles; other platforms remain strict. */
export function removeDirTolerant(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}
