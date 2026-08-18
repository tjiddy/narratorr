import { describe, it, expect, vi } from 'vitest';
import {
  evaluateTeardownCrash,
  evaluateVitestSelection,
  formatCrashAnnotation,
  formatSelectionVerdict,
  parseGuardInvocation,
  runVitestGuard,
  runVitestSelectionGuard,
  TEARDOWN_CRASH_SIGNATURES,
  type GuardIo,
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

// --- teardown-crash adjudication (#2445) ------------------------------------------------------

const CLIENT_FILE = 'D:\\a\\narratorr\\narratorr\\src\\client\\pages\\Library.test.tsx';
const CONTROL_FILE = 'D:\\a\\narratorr\\narratorr\\src\\server\\utils\\path-write-lock.test.ts';
const OTHER_FILE = 'D:\\a\\narratorr\\narratorr\\src\\server\\services\\book.service.test.ts';
const LOG_PATH = 'vitest-windows.log';

function assertionRecord(fullName: string, status: unknown = 'passed'): unknown {
  return { fullName, title: fullName, status, duration: 1, failureMessages: [] };
}

function fileRecord(name: string, assertionResults: unknown = [], status: unknown = 'passed'): unknown {
  return { name, status, assertionResults, startTime: 0, endTime: 1, message: '' };
}

/**
 * Every adjudication fixture has to clear the selection verdict first — a client file, a
 * non-client file, and the `REQUIRED_FILES` control — or it reds on condition 2 and whatever it
 * was written to pin passes for the wrong reason.
 */
const SELECTION_BASELINE = [
  fileRecord(CLIENT_FILE, [assertionRecord('Library > renders the shelf')]),
  fileRecord(CONTROL_FILE, [assertionRecord('withPathWriteLock > keys on the canonical path')]),
];

/**
 * The selection tests' `report()` helper gives every file `assertionResults: []`, which reds on
 * condition 6 — the adjudication cases need their own builder.
 */
function crashReport(
  files: unknown[] = SELECTION_BASELINE,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    numTotalTests: 2,
    numPassedTests: 2,
    numPendingTests: 0,
    numTodoTests: 0,
    numFailedTests: 0,
    numTotalTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    success: true,
    ...overrides,
    testResults: files,
  };
}

/** The block captured verbatim from a failing Windows run (#2445). */
const CRASH_LOG = [
  ' Test Files  857 passed (857)',
  '      Tests  26437 passed (26437)',
  '',
  'Errors  1 error',
  'Error: [vitest-pool]: Worker forks emitted error.',
  'Caused by: Error: Worker exited unexpectedly',
  '',
  'JSON report written to vitest-windows.json',
].join('\n');

const CRLF_CRASH_LOG = CRASH_LOG.split('\n').join('\r\n');
const NO_SIGNATURE_LOG = 'Error: ENOSPC: no space left on device, write\n';

function adjudicate(report: unknown, log: string | null = CRASH_LOG, exitCode = 1) {
  return evaluateTeardownCrash({
    report,
    selection: evaluateVitestSelection(report),
    log,
    logPath: LOG_PATH,
    exitCode,
  });
}

describe('evaluateTeardownCrash', () => {
  it('swallows a non-zero exit whose per-test records prove the suite finished', () => {
    const verdict = adjudicate(crashReport());

    expect(verdict.violations).toEqual([]);
    expect(verdict.swallow).toBe(true);
    expect(verdict.signature).toBe('[vitest-pool]: Worker forks emitted error');
  });

  it('captures the whole contiguous crash block, not just the matching line', () => {
    const verdict = adjudicate(crashReport());

    expect(verdict.block).toBe(
      'Errors  1 error\n' +
        'Error: [vitest-pool]: Worker forks emitted error.\n' +
        'Caused by: Error: Worker exited unexpectedly',
    );
  });

  // The measured mid-run kill: every selected file is present, the killed file still reports
  // `status: 'passed'`, `success` stays true and every failure counter stays 0. The single
  // `pending` assertion is the only evidence the run did not finish, which is the whole reason
  // adjudication reads per-test records instead of the counters.
  it('reds the reproduction shape a real mid-run worker kill produces', () => {
    const report = crashReport(
      [...SELECTION_BASELINE, fileRecord(OTHER_FILE, [assertionRecord('kills the worker', 'pending')])],
      { numTotalTests: 3, numFailedTests: 0, numFailedTestSuites: 0, success: true },
    );

    const verdict = adjudicate(report);

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toHaveLength(1);
    expect(verdict.violations[0]).toContain('kills the worker');
    expect(verdict.violations[0]).toContain('book.service.test.ts');
    expect(verdict.violations[0]).toContain("'pending'");
  });

  it('reds a report whose success field is false and says so', () => {
    const verdict = adjudicate(crashReport(SELECTION_BASELINE, { success: false }));

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual(["the report's success field is false, not true"]);
  });

  it.each([
    { label: 'the string "true"', success: 'true' as unknown },
    { label: 'the number 1', success: 1 as unknown },
  ])('reds a truthy non-boolean success field ($label)', ({ success }) => {
    const verdict = adjudicate(crashReport(SELECTION_BASELINE, { success }));

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations.join('\n')).toContain("success field is");
  });

  it('reds a report with no success field at all, rather than reading absence as green', () => {
    const verdict = adjudicate({
      numTotalTests: 2,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: SELECTION_BASELINE,
    });

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual(["the report's success field is undefined, not true"]);
  });

  it('reds a file whose own status is failed', () => {
    const verdict = adjudicate(
      crashReport([
        ...SELECTION_BASELINE,
        fileRecord(OTHER_FILE, [assertionRecord('a passing case')], 'failed'),
      ]),
    );

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual([
      "D:/a/narratorr/narratorr/src/server/services/book.service.test.ts reported status 'failed' rather than passed",
    ]);
  });

  describe('assertion-status allowlist (condition 5)', () => {
    const cases: Array<{ label: string; record: unknown; tolerated: boolean }> = [
      { label: "'passed'", record: assertionRecord('a case', 'passed'), tolerated: true },
      { label: "'skipped'", record: assertionRecord('a case', 'skipped'), tolerated: true },
      { label: "'todo'", record: assertionRecord('a case', 'todo'), tolerated: true },
      { label: "'failed'", record: assertionRecord('a case', 'failed'), tolerated: false },
      { label: "'pending'", record: assertionRecord('a case', 'pending'), tolerated: false },
      { label: 'absent', record: { fullName: 'a case' }, tolerated: false },
      { label: 'null', record: assertionRecord('a case', null), tolerated: false },
      { label: 'the number 0', record: assertionRecord('a case', 0), tolerated: false },
      { label: 'an object', record: assertionRecord('a case', {}), tolerated: false },
      { label: "the unknown string 'weird'", record: assertionRecord('a case', 'weird'), tolerated: false },
      { label: 'the empty string', record: assertionRecord('a case', ''), tolerated: false },
    ];

    // A closed allowlist, so a status a future vitest introduces reds rather than slipping past.
    it.each(cases)('$label is $tolerated', ({ record, tolerated }) => {
      const verdict = adjudicate(
        crashReport([...SELECTION_BASELINE, fileRecord(OTHER_FILE, [record])]),
      );

      expect(verdict.swallow).toBe(tolerated);
      if (!tolerated) {
        expect(verdict.violations.join('\n')).toContain('a case');
      }
    });
  });

  describe('assertionResults container shape (condition 4)', () => {
    // The sibling files carry passing assertions in every case, so condition 6 cannot mask a
    // missing container by being satisfied elsewhere.
    const cases: Array<{ label: string; container: unknown }> = [
      { label: 'absent', container: undefined },
      { label: 'null', container: null },
      { label: 'an object', container: { 0: assertionRecord('a case') } },
      { label: 'a string', container: 'passed' },
    ];

    it.each(cases)('reds a passed file whose assertionResults is $label', ({ container }) => {
      const malformed: Record<string, unknown> = { name: OTHER_FILE, status: 'passed' };
      if (container !== undefined) malformed.assertionResults = container;

      const verdict = adjudicate(crashReport([...SELECTION_BASELINE, malformed]));

      expect(verdict.swallow).toBe(false);
      expect(verdict.violations.join('\n')).toContain('book.service.test.ts');
      expect(verdict.violations.join('\n')).toContain('assertionResults');
    });
  });

  // Measurement 2: a `describe.todo`-only file reports an EMPTY assertionResults array on a
  // perfectly clean run. Rejecting `[]` would false-red it; this case is what stops a future
  // contributor reintroducing that check.
  it('swallows a run containing a describe.todo-only file with an empty assertionResults array', () => {
    const verdict = adjudicate(
      crashReport([...SELECTION_BASELINE, fileRecord(OTHER_FILE, [])], {
        numPendingTestSuites: 2,
      }),
    );

    expect(verdict.violations).toEqual([]);
    expect(verdict.swallow).toBe(true);
  });

  it('swallows a run whose deliberate skip and todo assertions are the only non-passing ones', () => {
    const verdict = adjudicate(
      crashReport([
        ...SELECTION_BASELINE,
        fileRecord(OTHER_FILE, [
          assertionRecord('needs ffmpeg', 'skipped'),
          assertionRecord('not written yet', 'todo'),
        ]),
      ]),
    );

    expect(verdict.swallow).toBe(true);
  });

  it('reds a report stripped of every per-test record, so condition 5 cannot pass vacuously', () => {
    const verdict = adjudicate(
      crashReport([fileRecord(CLIENT_FILE, []), fileRecord(CONTROL_FILE, [])]),
    );

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual([
      'the report contains no passing test record, so its per-test records cannot prove the run completed',
    ]);
  });

  // Deliberate acceptance, not an oversight: the counters are derived summaries and are never
  // read as adjudication predicates (AC7a). Reintroducing counter arithmetic reds this test.
  it('swallows a report that omits every failure and pending counter', () => {
    const verdict = adjudicate({
      numTotalTests: 2,
      numPassedTests: 2,
      success: true,
      testResults: SELECTION_BASELINE,
    });

    expect(verdict.swallow).toBe(true);
  });

  // Same deliberate acceptance from the other side: incoherent counters cannot change a verdict
  // the per-test records already settled.
  it('swallows a report whose counters are mutually incoherent', () => {
    const verdict = adjudicate(
      crashReport(SELECTION_BASELINE, {
        numTotalTests: 2,
        numPassedTests: 3,
        numPendingTests: -1,
      }),
    );

    expect(verdict.swallow).toBe(true);
  });

  // `numTotalTestSuites` counts describe blocks, not files; reading it as a file count reds a
  // healthy run.
  it('swallows a report whose describe count is unrelated to its file count', () => {
    const verdict = adjudicate(crashReport(SELECTION_BASELINE, { numTotalTestSuites: 40 }));

    expect(verdict.swallow).toBe(true);
  });

  it('reds when the captured log could not be read', () => {
    const verdict = adjudicate(crashReport(), null);

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual([
      `the captured log at ${LOG_PATH} could not be read, so the teardown-crash signature cannot be confirmed`,
    ]);
  });

  // The safety property of AC9: a genuine crash that merely looks green is never swallowed.
  it('reds a fully green report whose log matches no known teardown signature', () => {
    const verdict = adjudicate(crashReport(), NO_SIGNATURE_LOG);

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual([
      `the captured log at ${LOG_PATH} matches no recognized teardown-crash signature, so exit 1 is not a swallowable crash`,
    ]);
  });

  it('matches a signature across CRLF line endings, as captured on a Windows runner', () => {
    expect(adjudicate(crashReport(), CRLF_CRASH_LOG).swallow).toBe(true);
  });

  it('matches on either signature alone', () => {
    const verdict = adjudicate(
      crashReport(),
      'Error: Worker exited unexpectedly\n    at ChildProcess.<anonymous>\n',
    );

    expect(verdict.swallow).toBe(true);
    expect(verdict.signature).toBe('Worker exited unexpectedly');
  });

  it('documents both observed signatures as a named constant', () => {
    expect(TEARDOWN_CRASH_SIGNATURES).toContain('[vitest-pool]: Worker forks emitted error');
    expect(TEARDOWN_CRASH_SIGNATURES).toContain('Worker exited unexpectedly');
  });

  it('reds a collapsed selection alongside the adjudication verdict', () => {
    const verdict = adjudicate(crashReport([SELECTION_BASELINE[1]]));

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toContain(
      'the selection checks failed, so a non-zero exit cannot be swallowed',
    );
  });

  // Accumulation, not short-circuiting: every violated condition has to be named in one pass or
  // a real failure needs several CI runs to diagnose. An early `return` reds this test.
  it('names every simultaneously violated condition rather than the first', () => {
    const report = crashReport(
      [
        fileRecord(CLIENT_FILE, [assertionRecord('a failing case', 'failed')], 'failed'),
        { name: CONTROL_FILE, status: 'passed', assertionResults: null },
        fileRecord(OTHER_FILE, [assertionRecord('an unfinished case', 'pending')]),
      ],
      { success: false, numTotalTests: 3, numFailedTests: 1, numFailedTestSuites: 1 },
    );

    const verdict = adjudicate(report, NO_SIGNATURE_LOG);

    expect(verdict.swallow).toBe(false);
    expect(verdict.violations).toEqual([
      "the report's success field is false, not true",
      "D:/a/narratorr/narratorr/src/client/pages/Library.test.tsx reported status 'failed' rather than passed",
      "D:/a/narratorr/narratorr/src/client/pages/Library.test.tsx > 'a failing case' is 'failed', not one of passed, skipped, todo",
      'D:/a/narratorr/narratorr/src/server/utils/path-write-lock.test.ts carries no assertionResults array (null), so the report cannot prove its tests finished',
      "D:/a/narratorr/narratorr/src/server/services/book.service.test.ts > 'an unfinished case' is 'pending', not one of passed, skipped, todo",
      'the report contains no passing test record, so its per-test records cannot prove the run completed',
      `the captured log at ${LOG_PATH} matches no recognized teardown-crash signature, so exit 1 is not a swallowable crash`,
    ]);
  });
});

describe('formatCrashAnnotation', () => {
  it('escapes the workflow-command metacharacters so a multi-line block survives whole', () => {
    const annotation = formatCrashAnnotation(1, 'Errors  1 error\r\nAt 100% complete\nWorker died');

    expect(annotation.startsWith('::warning::')).toBe(true);
    expect(annotation).toContain('%25');
    expect(annotation).toContain('%0A');
    expect(annotation).toContain('%0D');
    expect(annotation).not.toContain('\n');
    expect(annotation).not.toContain('\r');
    expect(annotation).toContain('exited 1');
  });
});

describe('parseGuardInvocation', () => {
  it('reads a bare report path as a zero exit code, so a local run behaves as before', () => {
    expect(parseGuardInvocation(['vitest-windows.json'])).toEqual({
      reportPath: 'vitest-windows.json',
      logPath: 'vitest-windows.log',
      exitCode: 0,
    });
  });

  it('defaults both paths when invoked with no arguments at all', () => {
    expect(parseGuardInvocation([])).toEqual({
      reportPath: 'vitest-windows.json',
      logPath: 'vitest-windows.log',
      exitCode: 0,
    });
  });

  // `Number(x) || fallback` would swallow this one; a captured 0 is a real, meaningful value.
  it('honors an explicit zero rather than coercing it to a fallback', () => {
    const invocation = parseGuardInvocation(['report.json', '--exit-code=0', '--log=run.log']);

    expect(invocation).toEqual({ reportPath: 'report.json', logPath: 'run.log', exitCode: 0 });
  });

  it('reads flags in any order relative to the positional report path', () => {
    const invocation = parseGuardInvocation(['--exit-code=1', '--log=run.log', 'report.json']);

    expect(invocation).toEqual({ reportPath: 'report.json', logPath: 'run.log', exitCode: 1 });
  });

  it.each([
    { label: 'empty', argv: '--exit-code=' },
    { label: 'whitespace', argv: '--exit-code=   ' },
    { label: 'non-numeric', argv: '--exit-code=abc' },
  ])('reports broken wiring for an $label exit-code value', ({ argv }) => {
    const invocation = parseGuardInvocation(['report.json', argv]);

    expect(invocation.error).toContain('exit-code');
    expect(invocation.exitCode).toBe(0);
  });

  // Documented choice: any parseable non-zero number, negative or fractional, takes the
  // adjudication path — the guard's job is to prove the run finished, not to vet the code.
  it.each([
    { argv: '--exit-code=-1', expected: -1 },
    { argv: '--exit-code=1.5', expected: 1.5 },
  ])('treats $argv as a non-zero exit', ({ argv, expected }) => {
    const invocation = parseGuardInvocation(['report.json', argv]);

    expect(invocation.error).toBeUndefined();
    expect(invocation.exitCode).toBe(expected);
  });
});

describe('runVitestGuard', () => {
  function harness(overrides: Partial<GuardIo> = {}) {
    const lines: string[] = [];
    const summaries: string[] = [];
    const appendStepSummary = vi.fn((line: string) => {
      summaries.push(line);
    });
    const io: GuardIo = {
      readReport: () => JSON.stringify(crashReport()),
      readLog: () => CRASH_LOG,
      log: (line: string) => lines.push(line),
      appendStepSummary,
      ...overrides,
    };
    return { io, lines, summaries, appendStepSummary };
  }

  it('is byte-identical to the selection guard when vitest exited zero', () => {
    const { io, lines, appendStepSummary } = harness();

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=0'], io)).toBe(0);
    expect(lines).toEqual([
      'vitest selection: 2 executed, 0 skipped, 0 todo, 0 failed, 2 files (1 client, 1 non-client)',
    ]);
    expect(appendStepSummary).not.toHaveBeenCalled();
  });

  it('emits no annotation and writes no step summary on the zero-exit path', () => {
    const { io, lines, appendStepSummary } = harness();

    runVitestGuard(['vitest-windows.json'], io);

    expect(lines.join('\n')).not.toContain('::warning');
    expect(appendStepSummary).not.toHaveBeenCalled();
  });

  it('re-greens a teardown crash, annotating the swallowed exit code and matched text', () => {
    const { io, lines, summaries } = harness();

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1', '--log=run.log'], io)).toBe(0);
    const annotation = lines.find((line) => line.startsWith('::warning::'));

    expect(annotation).toBeDefined();
    expect(annotation).toContain('exited 1');
    expect(annotation).toContain('Worker exited unexpectedly');
    expect(lines).toContain(
      'vitest selection: 2 executed, 0 skipped, 0 todo, 0 failed, 2 files (1 client, 1 non-client)',
    );
    expect(summaries).toEqual([
      'Windows tests re-greened: vitest exited 1 after every selected test finished ' +
        '(post-suite fork-teardown crash, #2445): [vitest-pool]: Worker forks emitted error',
    ]);
  });

  it('reads the log from the path it was given', () => {
    const readLog = vi.fn(() => CRASH_LOG);
    const { io } = harness({ readLog });

    runVitestGuard(['vitest-windows.json', '--exit-code=1', '--log=run.log'], io);

    expect(readLog).toHaveBeenCalledWith('run.log');
  });

  it('still swallows when the step-summary append throws', () => {
    const { io, lines } = harness({
      appendStepSummary: () => {
        throw new Error('EACCES: permission denied');
      },
    });

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1'], io)).toBe(0);
    expect(lines.join('\n')).toContain('could not append to the GitHub step summary');
    expect(lines.join('\n')).toContain('EACCES');
  });

  it('still swallows when no step-summary seam is wired at all', () => {
    const lines: string[] = [];
    const io: GuardIo = {
      readReport: () => JSON.stringify(crashReport()),
      readLog: () => CRASH_LOG,
      log: (line: string) => lines.push(line),
    };

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1'], io)).toBe(0);
  });

  it('reds and names the path when the captured log is missing', () => {
    const { io, lines } = harness({
      readLog: () => {
        throw new Error('ENOENT: no such file or directory');
      },
    });

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1', '--log=run.log'], io)).toBe(1);
    expect(lines.join('\n')).toContain('run.log');
    expect(lines.join('\n')).toContain('ENOENT');
  });

  // One log has to be enough to diagnose a crash that also emptied a project (AC12).
  it('reports the selection violations and the adjudication failure together', () => {
    const { io, lines } = harness({
      readReport: () => JSON.stringify(crashReport([SELECTION_BASELINE[1]])),
    });

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1'], io)).toBe(1);
    expect(lines).toContain('the client project selected no file under src/client/');
    expect(lines).toContain('the selection checks failed, so a non-zero exit cannot be swallowed');
  });

  it('never swallows a crash whose run dropped the required control file', () => {
    const { io, lines } = harness({
      readReport: () =>
        JSON.stringify(
          crashReport([SELECTION_BASELINE[0], fileRecord(OTHER_FILE, [assertionRecord('a case')])]),
        ),
    });

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1'], io)).toBe(1);
    expect(lines).toContain('the run selected no src/server/utils/path-write-lock.test.ts');
  });

  it('reds naming the broken wiring when the exit code is unparseable', () => {
    const { io, lines } = harness();

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=abc'], io)).toBe(1);
    expect(lines.join('\n')).toContain('--exit-code=abc');
  });

  it('reds naming the report path when the report is unparseable on the non-zero path', () => {
    const { io, lines } = harness({ readReport: () => 'not json' });

    expect(runVitestGuard(['vitest-windows.json', '--exit-code=1'], io)).toBe(1);
    expect(lines.join('\n')).toContain('vitest-windows.json');
  });
});
