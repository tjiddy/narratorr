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

function runEntry(
  reportPath: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [tsxCli, entry, reportPath, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
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

/** The block a failing Windows run emits after the whole suite has already reported green. */
const CRASH_LOG =
  'Errors  1 error\nError: [vitest-pool]: Worker forks emitted error.\n' +
  'Caused by: Error: Worker exited unexpectedly\n';

function passing(fullName: string): unknown {
  return { fullName, title: fullName, status: 'passed' };
}

/** Selection-valid by construction — a client file plus the required control. */
function adjudicationReport(extraFiles: unknown[] = [], overrides: object = {}): unknown {
  return {
    numTotalTests: 2,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTests: 0,
    success: true,
    ...overrides,
    testResults: [
      {
        name: '/w/narratorr/src/client/App.test.tsx',
        status: 'passed',
        assertionResults: [passing('App > renders')],
      },
      {
        name: '/w/narratorr/src/server/utils/path-write-lock.test.ts',
        status: 'passed',
        assertionResults: [passing('withPathWriteLock > canonicalizes its key')],
      },
      ...extraFiles,
    ],
  };
}

function writeLog(name: string, body: string): string {
  const logPath = path.join(dir, name);
  writeFileSync(logPath, body);
  return logPath;
}

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

  describe('teardown-crash adjudication (#2445)', () => {
    it('exits 0 and annotates when a green report is paired with a crash log', () => {
      const { status, output } = runEntry(writeReport('crash-green.json', adjudicationReport()), [
        '--exit-code=1',
        `--log=${writeLog('crash.log', CRASH_LOG)}`,
      ]);

      expect(status).toBe(0);
      expect(output).toContain('::warning::');
      expect(output).toContain('Worker exited unexpectedly');
    });

    it('appends the swallow to the step summary the runner points it at', () => {
      const summary = path.join(dir, 'summary.md');
      const { status } = runEntry(
        writeReport('crash-summary.json', adjudicationReport()),
        ['--exit-code=1', `--log=${writeLog('crash-summary.log', CRASH_LOG)}`],
        { GITHUB_STEP_SUMMARY: summary },
      );

      expect(status).toBe(0);
      expect(readFileSync(summary, 'utf-8')).toContain('Windows tests re-greened');
    });

    it('exits 1 when the report carries a failed test', () => {
      const { status, output } = runEntry(
        writeReport(
          'crash-failed.json',
          adjudicationReport([
            {
              name: '/w/narratorr/src/server/services/book.service.test.ts',
              status: 'failed',
              assertionResults: [{ fullName: 'imports a book', status: 'failed' }],
            },
          ]),
        ),
        ['--exit-code=1', `--log=${writeLog('crash-failed.log', CRASH_LOG)}`],
      );

      expect(status).toBe(1);
      expect(output).toContain('book.service.test.ts');
    });

    // The measured mid-run-kill shape: green file status, green counters, one pending assertion.
    it('exits 1 on the report shape a real mid-run worker kill produces', () => {
      const { status, output } = runEntry(
        writeReport(
          'crash-pending.json',
          adjudicationReport([
            {
              name: '/w/narratorr/src/server/services/book.service.test.ts',
              status: 'passed',
              assertionResults: [{ fullName: 'kills the worker', status: 'pending' }],
            },
          ]),
        ),
        ['--exit-code=1', `--log=${writeLog('crash-pending.log', CRASH_LOG)}`],
      );

      expect(status).toBe(1);
      expect(output).toContain('kills the worker');
    });

    it('exits 1 when the failure is not a recognized teardown crash', () => {
      const { status, output } = runEntry(
        writeReport('crash-unknown.json', adjudicationReport()),
        ['--exit-code=1', `--log=${writeLog('unknown.log', 'Error: ENOSPC: no space left\n')}`],
      );

      expect(status).toBe(1);
      expect(output).toContain('no recognized teardown-crash signature');
    });

    it('exits 1 naming the broken wiring when the captured exit code is empty', () => {
      const { status, output } = runEntry(writeReport('crash-wiring.json', adjudicationReport()), [
        '--exit-code=',
      ]);

      expect(status).toBe(1);
      expect(output).toContain('exit-code');
    });
  });
});
