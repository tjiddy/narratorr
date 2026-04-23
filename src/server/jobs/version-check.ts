import type { FastifyBaseLogger } from 'fastify';
import { getVersion, isNewerVersion } from '../utils/version.js';
import { serializeError } from '../utils/serialize-error.js';


interface CachedUpdate {
  latestVersion: string;
  releaseUrl: string;
}

let cachedUpdate: CachedUpdate | undefined;

/** Reset cached state — for testing only. */
export function _resetUpdateCache() {
  cachedUpdate = undefined;
}

const GITHUB_API_URL = 'https://api.github.com/repos/tjiddy/narratorr/releases/latest';

export async function checkForUpdate(log: FastifyBaseLogger): Promise<void> {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: { 'Accept': 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(10_000),
    });

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
    const currentVersion = getVersion();

    if (isNewerVersion(currentVersion, latestVersion)) {
      cachedUpdate = {
        latestVersion,
        releaseUrl: data.html_url,
      };
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
 * Returns the current update status, or undefined if no update is available.
 * The `dismissed` flag is derived from the provided dismissedUpdateVersion.
 */
export function getUpdateStatus(dismissedUpdateVersion: string): {
  latestVersion: string;
  releaseUrl: string;
  dismissed: boolean;
} | undefined {
  if (!cachedUpdate) return undefined;
  return {
    ...cachedUpdate,
    dismissed: dismissedUpdateVersion === cachedUpdate.latestVersion,
  };
}
