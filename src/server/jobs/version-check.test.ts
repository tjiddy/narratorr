import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock getVersion and getCommit
vi.mock('../utils/version.js', () => ({
  getVersion: () => '0.1.0',
  getCommit: () => 'unknown',
  isNewerVersion: (current: string, latest: string) => {
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
  },
}));

const { checkForUpdate, getUpdateStatus, _resetUpdateCache } = await import('./version-check.js');

function makeGitHubRelease(tagName: string, htmlUrl: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ tag_name: tagName, html_url: htmlUrl }),
  };
}

describe('version check job', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    mockFetch.mockReset();
    _resetUpdateCache();
  });

  async function runCheck() {
    await checkForUpdate(log as unknown as FastifyBaseLogger);
  }

  describe('GitHub API — happy path', () => {
    it('newer version found → update info cached and retrievable', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));

      await runCheck();

      const status = getUpdateStatus('');
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      });
    });

    it('same version as current → no update data stored', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.1.0', 'https://github.com/releases/v0.1.0'));

      await runCheck();

      const status = getUpdateStatus('');
      expect(status).toBeUndefined();
    });

    it('older version than current → no update data stored (rollback scenario)', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.0.9', 'https://github.com/releases/v0.0.9'));

      await runCheck();

      const status = getUpdateStatus('');
      expect(status).toBeUndefined();
    });
  });

  describe('GitHub API — failure modes', () => {
    it('429 rate limit → cached last-known result preserved, error logged', async () => {
      // First: cache a successful result
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      expect(getUpdateStatus('')).toBeDefined();

      // Then: rate limit
      mockFetch.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' });
      await runCheck();

      expect(log.warn).toHaveBeenCalled();
      expect(getUpdateStatus('')).toBeDefined(); // cached result preserved
    });

    it('5xx error → cached result preserved, error logged, job completes', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
      await runCheck();

      expect(log.warn).toHaveBeenCalled();
      expect(getUpdateStatus('')).toBeDefined();
    });

    it('malformed JSON response → handled gracefully, cached result preserved', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ unexpected: 'shape' }),
      });
      await runCheck();

      // Should keep cached result since response has no tag_name
      expect(getUpdateStatus('')).toBeDefined();
    });

    it('empty/null release response → no crash, no false update', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });

      await runCheck();

      expect(getUpdateStatus('')).toBeUndefined();
    });

    it('network timeout → error logged with canonical serialized payload, cached result used', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      mockFetch.mockRejectedValue(new Error('fetch failed'));
      await runCheck();

      expect(log.error).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.objectContaining({ message: 'fetch failed', type: 'Error' }) }),
        'Version check: failed to check for updates',
      );
      expect(getUpdateStatus('')).toBeDefined();
    });

    it('tag_name present but html_url missing → cached result preserved with original releaseUrl', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      // Return payload with tag_name but missing html_url
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v0.3.0' }),
      });
      await runCheck();

      const status = getUpdateStatus('');
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      });
    });

    it('tag_name present but html_url is non-string → cached result preserved', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tag_name: 'v0.3.0', html_url: 42 }),
      });
      await runCheck();

      const status = getUpdateStatus('');
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: false,
      });
    });

    it('first run with no cache → API failure results in no update data', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      await runCheck();

      expect(getUpdateStatus('')).toBeUndefined();
    });
  });

  describe('dismissed version integration', () => {
    it('getUpdateStatus returns dismissed: true when dismissed version matches latest', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      const status = getUpdateStatus('0.2.0');
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        dismissed: true,
      });
    });

    it('getUpdateStatus returns dismissed: false when dismissed version differs from latest', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.3.0', 'https://github.com/releases/v0.3.0'));
      await runCheck();

      const status = getUpdateStatus('0.2.0');
      expect(status?.dismissed).toBe(false);
    });
  });
});
