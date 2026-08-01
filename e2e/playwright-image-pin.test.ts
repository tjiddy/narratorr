import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Drift sentinel: the CI e2e job runs inside the mcr.microsoft.com/playwright
 * container, whose baked-in browsers must match the installed @playwright/test
 * version — a mismatch kills every browser launch with "Executable doesn't
 * exist". That job executes only on PRs to main, so the mismatch is invisible
 * to local runs and every develop-side gate; this test turns it into a red
 * unit test at commit time instead (it broke the v0.12.0 release PR).
 */
describe('e2e container image pin', () => {
  it('ci.yml pins the playwright image at the installed @playwright/test version', () => {
    const require = createRequire(import.meta.url);
    const pkgPath = join(dirname(require.resolve('@playwright/test')), 'package.json');
    const installed = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const pinned = workflow.match(/image:\s*mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/)?.[1];

    expect(
      pinned,
      'ci.yml e2e image pin must track @playwright/test — update the image tag (or this sentinel if the job moved)',
    ).toBe(installed);
  });
});
