import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { getVersion, getCommit, isNewerVersion, SHORT_SHA_LENGTH } from '../utils/version.js';
import { serializeError } from '../utils/serialize-error.js';


type UpdateChannel = 'stable' | 'develop';

// GitHub adds fields, so these schemas strip unknown keys. Nullish commit data
// reaches the 'develop' fallback instead of invalidating the whole response.
const githubReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
});

const githubCompareSchema = z.object({
  ahead_by: z.number(),
  html_url: z.string(),
  commits: z.array(z.object({ sha: z.string().nullish() })).nullish(),
});

interface CachedUpdate {
  latestVersion: string;
  releaseUrl: string;
  channel: UpdateChannel;
}

let cachedUpdate: CachedUpdate | undefined;

export function _resetUpdateCache() {
  cachedUpdate = undefined;
}

// A URL-only change does not notify consumers.
function updateIdentityChanged(prior: CachedUpdate | undefined, next: CachedUpdate | undefined): boolean {
  if (!prior && !next) return false;
  if (!prior || !next) return true;
  return prior.channel !== next.channel || prior.latestVersion !== next.latestVersion;
}

const RELEASES_API_URL = 'https://api.github.com/repos/tjiddy/narratorr/releases/latest';
const COMPARE_API_BASE = 'https://api.github.com/repos/tjiddy/narratorr/compare';

// AbortSignal.timeout starts immediately; create it per request, not at module load.
function fetchOpts(): RequestInit {
  return {
    headers: { 'Accept': 'application/vnd.github.v3+json' },
    signal: AbortSignal.timeout(10_000),
  };
}

// Every built, non-develop version follows the stable path; isNewerVersion accepts a leading v.
export async function checkForUpdate(
  log: FastifyBaseLogger,
  onUpdateChanged?: () => void,
): Promise<void> {
  const currentVersion = getVersion();
  const currentCommit = getCommit();

  if (currentVersion === 'dev' || currentCommit === 'unknown') return;

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

async function checkStableUpdate(log: FastifyBaseLogger, currentVersion: string): Promise<void> {
  try {
    const response = await fetch(RELEASES_API_URL, fetchOpts());
    if (!response.ok) {
      log.warn({ status: response.status, statusText: response.statusText }, 'Version check: GitHub API returned non-OK status');
      return;
    }

    const data = await response.json();
    const result = githubReleaseSchema.safeParse(data);
    if (!result.success) {
      log.warn('Version check: GitHub API returned unexpected response shape');
      return;
    }

    const latestVersion = result.data.tag_name.replace(/^v/, '');
    if (isNewerVersion(currentVersion, latestVersion)) {
      cachedUpdate = { latestVersion, releaseUrl: result.data.html_url, channel: 'stable' };
      log.info({ currentVersion, latestVersion }, 'Version check: newer version available');
    } else {
      cachedUpdate = undefined;
      log.debug({ currentVersion, latestVersion }, 'Version check: on latest version');
    }
  } catch (error: unknown) {
    log.error({ error: serializeError(error) }, 'Version check: failed to check for updates');
  }
}

// GitHub's ahead_by > 0 means develop advanced beyond currentCommit. The branch
// is force-push-protected, so currentCommit is assumed to be its ancestor.
async function checkDevelopUpdate(log: FastifyBaseLogger, currentCommit: string): Promise<void> {
  try {
    const response = await fetch(`${COMPARE_API_BASE}/${currentCommit}...develop`, fetchOpts());
    if (!response.ok) {
      log.warn({ status: response.status, statusText: response.statusText }, 'Version check: GitHub compare API returned non-OK status');
      return;
    }

    const data = await response.json();
    const result = githubCompareSchema.safeParse(data);
    if (!result.success) {
      log.warn('Version check: GitHub compare API returned unexpected response shape');
      return;
    }

    if (result.data.ahead_by > 0) {
      cachedUpdate = {
        latestVersion: developHeadSha(result.data),
        releaseUrl: result.data.html_url,
        channel: 'develop',
      };
      log.info({ currentCommit, aheadBy: result.data.ahead_by }, 'Version check: newer develop build available');
    } else {
      cachedUpdate = undefined;
      log.debug({ currentCommit }, 'Version check: on latest develop build');
    }
  } catch (error: unknown) {
    log.error({ error: serializeError(error) }, 'Version check: failed to check for updates');
  }
}

// GitHub orders compare commits oldest-first. This display label matches
// getCommit's width; ahead_by, not the label, determines freshness.
function developHeadSha(data: { commits?: unknown }): string {
  const commits = data.commits;
  if (Array.isArray(commits) && commits.length > 0) {
    const head = commits[commits.length - 1];
    if (head && typeof head.sha === 'string') return head.sha.slice(0, SHORT_SHA_LENGTH);
  }
  return 'develop';
}

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
