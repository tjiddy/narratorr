import { readFileSync } from 'fs';
import { resolve } from 'path';

let packageVersion: string | undefined;
let packageCommit: string | undefined;

/** Returns the app version from package.json (cached after first call). */
export function getVersion(): string {
  if (!packageVersion) {
    try {
      const pkgPath = resolve(process.cwd(), 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      packageVersion = pkg.version;
    } catch {
      packageVersion = '0.0.0';
    }
  }
  return packageVersion!;
}

/** Returns the build-injected git commit SHA truncated to 7 characters, or "unknown" when not set. */
export function getCommit(): string {
  if (!packageCommit) {
    const raw = process.env.GIT_COMMIT || 'unknown';
    packageCommit = raw === 'unknown' ? 'unknown' : raw.slice(0, 7);
  }
  return packageCommit;
}

/**
 * Returns true if `latest` is a newer semver than `current`.
 * Handles optional "v" prefix. Returns false for invalid versions.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => {
    const match = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  };

  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return false;

  for (let i = 0; i < 3; i++) {
    if (l[i] > c[i]) return true;
    if (l[i] < c[i]) return false;
  }
  return false;
}
