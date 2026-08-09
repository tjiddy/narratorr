import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { sanitizedEnv } from '@core/utils/sanitized-env.js';

describe('tsup GIT_COMMIT build-time injection', () => {
  const bundlePath = resolve('dist/server/index.js');

  it('inlines provided GIT_COMMIT value into emitted server bundle', () => {
    const result = spawnSync('pnpm', ['build:server'], { shell: true,
      env: sanitizedEnv({ GIT_COMMIT: 'testsha1' }),
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status, `tsup build failed:\n${result.stderr}`).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);

    const bundle = readFileSync(bundlePath, 'utf-8');
    expect(bundle).toContain('"testsha1"');
  }, 60_000);

  it('inlines full 40-char GIT_COMMIT value into emitted server bundle', () => {
    const fullSha = 'abc1234def456789abc1234def456789abc12345';
    const result = spawnSync('pnpm', ['build:server'], { shell: true,
      env: sanitizedEnv({ GIT_COMMIT: fullSha }),
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status, `tsup build failed:\n${result.stderr}`).toBe(0);

    const bundle = readFileSync(bundlePath, 'utf-8');
    expect(bundle).toContain(`"${fullSha}"`);
  }, 60_000);

  it('inlines "unknown" when GIT_COMMIT env var is absent', () => {
    const result = spawnSync('pnpm', ['build:server'], { shell: true,
      env: sanitizedEnv(),
      encoding: 'utf-8',
      timeout: 60_000,
    });

    expect(result.status, `tsup build failed:\n${result.stderr}`).toBe(0);

    const bundle = readFileSync(bundlePath, 'utf-8');
    expect(bundle).toContain('"unknown"');
  }, 60_000);
});
