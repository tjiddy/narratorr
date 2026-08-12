import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

// CI's browser image must match `@playwright/test`; this sentinel catches drift before its PR-only job runs.
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
