import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so we can control package.json reads
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from 'fs';

describe('getVersion', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFileSync).mockReset();
  });

  async function loadGetVersion() {
    const mod = await import('./version.js');
    return mod.getVersion;
  }

  it('returns version string from package.json', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.2.3' }));
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('1.2.3');
  });

  it('caches version after first call (no repeated fs reads)', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.2.3' }));
    const getVersion = await loadGetVersion();
    getVersion();
    getVersion();
    getVersion();
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it('returns fallback "0.0.0" when package.json is unreadable', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    const getVersion = await loadGetVersion();
    expect(getVersion()).toBe('0.0.0');
  });
});

describe('getCommit', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '0.0.0' }));
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

  it('getVersion() return value is unchanged after adding getCommit()', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.2.3' }));
    const mod = await import('./version.js');
    expect(mod.getVersion()).toBe('1.2.3');
  });
});

describe('isNewerVersion', () => {
  // Import statically since isNewerVersion is a pure function with no side effects
  let isNewerVersion: (current: string, latest: string) => boolean;

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '0.0.0' }));
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
