import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The CI step's whole value is that a collapsed selection exits nonzero, so the exit code has to
// be exercised through a real process rather than asserted on the guard's return value.
const require = createRequire(import.meta.url);
const tsxPackagePath = require.resolve('tsx/package.json');
const tsxCli = path.join(
  path.dirname(tsxPackagePath),
  (JSON.parse(readFileSync(tsxPackagePath, 'utf-8')) as { bin: string }).bin,
);
const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-vitest-selection.ts');

let dir: string;

function writeReport(name: string, body: unknown): string {
  const reportPath = path.join(dir, name);
  writeFileSync(reportPath, JSON.stringify(body));
  return reportPath;
}

function runEntry(reportPath: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [tsxCli, entry, reportPath], { encoding: 'utf-8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const SELECTED = {
  numTotalTests: 2,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTests: 0,
  testResults: [
    { name: '/w/narratorr/src/client/App.test.tsx' },
    { name: '/w/narratorr/src/server/utils/path-write-lock.test.ts' },
  ],
};

describe('scripts/check-vitest-selection.ts', () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vitest-selection-'));
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows can hold handles on a just-written temp dir; a leaked tmpdir beats a red suite. */
    }
  });

  it('exits 0 and prints the counts when both projects selected files', () => {
    const { status, output } = runEntry(writeReport('good.json', SELECTED));

    expect(status).toBe(0);
    expect(output).toContain('2 executed');
    expect(output).toContain('(1 client, 1 non-client)');
  });

  it('exits 1 when the report shows a green run that executed nothing', () => {
    const { status, output } = runEntry(
      writeReport('empty.json', { numTotalTests: 0, testResults: [] }),
    );

    expect(status).toBe(1);
    expect(output).toContain('no test executed');
  });

  it('exits 1 when only one of the two projects selected files', () => {
    const { status, output } = runEntry(
      writeReport('half.json', {
        numTotalTests: 1,
        testResults: [{ name: '/w/narratorr/src/server/utils/path-write-lock.test.ts' }],
      }),
    );

    expect(status).toBe(1);
    expect(output).toContain('the client project selected no file under src/client/');
  });

  it('exits 1 when the report was never written', () => {
    const { status, output } = runEntry(path.join(dir, 'absent.json'));

    expect(status).toBe(1);
    expect(output).toContain('absent.json');
  });
});
