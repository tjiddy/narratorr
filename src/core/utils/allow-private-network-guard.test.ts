import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/**
 * Static guard for the `allowPrivateNetwork` SSRF-bypass option (#769).
 *
 * Two-direction check:
 *
 *  1. **No-other-callers**: outside the five download-client RPC adapters,
 *     no production source file passes `allowPrivateNetwork: true` to
 *     `fetchWithTimeout`. A new caller that legitimately needs the bypass
 *     should be added to the allowed-list AND have a regression test added
 *     for its private-network call site.
 *
 *  2. **No-missed-callees**: every `fetchWithTimeout(` call inside the five
 *     allowed files explicitly passes `allowPrivateNetwork: true`. A missed
 *     call site silently inherits the default (`false`) and would be refused
 *     when configured against localhost / Docker / RFC 1918.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

const ALLOWED_FILES = [
  'src/core/download-clients/qbittorrent.ts',
  'src/core/download-clients/sabnzbd.ts',
  'src/core/download-clients/nzbget.ts',
  'src/core/download-clients/transmission.ts',
  'src/core/download-clients/deluge.ts',
];

const ALLOW_PRIVATE_RE = /allowPrivateNetwork\s*:\s*true/;

async function walkTsFiles(dir: string, base = dir): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkTsFiles(full, base)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(full.slice(base.length + 1).replaceAll('\\', '/'));
    }
  }
  return results;
}

describe('allowPrivateNetwork static guard (#769)', () => {
  it('no production file outside the five download-client RPC adapters passes allowPrivateNetwork: true', async () => {
    const matches = await walkTsFiles(resolve(REPO_ROOT, 'src'), REPO_ROOT);

    const offenders: string[] = [];
    for (const file of matches) {
      if (ALLOWED_FILES.includes(file)) continue;
      const content = await readFile(resolve(REPO_ROOT, file), 'utf-8');
      if (ALLOW_PRIVATE_RE.test(content)) {
        offenders.push(file);
      }
    }

    expect(offenders, `Unexpected files passing allowPrivateNetwork: true outside the allowed download-client RPC adapters`).toEqual([]);
  });

  it.each(ALLOWED_FILES)(
    'every fetchWithTimeout call inside %s passes allowPrivateNetwork: true',
    async (file) => {
      const content = await readFile(resolve(REPO_ROOT, file), 'utf-8');

      const callRegex = /fetchWithTimeout\s*\(/g;
      const calls = Array.from(content.matchAll(callRegex));
      expect(calls.length, `${file} declares no fetchWithTimeout call — guard is asserting against an empty set`).toBeGreaterThan(0);

      for (const match of calls) {
        const start = match.index!;
        // Find the matching closing paren by tracking depth.
        let depth = 0;
        let end = -1;
        for (let i = start + match[0].length - 1; i < content.length; i++) {
          const c = content[i];
          if (c === '(') depth++;
          else if (c === ')') {
            depth--;
            if (depth === 0) {
              end = i;
              break;
            }
          }
        }
        expect(end, `Unbalanced parens at fetchWithTimeout call in ${file}`).toBeGreaterThan(start);
        const callText = content.slice(start, end + 1);
        expect(
          ALLOW_PRIVATE_RE.test(callText),
          `fetchWithTimeout call in ${file} (offset ${start}) is missing allowPrivateNetwork: true:\n${callText}`,
        ).toBe(true);
      }
    },
  );
});
