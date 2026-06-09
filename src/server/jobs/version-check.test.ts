import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockLogger } from '../__tests__/helpers.js';
import type { FastifyBaseLogger } from 'fastify';
import type * as versionModule from '../utils/version.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock getVersion/getCommit only — keep the real isNewerVersion so this test
// validates production semver comparison (not a re-implementation of it).
// `channelState` is hoisted so each test can drive the channel router by
// setting the running version/commit before invoking the check.
const channelState = vi.hoisted(() => ({ version: '0.1.0', commit: 'abc1234' }));
vi.mock('../utils/version.js', async () => {
  const actual = await vi.importActual<typeof versionModule>('../utils/version.js');
  return {
    ...actual,
    getVersion: () => channelState.version,
    getCommit: () => channelState.commit,
  };
});

const { checkForUpdate, getUpdateStatus, _resetUpdateCache } = await import('./version-check.js');

function makeGitHubRelease(tagName: string, htmlUrl: string) {
  return {
    ok: true,
    json: () => Promise.resolve({ tag_name: tagName, html_url: htmlUrl }),
  };
}

const COMPARE_HTML_URL = 'https://github.com/tjiddy/narratorr/compare/abc1234...develop';

function makeGitHubCompare(aheadBy: number, htmlUrl: string, headSha = 'def56780000') {
  return {
    ok: true,
    json: () => Promise.resolve({
      ahead_by: aheadBy,
      html_url: htmlUrl,
      commits: [{ sha: '1111111aaaa' }, { sha: headSha }],
    }),
  };
}

describe('version check job', () => {
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    log = createMockLogger();
    mockFetch.mockReset();
    _resetUpdateCache();
    // Default to a stable build with a real baked commit so the existing
    // stable-channel suites run the releases path (not the unbuilt no-op).
    channelState.version = '0.1.0';
    channelState.commit = 'abc1234';
  });

  async function runCheck() {
    await checkForUpdate(log as unknown as FastifyBaseLogger);
  }

  describe('GitHub API — happy path', () => {
    it('newer version found → update info cached and retrievable', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));

      await runCheck();

      const status = getUpdateStatus();
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        channel: 'stable',
      });
    });

    it('same version as current → no update data stored', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.1.0', 'https://github.com/releases/v0.1.0'));

      await runCheck();

      const status = getUpdateStatus();
      expect(status).toBeUndefined();
    });

    it('older version than current → no update data stored (rollback scenario)', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.0.9', 'https://github.com/releases/v0.0.9'));

      await runCheck();

      const status = getUpdateStatus();
      expect(status).toBeUndefined();
    });
  });

  describe('GitHub API — failure modes', () => {
    it('429 rate limit → cached last-known result preserved, error logged', async () => {
      // First: cache a successful result
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      expect(getUpdateStatus()).toBeDefined();

      // Then: rate limit
      mockFetch.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests' });
      await runCheck();

      expect(log.warn).toHaveBeenCalled();
      expect(getUpdateStatus()).toBeDefined(); // cached result preserved
    });

    it('5xx error → cached result preserved, error logged, job completes', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();

      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });
      await runCheck();

      expect(log.warn).toHaveBeenCalled();
      expect(getUpdateStatus()).toBeDefined();
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
      expect(getUpdateStatus()).toBeDefined();
    });

    it('empty/null release response → no crash, no false update', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(null),
      });

      await runCheck();

      expect(getUpdateStatus()).toBeUndefined();
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
      expect(getUpdateStatus()).toBeDefined();
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

      const status = getUpdateStatus();
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        channel: 'stable',
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

      const status = getUpdateStatus();
      expect(status).toEqual({
        latestVersion: '0.2.0',
        releaseUrl: 'https://github.com/releases/v0.2.0',
        channel: 'stable',
      });
    });

    it('first run with no cache → API failure results in no update data', async () => {
      mockFetch.mockRejectedValue(new Error('network error'));
      await runCheck();

      expect(getUpdateStatus()).toBeUndefined();
    });
  });

  describe('real semver comparison drives job behavior', () => {
    // These fixtures exercise the boundary cases handled by the real isNewerVersion:
    // it returns false for non-strict-X.Y.Z inputs (incl. prereleases, partial versions),
    // and only flags ascending major/minor/patch as newer.
    it.each([
      { current: '0.1.0', latest: 'v0.1.1', expectsUpdate: true, label: 'patch bump' },
      { current: '0.1.0', latest: 'v1.0.0', expectsUpdate: true, label: 'major bump' },
      { current: '0.1.0', latest: 'v0.1.0', expectsUpdate: false, label: 'identical version' },
      { current: '0.1.0', latest: 'v0.0.9', expectsUpdate: false, label: 'rollback' },
      { current: '0.1.0', latest: 'v0.2.0-rc1', expectsUpdate: false, label: 'prerelease tag (real fn returns false for non-strict semver)' },
      { current: '0.1.0', latest: 'v0.2', expectsUpdate: false, label: 'partial version (real fn returns false for non-strict semver)' },
    ])('$label: $current vs $latest → update=$expectsUpdate', async ({ latest, expectsUpdate }) => {
      mockFetch.mockResolvedValue(makeGitHubRelease(latest, `https://github.com/releases/${latest}`));
      await runCheck();
      const status = getUpdateStatus();
      if (expectsUpdate) {
        expect(status).toBeDefined();
        expect(status?.latestVersion).toBe(latest.replace(/^v/, ''));
      } else {
        expect(status).toBeUndefined();
      }
    });
  });

  describe('develop channel — compare API', () => {
    beforeEach(() => {
      channelState.version = 'develop-abc1234';
      channelState.commit = 'abc1234';
    });

    it('develop HEAD ahead → populates a develop update from the compare URL', async () => {
      mockFetch.mockResolvedValue(makeGitHubCompare(5, COMPARE_HTML_URL, 'def56780000'));

      await runCheck();

      const status = getUpdateStatus();
      expect(status).toEqual({
        latestVersion: 'def5678', // develop HEAD short sha (bare, no v-prefix)
        releaseUrl: COMPARE_HTML_URL,
        channel: 'develop',
      });
      // Only the compare endpoint was hit — /releases/latest is never fetched.
      const url = mockFetch.mock.calls[0]![0] as string;
      expect(url).toBe('https://api.github.com/repos/tjiddy/narratorr/compare/abc1234...develop');
      expect(mockFetch.mock.calls.every(([u]) => !String(u).includes('/releases/latest'))).toBe(true);
    });

    it('develop sitting on HEAD (ahead_by 0) → clears a previously-cached update', async () => {
      // Seed a develop update first.
      mockFetch.mockResolvedValue(makeGitHubCompare(3, COMPARE_HTML_URL));
      await runCheck();
      expect(getUpdateStatus()).toBeDefined();

      // Now develop has not advanced past the running commit.
      mockFetch.mockResolvedValue(makeGitHubCompare(0, COMPARE_HTML_URL));
      await runCheck();

      expect(getUpdateStatus()).toBeUndefined();
    });

    it('develop path never compares against a stable release', async () => {
      mockFetch.mockResolvedValue(makeGitHubCompare(2, COMPARE_HTML_URL));
      await runCheck();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]![0]).toContain('/compare/');
      expect(getUpdateStatus()?.channel).toBe('develop');
    });

    describe('failure modes preserve prior cache', () => {
      async function seedDevelopUpdate() {
        mockFetch.mockResolvedValue(makeGitHubCompare(4, COMPARE_HTML_URL));
        await runCheck();
        expect(getUpdateStatus()).toBeDefined();
      }

      it('non-OK (404) → cached result preserved, warn logged', async () => {
        await seedDevelopUpdate();
        mockFetch.mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' });
        await runCheck();
        expect(log.warn).toHaveBeenCalled();
        expect(getUpdateStatus()).toBeDefined();
      });

      it('5xx → cached result preserved, warn logged', async () => {
        await seedDevelopUpdate();
        mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });
        await runCheck();
        expect(log.warn).toHaveBeenCalled();
        expect(getUpdateStatus()).toBeDefined();
      });

      it('missing ahead_by → cached result preserved (unexpected shape)', async () => {
        await seedDevelopUpdate();
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ html_url: COMPARE_HTML_URL }) });
        await runCheck();
        expect(log.warn).toHaveBeenCalled();
        expect(getUpdateStatus()).toBeDefined();
      });

      it('non-number ahead_by → cached result preserved', async () => {
        await seedDevelopUpdate();
        mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ ahead_by: 'lots', html_url: COMPARE_HTML_URL }) });
        await runCheck();
        expect(getUpdateStatus()).toBeDefined();
      });

      it('rejected fetch → error logged, cached result preserved', async () => {
        await seedDevelopUpdate();
        mockFetch.mockRejectedValue(new Error('compare fetch failed'));
        await runCheck();
        expect(log.error).toHaveBeenCalledWith(
          expect.objectContaining({ error: expect.objectContaining({ message: 'compare fetch failed', type: 'Error' }) }),
          'Version check: failed to check for updates',
        );
        expect(getUpdateStatus()).toBeDefined();
      });
    });
  });

  describe('stable channel — v-prefixed release tag (F1)', () => {
    it('getVersion() → v1.0.0 routes to the releases path, not a no-op', async () => {
      channelState.version = 'v1.0.0';
      channelState.commit = 'abc1234';
      mockFetch.mockResolvedValue(makeGitHubRelease('v1.1.0', 'https://github.com/releases/v1.1.0'));

      await runCheck();

      const status = getUpdateStatus();
      expect(status).toEqual({
        latestVersion: '1.1.0',
        releaseUrl: 'https://github.com/releases/v1.1.0',
        channel: 'stable',
      });
      // Releases endpoint was used; the compare endpoint was never fetched.
      expect(mockFetch.mock.calls[0]![0]).toContain('/releases/latest');
      expect(mockFetch.mock.calls.every(([u]) => !String(u).includes('/compare/'))).toBe(true);
    });
  });

  describe('dev / unbuilt → no-op', () => {
    it('getVersion() === dev → neither endpoint fetched, prior cache untouched', async () => {
      // Seed a stable update under a real build first.
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      expect(getUpdateStatus()).toBeDefined();
      mockFetch.mockClear();

      channelState.version = 'dev';
      channelState.commit = 'abc1234';
      await runCheck();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(getUpdateStatus()).toBeDefined(); // prior cache preserved
    });

    it('getCommit() === unknown → neither endpoint fetched, prior cache untouched', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      expect(getUpdateStatus()).toBeDefined();
      mockFetch.mockClear();

      channelState.version = '0.1.0';
      channelState.commit = 'unknown';
      await runCheck();

      expect(mockFetch).not.toHaveBeenCalled();
      expect(getUpdateStatus()).toBeDefined();
    });
  });

  describe('channel routing — endpoint selected purely off version/commit', () => {
    it.each([
      { version: 'v1.0.0', commit: 'abc1234', endpoint: 'releases', label: 'v-prefixed release' },
      { version: '1.0.0', commit: 'abc1234', endpoint: 'releases', label: 'bare semver' },
      { version: 'develop-abc1234', commit: 'abc1234', endpoint: 'compare', label: 'develop build' },
      { version: 'dev', commit: 'abc1234', endpoint: 'none', label: 'dev sentinel' },
      { version: '1.0.0', commit: 'unknown', endpoint: 'none', label: 'unbuilt commit' },
    ])('$label → $endpoint endpoint', async ({ version, commit, endpoint }) => {
      channelState.version = version;
      channelState.commit = commit;
      mockFetch.mockResolvedValue(
        endpoint === 'compare'
          ? makeGitHubCompare(0, COMPARE_HTML_URL)
          : makeGitHubRelease('v1.0.0', 'https://github.com/releases/v1.0.0'),
      );

      await runCheck();

      if (endpoint === 'none') {
        expect(mockFetch).not.toHaveBeenCalled();
      } else {
        expect(mockFetch).toHaveBeenCalledTimes(1);
        const url = String(mockFetch.mock.calls[0]![0]);
        expect(url).toContain(endpoint === 'releases' ? '/releases/latest' : '/compare/');
        expect(url).not.toContain(endpoint === 'releases' ? '/compare/' : '/releases/latest');
      }
    });
  });

  describe('timeout signal freshness (F1)', () => {
    // The abort signal must be built per fetch call. A module-scoped
    // `AbortSignal.timeout(10_000)` would start counting at load and be
    // permanently aborted once the app has been up past the window, silently
    // failing every scheduled/manual check thereafter.
    function captureSignals() {
      const signals: (AbortSignal | undefined)[] = [];
      mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
        signals.push(opts?.signal ?? undefined);
        return Promise.resolve(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      });
      return signals;
    }

    it('builds a fresh, non-aborted signal for a check run past the timeout window', async () => {
      vi.useFakeTimers();
      try {
        const signals = captureSignals();

        await runCheck();
        // Simulate the app being up well past the 10s fetch timeout window.
        vi.advanceTimersByTime(11_000);
        await runCheck();

        expect(mockFetch).toHaveBeenCalledTimes(2);
        // A shared module-scoped signal would be the same object on both calls
        // (and already aborted after the advance); a per-call signal is distinct.
        expect(signals[0]).not.toBe(signals[1]);
        expect(signals[1]?.aborted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('the develop path also builds a per-call signal', async () => {
      channelState.version = 'develop-abc1234';
      channelState.commit = 'abc1234';
      const signals: (AbortSignal | undefined)[] = [];
      mockFetch.mockImplementation((_url: string, opts?: RequestInit) => {
        signals.push(opts?.signal ?? undefined);
        return Promise.resolve(makeGitHubCompare(2, COMPARE_HTML_URL));
      });

      await runCheck();
      await runCheck();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(signals[0]).not.toBe(signals[1]);
      expect(signals[0]?.aborted).toBe(false);
      expect(signals[1]?.aborted).toBe(false);
    });
  });

  describe('onUpdateChanged nudge (#1262)', () => {
    async function runCheckWith(onUpdateChanged: () => void) {
      await checkForUpdate(log as unknown as FastifyBaseLogger, onUpdateChanged);
    }

    it('none → available invokes the callback exactly once', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      const onUpdateChanged = vi.fn();

      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).toHaveBeenCalledTimes(1);
    });

    it('available → different version invokes the callback once', async () => {
      // Seed an available update first (no callback so the count starts clean).
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      const onUpdateChanged = vi.fn();

      mockFetch.mockResolvedValue(makeGitHubRelease('v0.3.0', 'https://github.com/releases/v0.3.0'));
      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).toHaveBeenCalledTimes(1);
      expect(getUpdateStatus()?.latestVersion).toBe('0.3.0');
    });

    it('channel change with the SAME latestVersion invokes the callback once (channel participates in identity)', async () => {
      // Seed a stable-channel update at latestVersion '0.2.0' (no callback yet).
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      expect(getUpdateStatus()).toMatchObject({ latestVersion: '0.2.0', channel: 'stable' });

      // Now the running build is a develop image. The compare API's HEAD commit
      // sha is '0.2.0' so `developHeadSha` (sha.slice(0,7)) yields the IDENTICAL
      // latestVersion '0.2.0' — only the channel differs (stable → develop).
      // If the production identity dropped the `channel` comparison, this would
      // be seen as a no-op and the callback would NOT fire.
      channelState.version = 'develop-abc1234';
      channelState.commit = 'abc1234';
      mockFetch.mockResolvedValue(makeGitHubCompare(2, COMPARE_HTML_URL, '0.2.0'));
      const onUpdateChanged = vi.fn();

      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).toHaveBeenCalledTimes(1);
      expect(getUpdateStatus()).toMatchObject({ latestVersion: '0.2.0', channel: 'develop' });
    });

    it('available → cleared (now on latest) invokes the callback once', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      const onUpdateChanged = vi.fn();

      // Latest release now matches the running build → cache clears.
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.1.0', 'https://github.com/releases/v0.1.0'));
      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).toHaveBeenCalledTimes(1);
      expect(getUpdateStatus()).toBeUndefined();
    });

    it('same version as the current cached update does not invoke the callback (no-op guard)', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      const onUpdateChanged = vi.fn();

      // Re-check yields the same available version → meaningful identity unchanged.
      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).not.toHaveBeenCalled();
    });

    it('no cached update and still no update does not invoke the callback', async () => {
      // Running build is already latest → nothing cached, nothing changes.
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.1.0', 'https://github.com/releases/v0.1.0'));
      const onUpdateChanged = vi.fn();

      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).not.toHaveBeenCalled();
    });

    it('a failed check (prior cache preserved) does not invoke the callback', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await runCheck();
      const onUpdateChanged = vi.fn();

      mockFetch.mockRejectedValue(new Error('network down'));
      await runCheckWith(onUpdateChanged);

      expect(onUpdateChanged).not.toHaveBeenCalled();
      expect(getUpdateStatus()?.latestVersion).toBe('0.2.0'); // prior cache intact
    });

    it('completes without throwing when no callback is wired', async () => {
      mockFetch.mockResolvedValue(makeGitHubRelease('v0.2.0', 'https://github.com/releases/v0.2.0'));
      await expect(runCheck()).resolves.toBeUndefined();
    });
  });
});
