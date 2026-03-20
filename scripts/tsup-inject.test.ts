import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Build-level verification: confirms that tsup's esbuildOptions.define
 * inlines GIT_COMMIT into the emitted server bundle, not left as a
 * runtime process.env lookup. Catches regressions in tsup.config.ts
 * wiring that unit tests on version.ts alone cannot detect.
 */
describe('tsup GIT_COMMIT build-time injection', () => {
  const bundlePath = resolve('dist/server/index.js');

  it('inlines provided GIT_COMMIT value into emitted server bundle', () => {
    const result = spawnSync('pnpm', ['build:server'], {
      env: { ...process.env, GIT_COMMIT: 'testsha1' },
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status, `tsup build failed:\n${result.stderr}`).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);

    const bundle = readFileSync(bundlePath, 'utf-8');
    expect(bundle).toContain('"testsha1"');
  }, 60_000);

  it('inlines "unknown" when GIT_COMMIT env var is absent', () => {
    const env = { ...process.env };
    delete env.GIT_COMMIT;

    const result = spawnSync('pnpm', ['build:server'], {
      env,
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status, `tsup build failed:\n${result.stderr}`).toBe(0);

    const bundle = readFileSync(bundlePath, 'utf-8');
    expect(bundle).toContain('"unknown"');
  }, 60_000);
});
