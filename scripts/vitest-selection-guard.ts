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

export function runVitestSelectionGuard(reportPath: string, io: GuardIo): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(io.readReport(reportPath));
  } catch (error) {
    io.log(`could not read the vitest JSON report at ${reportPath}: ${(error as Error).message}`);
    return 1;
  }

  const verdict = evaluateVitestSelection(parsed);
  io.log(formatSelectionVerdict(verdict));
  if (verdict.ok) return 0;

  io.log(`${reportPath} shows a collapsed test selection:`);
  for (const violation of verdict.violations) io.log(violation);
  return 1;
}
