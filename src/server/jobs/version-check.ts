import type { FastifyBaseLogger } from 'fastify';
import { getVersion, getCommit, isNewerVersion } from '../utils/version.js';
import { serializeError } from '../utils/serialize-error.js';


type UpdateChannel = 'stable' | 'develop';

interface CachedUpdate {
  latestVersion: string;
  releaseUrl: string;
  channel: UpdateChannel;
}

let cachedUpdate: CachedUpdate | undefined;

/** Reset cached state — for testing only. */
export function _resetUpdateCache() {
  cachedUpdate = undefined;
}

/**
 * Meaningful identity of the cached update for change detection. Two checks are
 * "the same" when they point at the same channel + version, so a same-version
 * re-check (or a URL-only difference) is a no-op and does not nudge. A
 * none→available, version→different-version, or available→cleared transition is
 * a change. A failed/early-return check leaves `cachedUpdate` untouched, so
 * prior and next are the same reference → no change.
 */
function updateIdentityChanged(prior: CachedUpdate | undefined, next: CachedUpdate | undefined): boolean {
  if (!prior && !next) return false;
  if (!prior || !next) return true;
  return prior.channel !== next.channel || prior.latestVersion !== next.latestVersion;
}

const RELEASES_API_URL = 'https://api.github.com/repos/tjiddy/narratorr/releases/latest';
const COMPARE_API_BASE = 'https://api.github.com/repos/tjiddy/narratorr/compare';

// Build fetch options *per call* — `AbortSignal.timeout` starts counting the
// moment it is created, so a module-scoped signal would be permanently aborted
// 10s after load and fail every scheduled/manual check thereafter. Each fetch
// gets a fresh 10s budget.
function fetchOpts(): RequestInit {
  return {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10_000),
  };
}

/**
 * Channel-aware update detection. Classifies the running build *before* any
 * fetch, then routes to the correct comparison:
 * - Local / unbuilt (`dev`, or no baked commit) → no-op, fetch neither endpoint.
 * - Develop build (`develop-<sha>`) → compare the running commit against
 *   `develop` HEAD via the GitHub compare API (`ahead_by > 0` ⇒ newer build).
 * - Stable build (the fallthrough — any real release tag, e.g. `v1.2.3`) →
 *   semver compare against `/releases/latest`.
 *
 * Stable is the *else* branch (not `dev`, not `develop-`); the existing
 * `isNewerVersion` strips an optional leading `v`, so real `vX.Y.Z` images are
 * handled without a strict `X.Y.Z` gate in the router.
 */
export async function checkForUpdate(
  log: FastifyBaseLogger,
  onUpdateChanged?: () => void,
): Promise<void> {
  const currentVersion = getVersion();
  const currentCommit = getCommit();

  // Local / unbuilt → no-op. Leave any prior cache untouched, fetch nothing.
  if (currentVersion === 'dev' || currentCommit === 'unknown') return;

  // Capture the prior cached value before the channel check mutates it, so we
  // can detect a status change and nudge consumers (e.g. the health card) only
  // when the meaningful identity actually changed.
  const prior = cachedUpdate;

  if (currentVersion.startsWith('develop-')) {
    await checkDevelopUpdate(log, currentCommit);
  } else {
    await checkStableUpdate(log, currentVersion);
  }

  if (onUpdateChanged && updateIdentityChanged(prior, cachedUpdate)) {
    onUpdateChanged();
  }
}

/** Stable channel: semver compare against the latest GitHub release. */
async function checkStableUpdate(log: FastifyBaseLogger, currentVersion: string): Promise<void> {
  try {
    const response = await fetch(RELEASES_API_URL, fetchOpts());
    if (!response.ok) {
      log.warn({ status: response.status, statusText: response.statusText }, 'Version check: GitHub API returned non-OK status');
      return;
    }

    const data = await response.json();
    if (!data || typeof data.tag_name !== 'string' || typeof data.html_url !== 'string') {
      log.warn('Version check: GitHub API returned unexpected response shape');
      return;
    }

    const latestVersion = data.tag_name.replace(/^v/, '');
    if (isNewerVersion(currentVersion, latestVersion)) {
      cachedUpdate = { latestVersion, releaseUrl: data.html_url, channel: 'stable' };
      log.info({ currentVersion, latestVersion }, 'Version check: newer version available');
    } else {
      cachedUpdate = undefined;
      log.debug({ currentVersion, latestVersion }, 'Version check: on latest version');
    }
  } catch (error: unknown) {
    log.error({ error: serializeError(error) }, 'Version check: failed to check for updates');
  }
}

/**
 * Develop channel: compare the running commit against `develop` HEAD. A
 * positive `ahead_by` means develop has advanced past the running build, so a
 * newer develop image exists. `develop` is force-push-protected, so the running
 * commit is always an ancestor of HEAD (no `diverged` edge in practice).
 */
async function checkDevelopUpdate(log: FastifyBaseLogger, currentCommit: string): Promise<void> {
  try {
    const response = await fetch(`${COMPARE_API_BASE}/${currentCommit}...develop`, fetchOpts());
    if (!response.ok) {
      log.warn({ status: response.status, statusText: response.statusText }, 'Version check: GitHub compare API returned non-OK status');
      return;
    }

    const data = await response.json();
    if (!data || typeof data.ahead_by !== 'number' || typeof data.html_url !== 'string') {
      log.warn('Version check: GitHub compare API returned unexpected response shape');
      return;
    }

    if (data.ahead_by > 0) {
      cachedUpdate = {
        latestVersion: developHeadSha(data),
        releaseUrl: data.html_url,
        channel: 'develop',
      };
      log.info({ currentCommit, aheadBy: data.ahead_by }, 'Version check: newer develop build available');
    } else {
      cachedUpdate = undefined;
      log.debug({ currentCommit }, 'Version check: on latest develop build');
    }
  } catch (error: unknown) {
    log.error({ error: serializeError(error) }, 'Version check: failed to check for updates');
  }
}

/**
 * The compare API lists `commits` oldest-first; the last entry is `develop`
 * HEAD. Return its short sha (bare, no `v` prefix — the develop copy supplies
 * its own wording). Falls back to `develop` if the shape is unexpectedly thin.
 */
function developHeadSha(data: { commits?: unknown }): string {
  const commits = data.commits;
  if (Array.isArray(commits) && commits.length > 0) {
    const head = commits[commits.length - 1];
    if (head && typeof head.sha === 'string') return head.sha.slice(0, 7);
  }
  return 'develop';
}

/**
 * Returns the current update status, or undefined if no update is available.
 * The additive `channel` discriminator lets consumers render channel-appropriate
 * copy without inspecting URL strings; existing fields are unchanged.
 */
export function getUpdateStatus(): {
  latestVersion: string;
  releaseUrl: string;
  channel: UpdateChannel;
} | undefined {
  if (!cachedUpdate) return undefined;
  return {
    ...cachedUpdate,
  };
}
