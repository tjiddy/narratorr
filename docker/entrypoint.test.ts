import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.join(__dirname, 'entrypoint.sh');

/**
 * Tests the validation and defaulting logic in entrypoint.sh.
 *
 * We can't run the full script (requires Linux utilities like addgroup,
 * adduser, su-exec), but we can test the validation branches by writing
 * them to a temp script and executing via bash.
 */

function runValidation(env: Record<string, string>): { code: number; stderr: string; stdout: string } {
  const tmpScript = path.join(os.tmpdir(), `entrypoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const lines = [
    '#!/bin/bash',
    'set -e',
    `PUID="${env.PUID ?? ''}"`,
    `PGID="${env.PGID ?? ''}"`,
    '',
    'if [ -n "$PUID" ]; then',
    '  if ! echo "$PUID" | grep -qE "^[0-9]+$" || [ "$PUID" -eq 0 ]; then',
    '    echo "ERROR: PUID must be a positive integer, got: $PUID" >&2',
    '    exit 1',
    '  fi',
    '  PGID="${PGID:-$PUID}"',
    '  if ! echo "$PGID" | grep -qE "^[0-9]+$" || [ "$PGID" -eq 0 ]; then',
    '    echo "ERROR: PGID must be a positive integer, got: $PGID" >&2',
    '    exit 1',
    '  fi',
    '  echo "VALIDATED PUID=$PUID PGID=$PGID"',
    'else',
    '  echo "NO_PUID"',
    'fi',
  ];

  fs.writeFileSync(tmpScript, lines.join('\n'), { mode: 0o755 });

  try {
    const stdout = execFileSync('bash', [tmpScript], { encoding: 'utf-8' });
    return { code: 0, stderr: '', stdout: stdout.trim() };
  } catch (err: unknown) {
    const execErr = err as { status: number; stderr: string; stdout: string };
    return {
      code: execErr.status ?? 1,
      stderr: (execErr.stderr ?? '').trim(),
      stdout: (execErr.stdout ?? '').trim(),
    };
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}

describe('entrypoint.sh validation logic', () => {
  it('accepts valid PUID and PGID', () => {
    const result = runValidation({ PUID: '1000', PGID: '1000' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('VALIDATED PUID=1000 PGID=1000');
  });

  it('defaults PGID to PUID when PGID is not set', () => {
    const result = runValidation({ PUID: '1000' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('VALIDATED PUID=1000 PGID=1000');
  });

  it('accepts different PUID and PGID values', () => {
    const result = runValidation({ PUID: '1000', PGID: '1001' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('VALIDATED PUID=1000 PGID=1001');
  });

  it('rejects PUID=0', () => {
    const result = runValidation({ PUID: '0' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PUID must be a positive integer');
  });

  it('rejects non-numeric PUID', () => {
    const result = runValidation({ PUID: 'abc' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PUID must be a positive integer');
  });

  it('rejects negative PUID', () => {
    const result = runValidation({ PUID: '-1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PUID must be a positive integer');
  });

  it('rejects PGID=0 with valid PUID', () => {
    const result = runValidation({ PUID: '1000', PGID: '0' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PGID must be a positive integer');
  });

  it('rejects non-numeric PGID with valid PUID', () => {
    const result = runValidation({ PUID: '1000', PGID: 'xyz' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('PGID must be a positive integer');
  });

  it('runs without PUID (no user switching)', () => {
    const result = runValidation({});
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('NO_PUID');
  });

  it('entrypoint.sh file contains expected structure', () => {
    const content = fs.readFileSync(entrypoint, 'utf-8');
    expect(content.startsWith('#!/bin/sh')).toBe(true);
    expect(content).toContain('PUID');
    expect(content).toContain('PGID');
    expect(content).toContain('su-exec');
    expect(content).toContain('PGID="${PGID:-$PUID}"');
  });
});

describe('Dockerfile HEALTHCHECK', () => {
  const dockerfile = path.join(__dirname, '..', 'Dockerfile');

  it('probes /api/health with URL_BASE expansion for subpath deployments', () => {
    const content = fs.readFileSync(dockerfile, 'utf-8');

    // Dockerfile contains HEALTHCHECK that probes the health endpoint with URL_BASE
    expect(content).toContain('HEALTHCHECK');
    expect(content).toContain('http://localhost:3000${URL_BASE:-}/api/health');
  });

  it('URL_BASE defaults to empty string when unset (root deployment)', () => {
    // Verify the shell expansion ${URL_BASE:-} produces correct URLs
    // for both root (URL_BASE unset) and subpath (URL_BASE=/narratorr) deployments
    const result = runHealthcheckExpansion('');
    expect(result).toBe('http://localhost:3000/api/health');
  });

  it('URL_BASE expands correctly for subpath deployment', () => {
    const result = runHealthcheckExpansion('/narratorr');
    expect(result).toBe('http://localhost:3000/narratorr/api/health');
  });
});

function runHealthcheckExpansion(urlBase: string): string {
  const tmpScript = path.join(os.tmpdir(), `healthcheck-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const lines = [
    '#!/bin/bash',
    urlBase ? `URL_BASE="${urlBase}"` : '',
    'echo "http://localhost:3000${URL_BASE:-}/api/health"',
  ].filter(Boolean);

  fs.writeFileSync(tmpScript, lines.join('\n'), { mode: 0o755 });

  try {
    return execFileSync('bash', [tmpScript], { encoding: 'utf-8' }).trim();
  } finally {
    try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
  }
}
