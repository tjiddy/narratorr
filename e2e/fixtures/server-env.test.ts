import { describe, it, expect } from 'vitest';
import { serverEnv, SEED_LIBRARY_DIR_ENV } from './server-env.js';
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
    // The key must be omitted, not set falsy, so no stray value can flip the bypass on.
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

  it('hands the seed wrapper the library dir under a key the server ignores', () => {
    // The server reads `settings.library.path`, so this key exists only for the wrapper's seed —
    // and must not contain the substring `LIBRARY_PATH`, which a config sentinel forbids.
    const env = serverEnv(run, '/', 3100);

    expect(env[SEED_LIBRARY_DIR_ENV]).toBe(run.libraryPath);
    expect(SEED_LIBRARY_DIR_ENV).not.toContain('LIBRARY_PATH');
    expect(env.LIBRARY_PATH).toBeUndefined();
  });
});
