import { describe, it, expect } from 'vitest';
import { serverEnv } from './server-env.js';
import type { RunTempDirs } from './temp-dirs.js';

const run: RunTempDirs = {
  dbPath: '/tmp/run/narratorr.db',
  libraryPath: '/tmp/run/library',
  configPath: '/tmp/run/config',
  downloadsPath: '/tmp/run/downloads',
  sourcePath: '/tmp/run/source',
};

describe('serverEnv', () => {
  it('injects AUTH_BYPASS=true by default (root/subpath servers)', () => {
    const env = serverEnv(run, '/', 3100);
    expect(env.AUTH_BYPASS).toBe('true');
  });

  it('omits AUTH_BYPASS entirely when authBypass is false (forms server)', () => {
    // The forms server (#1555) must NOT bypass auth, or the login/redirect/logout
    // assertions go vacuous. The key is omitted, not set falsy, so there is no
    // stray value that could flip the bypass on.
    const env = serverEnv(run, '/', 3102, { authBypass: false });
    expect('AUTH_BYPASS' in env).toBe(false);
    expect(env.AUTH_BYPASS).toBeUndefined();
  });

  it('wires the per-run temp dirs, port, and URL_BASE', () => {
    const env = serverEnv(run, '/narratorr', 3101);
    expect(env.PORT).toBe('3101');
    expect(env.DATABASE_URL).toBe(run.dbPath);
    expect(env.CONFIG_PATH).toBe(run.configPath);
    expect(env.URL_BASE).toBe('/narratorr');
    expect(env.E2E_DOWNLOADS_PATH).toBe(run.downloadsPath);
    expect(env.E2E_SOURCE_PATH).toBe(run.sourcePath);
  });
});
