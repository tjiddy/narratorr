import { describe, it, expect, vi } from 'vitest';
import {
  evaluateVitestSelection,
  formatSelectionVerdict,
  runVitestSelectionGuard,
} from './vitest-selection-guard.js';

type Counts = {
  numTotalTests?: unknown;
  numPendingTests?: unknown;
  numTodoTests?: unknown;
  numFailedTests?: unknown;
};

function report(names: string[], counts: Counts = {}): unknown {
  return {
    numTotalTests: names.length,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTests: 0,
    success: true,
    ...counts,
    testResults: names.map((name) => ({ name, status: 'passed', assertionResults: [] })),
  };
}

const POSIX_PAIR = [
  '/home/runner/work/narratorr/narratorr/src/client/pages/Library.test.tsx',
  '/home/runner/work/narratorr/narratorr/src/server/utils/path-write-lock.test.ts',
];

const WINDOWS_PAIR = [
  'D:\\a\\narratorr\\narratorr\\src\\client\\pages\\Library.test.tsx',
  'D:\\a\\narratorr\\narratorr\\src\\server\\utils\\path-write-lock.test.ts',
];

describe('evaluateVitestSelection', () => {
  it('accepts a run that executed tests from both projects', () => {
    const verdict = evaluateVitestSelection(report(POSIX_PAIR));

    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.executed).toBe(2);
    expect(verdict.clientFiles).toBe(1);
    expect(verdict.nonClientFiles).toBe(1);
  });

  it('classifies backslash-separated Windows report paths, including the required control', () => {
    const verdict = evaluateVitestSelection(report(WINDOWS_PAIR));

    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
    expect(verdict.clientFiles).toBe(1);
    expect(verdict.nonClientFiles).toBe(1);
  });

  it('rejects a run whose globs matched nothing', () => {
    const verdict = evaluateVitestSelection(report([]));

    expect(verdict.ok).toBe(false);
    expect(verdict.executed).toBe(0);
    expect(verdict.violations).toEqual([
      'no test executed: 0 total - 0 skipped - 0 todo = 0',
      'the client project selected no file under src/client/',
      'the server project selected no file outside src/client/',
      'the run selected no src/server/utils/path-write-lock.test.ts',
    ]);
  });

  it('rejects a run where every selected test was skipped or todo', () => {
    const verdict = evaluateVitestSelection(
      report(POSIX_PAIR, { numTotalTests: 5, numPendingTests: 4, numTodoTests: 1 }),
    );

    expect(verdict.executed).toBe(0);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual(['no test executed: 5 total - 4 skipped - 1 todo = 0']);
  });

  it('rejects a half-empty selection that matched only client files', () => {
    const verdict = evaluateVitestSelection(report([POSIX_PAIR[0] as string]));

    expect(verdict.ok).toBe(false);
    expect(verdict.clientFiles).toBe(1);
    expect(verdict.nonClientFiles).toBe(0);
    expect(verdict.violations).toEqual([
      'the server project selected no file outside src/client/',
      'the run selected no src/server/utils/path-write-lock.test.ts',
    ]);
  });

  it('rejects a half-empty selection that matched no client file', () => {
    const verdict = evaluateVitestSelection(report([POSIX_PAIR[1] as string]));

    expect(verdict.ok).toBe(false);
    expect(verdict.clientFiles).toBe(0);
    expect(verdict.violations).toEqual(['the client project selected no file under src/client/']);
  });

  it('counts the non-src includes the server project also owns', () => {
    const verdict = evaluateVitestSelection(
      report([
        '/w/narratorr/src/client/App.test.tsx',
        '/w/narratorr/docker/s6-service.test.ts',
        '/w/narratorr/eslint-rules/no-raw-error-logging.test.js',
        '/w/narratorr/src/server/utils/path-write-lock.test.ts',
      ]),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.nonClientFiles).toBe(3);
  });

  // A selection can satisfy both project sides and still have dropped the one file that proves the
  // Windows job discriminates the defect class it was built for.
  it('rejects a both-projects-populated run that dropped the required control file', () => {
    const verdict = evaluateVitestSelection(
      report([
        '/w/narratorr/src/client/App.test.tsx',
        '/w/narratorr/src/server/services/book.service.test.ts',
      ]),
    );

    expect(verdict.clientFiles).toBe(1);
    expect(verdict.nonClientFiles).toBe(1);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toEqual([
      'the run selected no src/server/utils/path-write-lock.test.ts',
    ]);
  });

  it('does not accept a suffix collision for the required control file', () => {
    const verdict = evaluateVitestSelection(
      report([
        '/w/narratorr/src/client/App.test.tsx',
        '/w/narratorr/src/server/utils/not-path-write-lock.test.ts',
      ]),
    );

    expect(verdict.violations).toContain(
      'the run selected no src/server/utils/path-write-lock.test.ts',
    );
  });

  it('treats a missing or non-numeric count as zero rather than passing', () => {
    const verdict = evaluateVitestSelection({ testResults: [{ name: '/w/src/server/a.test.ts' }] });

    expect(verdict.executed).toBe(0);
    expect(verdict.total).toBe(0);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain('no test executed: 0 total - 0 skipped - 0 todo = 0');
  });

  it('rejects a report that is not an object', () => {
    const verdict = evaluateVitestSelection(null);

    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toHaveLength(4);
  });

  it('ignores a result entry carrying no usable name', () => {
    const verdict = evaluateVitestSelection({
      numTotalTests: 2,
      testResults: [{ name: 42 }, { name: '/w/src/client/App.test.tsx' }],
    });

    expect(verdict.clientFiles).toBe(1);
    expect(verdict.nonClientFiles).toBe(0);
  });
});

describe('formatSelectionVerdict', () => {
  it('reports the skip count as a diagnostic rather than a gate', () => {
    const verdict = evaluateVitestSelection(
      report(POSIX_PAIR, { numTotalTests: 4200, numPendingTests: 37, numTodoTests: 2 }),
    );

    expect(verdict.ok).toBe(true);
    expect(formatSelectionVerdict(verdict)).toBe(
      'vitest selection: 4161 executed, 37 skipped, 2 todo, 0 failed, ' +
        '2 files (1 client, 1 non-client)',
    );
  });
});

describe('runVitestSelectionGuard', () => {
  function io(readReport: (path: string) => string) {
    const lines: string[] = [];
    return { io: { readReport, log: (line: string) => lines.push(line) }, lines };
  }

  it('exits zero and logs the summary for a well-selected run', () => {
    const readReport = vi.fn(() => JSON.stringify(report(POSIX_PAIR)));
    const { io: guardIo, lines } = io(readReport);

    expect(runVitestSelectionGuard('vitest-windows.json', guardIo)).toBe(0);
    expect(readReport).toHaveBeenCalledWith('vitest-windows.json');
    expect(lines).toEqual([
      'vitest selection: 2 executed, 0 skipped, 0 todo, 0 failed, 2 files (1 client, 1 non-client)',
    ]);
  });

  it('exits nonzero and names every violation for a collapsed selection', () => {
    const { io: guardIo, lines } = io(() => JSON.stringify(report([])));

    expect(runVitestSelectionGuard('vitest-windows.json', guardIo)).toBe(1);
    expect(lines).toContain('the client project selected no file under src/client/');
    expect(lines).toContain('the server project selected no file outside src/client/');
  });

  it('exits nonzero naming the path when the report is missing', () => {
    const { io: guardIo, lines } = io(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    expect(runVitestSelectionGuard('vitest-windows.json', guardIo)).toBe(1);
    expect(lines.join('\n')).toContain('vitest-windows.json');
    expect(lines.join('\n')).toContain('ENOENT');
  });

  it('exits nonzero when the report is not parseable JSON', () => {
    const { io: guardIo, lines } = io(() => 'not json');

    expect(runVitestSelectionGuard('vitest-windows.json', guardIo)).toBe(1);
    expect(lines.join('\n')).toContain('vitest-windows.json');
  });
});
