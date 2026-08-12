import { resolveVersionTag } from '@shared/user-agent.js';

let packageVersion: string | undefined;
let packageCommit: string | undefined;
let packageBuildTime: string | undefined;

export function getVersion(): string {
  if (!packageVersion) {
    packageVersion = resolveVersionTag();
  }
  return packageVersion;
}

/**
 * Fixed rather than git-derived: shallow CI clones choose 7 while the full repository
 * chooses 8. TypeScript consumers share this constant; docker.yml mirrors it manually.
 */
export const SHORT_SHA_LENGTH = 8;

export function getCommit(): string {
  if (!packageCommit) {
    const raw = process.env.GIT_COMMIT || 'unknown';
    packageCommit = raw === 'unknown' ? 'unknown' : raw.slice(0, SHORT_SHA_LENGTH);
  }
  return packageCommit;
}

export function getBuildTime(): string {
  if (!packageBuildTime) {
    packageBuildTime = process.env.BUILD_TIME || 'unknown';
  }
  return packageBuildTime;
}

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
    if (l[i]! > c[i]!) return true;
    if (l[i]! < c[i]!) return false;
  }
  return false;
}
