import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('getVersion', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadGetVersion() {
    const mod = await import('./version.js');
    return mod.getVersion;
  }

  it('returns git tag when GIT_TAG is set', async () => {
    process.env.GIT_TAG = 'v394-driveby-02';
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('v394-driveby-02');
    delete process.env.GIT_TAG;
  });

  it('returns "dev" when GIT_TAG is not set', async () => {
    delete process.env.GIT_TAG;
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('dev');
  });

  it('returns "dev" when GIT_TAG is "unknown"', async () => {
    process.env.GIT_TAG = 'unknown';
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('dev');
    delete process.env.GIT_TAG;
  });

  it('returns "dev" when GIT_TAG is empty string', async () => {
    process.env.GIT_TAG = '';
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('dev');
    delete process.env.GIT_TAG;
  });
});

describe('getVersion / getUserAgent shared resolver agreement', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadBoth() {
    const versionMod = await import('./version.js');
    const uaMod = await import('../../shared/user-agent.js');
    return { getVersion: versionMod.getVersion, getUserAgent: uaMod.getUserAgent };
  }

  it('agree for a normal semver tag', async () => {
    process.env.GIT_TAG = 'v9.9.9';
    const { getVersion, getUserAgent } = await loadBoth();
    expect(getVersion()).toBe('v9.9.9');
    expect(getUserAgent()).toBe('Narratorr/v9.9.9');
    delete process.env.GIT_TAG;
  });

  it('agree for an unsafe tag — both consume the sanitized resolver', async () => {
    process.env.GIT_TAG = 'v1.0\r\n';
    const { getVersion, getUserAgent } = await loadBoth();
    expect(getVersion()).toBe('v1.0');
    expect(getUserAgent()).toBe('Narratorr/v1.0');
    delete process.env.GIT_TAG;
  });

  it('memoizes getVersion across repeated calls', async () => {
    process.env.GIT_TAG = 'v9.9.9';
    const { getVersion } = await loadBoth();
    expect(getVersion()).toBe('v9.9.9');
    // Mutating the env after first resolution must not change the cached value.
    process.env.GIT_TAG = 'v0.0.0';
    expect(getVersion()).toBe('v9.9.9');
    delete process.env.GIT_TAG;
  });
});

describe('getCommit', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadGetCommit() {
    const mod = await import('./version.js');
    return mod.getCommit;
  }

  it('returns the build-injected SHA when GIT_COMMIT env var is set', async () => {
    process.env.GIT_COMMIT = 'abc1234';
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('abc1234');
    delete process.env.GIT_COMMIT;
  });

  it('returns "unknown" when GIT_COMMIT env var is not set', async () => {
    delete process.env.GIT_COMMIT;
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('unknown');
  });

  it('truncates 40-char SHA to 7-character prefix', async () => {
    process.env.GIT_COMMIT = 'abc1234def456789abc1234def456789abc12345';
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('abc1234');
    delete process.env.GIT_COMMIT;
  });

  it('returns already-short 7-char SHA as-is (no double-truncation)', async () => {
    process.env.GIT_COMMIT = 'abc1234';
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('abc1234');
    delete process.env.GIT_COMMIT;
  });

  it('returns SHA shorter than 7 chars unchanged', async () => {
    process.env.GIT_COMMIT = 'abc12';
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('abc12');
    delete process.env.GIT_COMMIT;
  });

  it('returns "unknown" when GIT_COMMIT is empty string', async () => {
    process.env.GIT_COMMIT = '';
    const getCommit = await loadGetCommit();
    expect(getCommit()).toBe('unknown');
    delete process.env.GIT_COMMIT;
  });

});

describe('getBuildTime', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadGetBuildTime() {
    const mod = await import('./version.js');
    return mod.getBuildTime;
  }

  it('returns the build-injected timestamp when BUILD_TIME env var is set', async () => {
    process.env.BUILD_TIME = '2026-03-29T11:29:40Z';
    const getBuildTime = await loadGetBuildTime();
    expect(getBuildTime()).toBe('2026-03-29T11:29:40Z');
    delete process.env.BUILD_TIME;
  });

  it('returns "unknown" when BUILD_TIME env var is not set', async () => {
    delete process.env.BUILD_TIME;
    const getBuildTime = await loadGetBuildTime();
    expect(getBuildTime()).toBe('unknown');
  });

  it('returns "unknown" when BUILD_TIME is empty string', async () => {
    process.env.BUILD_TIME = '';
    const getBuildTime = await loadGetBuildTime();
    expect(getBuildTime()).toBe('unknown');
    delete process.env.BUILD_TIME;
  });
});

describe('isNewerVersion', () => {
  // Import statically since isNewerVersion is a pure function with no side effects
  let isNewerVersion: (current: string, latest: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./version.js');
    isNewerVersion = mod.isNewerVersion;
  });

  it('0.1.0 vs 0.2.0 → true (minor bump)', () => {
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
  });

  it('0.1.0 vs 0.1.1 → true (patch bump)', () => {
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
  });

  it('0.1.0 vs 1.0.0 → true (major bump)', () => {
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
  });

  it('1.2.3 vs 1.2.3 → false (same version)', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('1.2.4 vs 1.2.3 → false (current is newer)', () => {
    expect(isNewerVersion('1.2.4', '1.2.3')).toBe(false);
  });

  it('handles "v" prefix on tags (v1.2.3 → 1.2.3)', () => {
    expect(isNewerVersion('1.2.3', 'v1.2.4')).toBe(true);
    expect(isNewerVersion('v1.2.3', '1.2.4')).toBe(true);
  });

  it('returns false for invalid version string', () => {
    expect(isNewerVersion('1.2.3', 'not-a-version')).toBe(false);
    expect(isNewerVersion('invalid', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3', '')).toBe(false);
  });
});
