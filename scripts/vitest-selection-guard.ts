/**
 * `vitest.config.ts` sets `passWithNoTests: true`, so a run whose include globs match nothing
 * exits 0. A test run's own exit code therefore cannot prove the suite was selected, and on a
 * platform CI has never covered before, "everything passed" and "nothing ran" look identical.
 * This guard reads the JSON report and reds on an empty or half-empty selection.
 */

/** The `client` project's include root; every other configured include lands outside it. */
const CLIENT_ROOT = 'src/client/';

/**
 * Files that must appear in every run, on every platform. One entry per property the job exists to
 * prove — here, the platform-neutral control pinning that `withPathWriteLock` keys on the canonical
 * path (#2301). Both project sides can be populated while the one file that discriminates the
 * defect class is absent, and this is what makes that state red rather than green. If a control is
 * deliberately renamed, move the entry with it; if it is deleted, the job's justification went with
 * it and the red is correct.
 */
const REQUIRED_FILES = ['src/server/utils/path-write-lock.test.ts'];

export interface SelectionVerdict {
  ok: boolean;
  total: number;
  pending: number;
  todo: number;
  failed: number;
  executed: number;
  files: number;
  clientFiles: number;
  nonClientFiles: number;
  violations: string[];
}

export interface GuardIo {
  readReport: (path: string) => string;
  log: (line: string) => void;
  /** Only consulted on the non-zero-exit path; an absent seam reads as an unreadable log. */
  readLog?: (path: string) => string;
  /** Appends to `$GITHUB_STEP_SUMMARY`; absent outside Actions. Never changes a verdict. */
  appendStepSummary?: (line: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** A missing or garbled count reads as 0, so a degraded report fails the guard instead of passing it. */
function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Report names are absolute, so on Windows they arrive backslash-separated. Fold before any
 * path test — see the `posix-resolve-ignores-backslash` learning.
 */
function fold(name: string): string {
  return name.split('\\').join('/');
}

/** Anchored on a separator so `not-path-write-lock.test.ts` cannot satisfy a required entry. */
function matchesRepoPath(folded: string, repoPath: string): boolean {
  return folded.endsWith(`/${repoPath}`) || folded === repoPath;
}

function isClientFile(folded: string): boolean {
  return folded.includes(`/${CLIENT_ROOT}`) || folded.startsWith(CLIENT_ROOT);
}

export function evaluateVitestSelection(report: unknown): SelectionVerdict {
  const root = asRecord(report);
  const total = readCount(root.numTotalTests);
  const pending = readCount(root.numPendingTests);
  const todo = readCount(root.numTodoTests);
  const executed = total - pending - todo;

  const names = (Array.isArray(root.testResults) ? root.testResults : [])
    .map((result) => asRecord(result).name)
    .filter((name): name is string => typeof name === 'string')
    .map(fold);
  const clientFiles = names.filter(isClientFile).length;

  const violations: string[] = [];
  if (executed <= 0) {
    violations.push(`no test executed: ${total} total - ${pending} skipped - ${todo} todo = ${executed}`);
  }
  if (clientFiles === 0) {
    violations.push(`the client project selected no file under ${CLIENT_ROOT}`);
  }
  if (names.length - clientFiles === 0) {
    violations.push(`the server project selected no file outside ${CLIENT_ROOT}`);
  }
  for (const required of REQUIRED_FILES) {
    if (!names.some((name) => matchesRepoPath(name, required))) {
      violations.push(`the run selected no ${required}`);
    }
  }

  return {
    ok: violations.length === 0,
    total,
    pending,
    todo,
    failed: readCount(root.numFailedTests),
    executed,
    files: names.length,
    clientFiles,
    nonClientFiles: names.length - clientFiles,
    violations,
  };
}

/**
 * The skip count is reported, never asserted on: it moves with hosted-runner capabilities
 * (ffmpeg, mutagen, Developer Mode) rather than with selection correctness.
 */
export function formatSelectionVerdict(verdict: SelectionVerdict): string {
  return (
    `vitest selection: ${verdict.executed} executed, ${verdict.pending} skipped, ` +
    `${verdict.todo} todo, ${verdict.failed} failed, ${verdict.files} files ` +
    `(${verdict.clientFiles} client, ${verdict.nonClientFiles} non-client)`
  );
}

/**
 * JavaScript can throw anything, and every `GuardIo` seam is ordinary caller-supplied code, so a
 * bare `.message` read would report a non-Error throw as `undefined` — losing the only diagnostic
 * a failed CI step gets.
 */
function describeThrown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `null` when the report could not be read or parsed; the path and reason are already logged. */
function parseReport(reportPath: string, io: GuardIo): { value: unknown } | null {
  try {
    return { value: JSON.parse(io.readReport(reportPath)) };
  } catch (error: unknown) {
    io.log(`could not read the vitest JSON report at ${reportPath}: ${describeThrown(error)}`);
    return null;
  }
}

function reportCollapsedSelection(reportPath: string, verdict: SelectionVerdict, io: GuardIo): void {
  io.log(`${reportPath} shows a collapsed test selection:`);
  for (const violation of verdict.violations) io.log(violation);
}

export function runVitestSelectionGuard(reportPath: string, io: GuardIo): number {
  const parsed = parseReport(reportPath, io);
  if (parsed === null) return 1;

  const verdict = evaluateVitestSelection(parsed.value);
  io.log(formatSelectionVerdict(verdict));
  if (verdict.ok) return 0;

  reportCollapsedSelection(reportPath, verdict, io);
  return 1;
}

/**
 * On the Windows runner vitest's fork pool intermittently crashes at TEARDOWN, after every test
 * file has already reported: the suite is green, then `[vitest-pool]: Worker forks emitted error`
 * lands as an unhandled error and vitest exits 1 anyway (#2445, ~1 run in 4). A red run whose only
 * defect is a shutdown crash trains people to rerun without reading, which destroys the gate.
 *
 * Observed on this repository's runs; upstream vitest-dev/vitest#9762 carries the identical
 * signature on 4.0.18 and was closed as not planned, so there is no version to upgrade to.
 */
export const TEARDOWN_CRASH_SIGNATURES = [
  '[vitest-pool]: Worker forks emitted error',
  'Worker exited unexpectedly',
];

/**
 * The states a test that actually FINISHED can hold. Vitest's `StatusMap` sends `run` and `queued`
 * to `pending` and `skip`/`todo` to `skipped`/`todo`, so a `pending` record is the one and only
 * place a mid-run worker death shows: the killed file still reports `status: 'passed'`, `success`
 * stays `true`, and every failure counter stays 0 (measured against 4.1.10). A closed allowlist,
 * so a status a future vitest introduces reds rather than slipping through.
 */
const TERMINAL_ASSERTION_STATUSES = ['passed', 'skipped', 'todo'];

export interface TeardownCrashInput {
  report: unknown;
  selection: SelectionVerdict;
  /** `null` when the captured log could not be read; the signature then cannot be confirmed. */
  log: string | null;
  logPath: string;
  exitCode: number;
}

export interface TeardownCrashVerdict {
  swallow: boolean;
  signature: string | null;
  /** The contiguous log block the signature landed in, for the annotation. */
  block: string | null;
  violations: string[];
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

function describeFile(record: Record<string, unknown>, index: number): string {
  return typeof record.name === 'string' ? fold(record.name) : `testResults[${index}]`;
}

function describeAssertion(assertion: unknown): string {
  const name = asRecord(assertion).fullName ?? asRecord(assertion).title;
  return typeof name === 'string' && name !== '' ? `'${name}'` : 'an unnamed test';
}

/** Tolerant enough to survive a CRLF capture and the reporter's leading indentation. */
function normalizeForSignature(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The crash arrives as a block (`Errors  1 error` / `Error: …` / `Caused by: …`), so the whole
 * contiguous run is carried into the annotation rather than the single matching line.
 */
function matchTeardownSignature(log: string): { signature: string; block: string } | null {
  const lines = log.split(/\r?\n/);
  for (let hit = 0; hit < lines.length; hit += 1) {
    const normalized = normalizeForSignature(lines[hit] ?? '');
    const signature = TEARDOWN_CRASH_SIGNATURES.find((candidate) =>
      normalized.includes(normalizeForSignature(candidate)),
    );
    if (signature === undefined) continue;

    let start = hit;
    while (start > 0 && (lines[start - 1] ?? '').trim() !== '') start -= 1;
    let end = hit;
    while (end < lines.length - 1 && (lines[end + 1] ?? '').trim() !== '') end += 1;
    return { signature, block: lines.slice(start, end + 1).join('\n') };
  }
  return null;
}

/**
 * Conditions 4-6: every reported file passed and carries a real assertion array, every assertion
 * reached a terminal state, and at least one test actually passed — so a report stripped of its
 * per-test records cannot satisfy the allowlist vacuously.
 */
function collectRecordViolations(root: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const results = Array.isArray(root.testResults) ? root.testResults : [];
  let passed = 0;

  results.forEach((result, index) => {
    const record = asRecord(result);
    const file = describeFile(record, index);
    if (record.status !== 'passed') {
      violations.push(`${file} reported status ${describeValue(record.status)} rather than passed`);
    }
    // An empty array is the legitimate shape of a `describe.todo`-only file; a missing or non-array
    // container is a malformed report, since vitest always builds this field with `tests.map(...)`.
    if (!Array.isArray(record.assertionResults)) {
      violations.push(
        `${file} carries no assertionResults array (${describeValue(record.assertionResults)}), ` +
          `so the report cannot prove its tests finished`,
      );
      return;
    }
    for (const assertion of record.assertionResults) {
      const status = asRecord(assertion).status;
      if (status === 'passed') passed += 1;
      if (typeof status !== 'string' || !TERMINAL_ASSERTION_STATUSES.includes(status)) {
        violations.push(
          `${file} > ${describeAssertion(assertion)} is ${describeValue(status)}, ` +
            `not one of ${TERMINAL_ASSERTION_STATUSES.join(', ')}`,
        );
      }
    }
  });

  if (passed === 0) {
    violations.push(
      'the report contains no passing test record, so its per-test records cannot prove the run completed',
    );
  }
  return violations;
}

/**
 * Decides whether a non-zero vitest exit may be re-greened. Pure: every filesystem and process
 * input arrives through the caller. Deliberately reads NO aggregate counter — the counters are
 * derived summaries that read green on a real mid-run death (`numFailedTests: 0`) and red on a
 * clean one (`numPendingTestSuites` counts `describe.todo`), so arithmetic over them fails open
 * in both directions. Every violated condition is collected, never short-circuited: a crash that
 * also emptied a project has to be diagnosable from one CI log.
 */
export function evaluateTeardownCrash(input: TeardownCrashInput): TeardownCrashVerdict {
  const violations: string[] = [];
  if (!input.selection.ok) {
    violations.push('the selection checks failed, so a non-zero exit cannot be swallowed');
  }

  const root = asRecord(input.report);
  if (root.success !== true) {
    violations.push(`the report's success field is ${describeValue(root.success)}, not true`);
  }
  violations.push(...collectRecordViolations(root));

  const match = input.log === null ? null : matchTeardownSignature(input.log);
  if (input.log === null) {
    violations.push(
      `the captured log at ${input.logPath} could not be read, ` +
        `so the teardown-crash signature cannot be confirmed`,
    );
  } else if (match === null) {
    violations.push(
      `the captured log at ${input.logPath} matches no recognized teardown-crash signature, ` +
        `so exit ${input.exitCode} is not a swallowable crash`,
    );
  }

  return {
    swallow: violations.length === 0,
    signature: match?.signature ?? null,
    block: match?.block ?? null,
    violations,
  };
}

/** GitHub truncates a workflow command at its first newline and reads `%` as an escape lead-in. */
function escapeWorkflowCommandData(data: string): string {
  return data.split('%').join('%25').split('\r').join('%0D').split('\n').join('%0A');
}

export function formatCrashAnnotation(exitCode: number, block: string): string {
  return `::warning::${escapeWorkflowCommandData(
    `vitest exited ${exitCode} but the JSON report shows every selected test finished, so this ` +
      `job was re-greened deliberately (#2445). Swallowed teardown crash:\n${block}`,
  )}`;
}

const DEFAULT_REPORT_PATH = 'vitest-windows.json';
const DEFAULT_LOG_PATH = 'vitest-windows.log';

export interface GuardInvocation {
  reportPath: string;
  logPath: string;
  exitCode: number;
  /** Set when `--exit-code` was present but unusable — an unknown exit code is never read as 0. */
  error?: string;
}

/**
 * `--exit-code=0` is a meaningful value, so it must not fall through a `Number(x) || fallback`
 * coercion, and an unparseable value is broken workflow wiring rather than a green run.
 */
export function parseGuardInvocation(argv: string[]): GuardInvocation {
  const flag = (name: string): string | undefined =>
    argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const reportPath = argv.find((arg) => !arg.startsWith('--')) ?? DEFAULT_REPORT_PATH;
  const logPath = flag('log') ?? DEFAULT_LOG_PATH;

  const raw = flag('exit-code');
  const parsed = raw === undefined ? 0 : Number(raw.trim());
  if (raw !== undefined && (raw.trim() === '' || !Number.isFinite(parsed))) {
    return {
      reportPath,
      logPath,
      exitCode: 0,
      error: `--exit-code=${raw} is not a number, so the workflow's exit-code capture is broken`,
    };
  }
  return { reportPath, logPath, exitCode: parsed };
}

function readCapturedLog(logPath: string, io: GuardIo): string | null {
  if (io.readLog === undefined) return null;
  try {
    return io.readLog(logPath);
  } catch (error: unknown) {
    io.log(`could not read the captured test log at ${logPath}: ${describeThrown(error)}`);
    return null;
  }
}

/** A step-summary write is a courtesy; its failure never changes the verdict and never throws. */
function appendStepSummary(io: GuardIo, line: string): void {
  if (io.appendStepSummary === undefined) return;
  try {
    io.appendStepSummary(line);
  } catch (error: unknown) {
    io.log(`could not append to the GitHub step summary: ${describeThrown(error)}`);
  }
}

function adjudicateNonZeroExit(invocation: GuardInvocation, io: GuardIo): number {
  const parsed = parseReport(invocation.reportPath, io);
  if (parsed === null) return 1;

  const selection = evaluateVitestSelection(parsed.value);
  io.log(formatSelectionVerdict(selection));

  const crash = evaluateTeardownCrash({
    report: parsed.value,
    selection,
    log: readCapturedLog(invocation.logPath, io),
    logPath: invocation.logPath,
    exitCode: invocation.exitCode,
  });
  if (!selection.ok) reportCollapsedSelection(invocation.reportPath, selection, io);

  if (crash.swallow) {
    io.log(formatCrashAnnotation(invocation.exitCode, crash.block ?? ''));
    appendStepSummary(
      io,
      `Windows tests re-greened: vitest exited ${invocation.exitCode} after every selected test ` +
        `finished (post-suite fork-teardown crash, #2445): ${crash.signature}`,
    );
    return 0;
  }

  io.log(`vitest exited ${invocation.exitCode} and the report does not prove the suite completed:`);
  for (const violation of crash.violations) io.log(violation);
  return 1;
}

/**
 * The job's only verdict. A zero vitest exit delegates to the selection guard unchanged; a
 * non-zero one is re-greened only when the report and the captured log together prove the failure
 * was a post-suite teardown crash.
 */
export function runVitestGuard(argv: string[], io: GuardIo): number {
  const invocation = parseGuardInvocation(argv);
  if (invocation.error !== undefined) {
    io.log(invocation.error);
    return 1;
  }
  if (invocation.exitCode === 0) return runVitestSelectionGuard(invocation.reportPath, io);
  return adjudicateNonZeroExit(invocation, io);
}
