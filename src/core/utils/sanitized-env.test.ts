import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizedEnv } from './sanitized-env.js';

describe('sanitizedEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('passes through allowlisted keys when set', () => {
    process.env.PATH = '/usr/bin:/bin';
    process.env.HOME = '/home/user';
    process.env.LANG = 'en_US.UTF-8';
    process.env.TZ = 'UTC';

    const env = sanitizedEnv();

    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/user');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.TZ).toBe('UTC');
  });

  it('omits allowlisted keys that are undefined', () => {
    delete process.env.TMPDIR;
    delete process.env.TEMP;
    delete process.env.TMP;

    const env = sanitizedEnv();

    expect(env).not.toHaveProperty('TMPDIR');
    expect(env).not.toHaveProperty('TEMP');
    expect(env).not.toHaveProperty('TMP');
  });

  it('excludes non-allowlisted keys (including secrets)', () => {
    process.env.NARRATORR_SECRET_KEY = 'sentinel-must-not-leak';
    process.env.DATABASE_URL = 'sqlite:///tmp/secret.db';
    process.env.RANDOM_LEAKED_VAR = 'should-not-appear';

    const env = sanitizedEnv();

    expect(env).not.toHaveProperty('NARRATORR_SECRET_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
    expect(env).not.toHaveProperty('RANDOM_LEAKED_VAR');
  });

  it('merges extras on top of allowlisted keys', () => {
    process.env.PATH = '/usr/bin';

    const env = sanitizedEnv({
      NARRATORR_EVENT: 'on_grab',
      NARRATORR_BOOK_TITLE: 'Dune',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.NARRATORR_EVENT).toBe('on_grab');
    expect(env.NARRATORR_BOOK_TITLE).toBe('Dune');
  });

  it('extras override allowlisted keys when both present', () => {
    process.env.PATH = '/usr/bin';

    const env = sanitizedEnv({ PATH: '/custom/bin' });

    expect(env.PATH).toBe('/custom/bin');
  });

  it('skips extras whose value is undefined', () => {
    const env = sanitizedEnv({
      FOO: 'bar',
      BAZ: undefined as unknown as string | undefined,
    });

    expect(env.FOO).toBe('bar');
    expect(env).not.toHaveProperty('BAZ');
  });

  it('includes defined extras alongside allowlisted keys and omits undefined extras', () => {
    process.env = { PATH: '/usr/bin', HOME: '/home/user' };

    const env = sanitizedEnv({
      NARRATORR_EVENT: 'on_grab',
      NARRATORR_BOOK_AUTHOR: undefined,
      NARRATORR_BOOK_TITLE: 'Dune',
    });

    expect(Object.keys(env).sort()).toEqual([
      'HOME',
      'NARRATORR_BOOK_TITLE',
      'NARRATORR_EVENT',
      'PATH',
    ]);
  });

  it('returns only allowlisted keys when called with no extras', () => {
    // Isolate process.env so the assertion does not depend on which other
    // allowlisted keys (LANG, TZ, TMPDIR, etc.) the CI runner happens to set.
    process.env = { PATH: '/usr/bin', HOME: '/home/user', NARRATORR_SECRET_KEY: 'secret' };

    const env = sanitizedEnv();

    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
  });
});
