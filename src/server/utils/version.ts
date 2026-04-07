let packageVersion: string | undefined;
let packageCommit: string | undefined;
let packageBuildTime: string | undefined;

/** Returns the app version: "v124 (a78ef)" with tag, or just commit hash without. */
export function getVersion(): string {
  if (!packageVersion) {
    const tag = process.env.GIT_TAG;
    const commit = getCommit();
    const hasTag = tag && tag !== 'unknown';
    const hasCommit = commit !== 'unknown';

    if (hasTag && hasCommit) {
      packageVersion = `${tag} (${commit})`;
    } else if (hasTag) {
      packageVersion = tag;
    } else if (hasCommit) {
      packageVersion = commit;
    } else {
      packageVersion = 'dev';
    }
  }
  return packageVersion;
}

/** Returns the build-injected git commit SHA truncated to 7 characters, or "unknown" when not set. */
export function getCommit(): string {
  if (!packageCommit) {
    const raw = process.env.GIT_COMMIT || 'unknown';
    packageCommit = raw === 'unknown' ? 'unknown' : raw.slice(0, 7);
  }
  return packageCommit;
}

/** Returns the build-injected timestamp as an ISO string, or "unknown" when not set. */
export function getBuildTime(): string {
  if (!packageBuildTime) {
    packageBuildTime = process.env.BUILD_TIME || 'unknown';
  }
  return packageBuildTime;
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
