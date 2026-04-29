import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dockerfile = path.join(__dirname, '..', 'Dockerfile');

/**
 * Tests the Docker HEALTHCHECK command's URL_BASE variable expansion.
 *
 * The Dockerfile uses:
 *   curl -sf http://localhost:3000${URL_BASE:-}/api/health
 *
 * This verifies the shell expansion produces correct URLs for both
 * root deployments (URL_BASE unset) and subpath deployments (URL_BASE=/narratorr).
 */

function expandHealthcheckUrl(urlBase: string | undefined): string {
  const lines = [
    urlBase !== undefined ? `URL_BASE="${urlBase}"` : '',
    `echo "http://localhost:3000\${URL_BASE:-}/api/health"`,
  ];

  return execFileSync('bash', ['-s'], {
    encoding: 'utf-8',
    input: lines.join('\n'),
  }).trim();
}

describe('Docker HEALTHCHECK URL_BASE expansion', () => {
  it('Dockerfile contains HEALTHCHECK with URL_BASE variable', () => {
    const content = fs.readFileSync(dockerfile, 'utf-8');
    expect(content).toContain('HEALTHCHECK');
    expect(content).toContain('${URL_BASE:-}');
    expect(content).toContain('/api/health');
  });

  it('uses curl for health probing (LSIO base includes curl)', () => {
    const content = fs.readFileSync(dockerfile, 'utf-8');
    expect(content).toContain('curl -sf');
    expect(content).not.toContain('wget');
  });

  it('expands to root path when URL_BASE is unset', () => {
    const url = expandHealthcheckUrl(undefined);
    expect(url).toBe('http://localhost:3000/api/health');
  });

  it('expands to root path when URL_BASE is empty string', () => {
    const url = expandHealthcheckUrl('');
    expect(url).toBe('http://localhost:3000/api/health');
  });

  it('expands to subpath when URL_BASE is set', () => {
    const url = expandHealthcheckUrl('/narratorr');
    expect(url).toBe('http://localhost:3000/narratorr/api/health');
  });

  it('expands correctly for deeply nested subpath', () => {
    const url = expandHealthcheckUrl('/apps/narratorr');
    expect(url).toBe('http://localhost:3000/apps/narratorr/api/health');
  });
});
