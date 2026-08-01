import { resolveVersionTag } from '@shared/user-agent.js';

let packageVersion: string | undefined;
let packageCommit: string | undefined;
let packageBuildTime: string | undefined;

/** Returns the app version from the build-injected git tag, or "dev" when not built from a tag. */
export function getVersion(): string {
  if (!packageVersion) {
    packageVersion = resolveVersionTag();
  }
  return packageVersion;
}

/**
 * How many characters of a git SHA this app displays.
 *
 * This is deliberately a constant and not derived from git. Git's own
 * `core.abbrev=auto` sizes the abbreviation from the repository's object count
 * — 7 for a fresh repo, 8 for narratorr today, more as it grows — so the
 * "correct" length is a moving target. Deriving it at build time was tried and
 * rejected: `.github/workflows/docker.yml` checks out with the `actions/checkout`
 * default `fetch-depth: 1`, and a depth-1 clone has one commit, so
 * `git rev-parse --short` in CI computes 7 from that shallow object count rather
 * than the 8 a full clone gives. Making it honest would mean `fetch-depth: 0` —
 * downloading full history on every image build — to move a display string by one
 * character.
 *
 * 8 matches what git currently picks for this repo, which is what `git log`
 * shows. Every site that abbreviates a SHA reads this constant so the three of
 * them cannot drift apart; the fourth lives in `docker.yml` (`${GITHUB_SHA::8}`)
 * and cannot import from here, so it carries a comment pointing back at this one.
 *
 * If git starts printing 9, this is the one number to change.
 */
export const SHORT_SHA_LENGTH = 8;

/**
 * Returns the build-injected git commit SHA, abbreviated to `SHORT_SHA_LENGTH`,
 * or "unknown" when not set. A value already shorter than that is returned
 * unchanged — the slice is a defensive cap on a full 40-char SHA, not a
 * reformat of whatever the build injected.
 */
export function getCommit(): string {
  if (!packageCommit) {
    const raw = process.env.GIT_COMMIT || 'unknown';
    packageCommit = raw === 'unknown' ? 'unknown' : raw.slice(0, SHORT_SHA_LENGTH);
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
    if (l[i]! > c[i]!) return true;
    if (l[i]! < c[i]!) return false;
  }
  return false;
}
