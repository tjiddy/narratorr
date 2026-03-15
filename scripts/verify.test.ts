import { describe, it, expect, vi } from 'vitest';
import { parseLintJson, diffLintViolations, runDiffLintGate, type LintViolation } from './lib.ts';

describe('parseLintJson', () => {
  it('normalizes ESLint JSON output to violation tuples', () => {
    const json = JSON.stringify([{
      filePath: 'C:\\Users\\test\\src\\foo.ts',
      messages: [{
        ruleId: 'no-unused-vars',
        line: 10,
        column: 5,
        message: "'x' is declared but never used",
        severity: 2,
      }],
      suppressedMessages: [],
      errorCount: 1,
      warningCount: 0,
    }]);
    const result = parseLintJson(json);
    expect(result).toEqual([{
      file: 'C:/Users/test/src/foo.ts',
      rule: 'no-unused-vars',
      line: 10,
      column: 5,
      message: "'x' is declared but never used",
    }]);
  });

  it('handles empty messages array', () => {
    const json = JSON.stringify([{
      filePath: 'src/bar.ts',
      messages: [],
      suppressedMessages: [],
      errorCount: 0,
      warningCount: 0,
    }]);
    expect(parseLintJson(json)).toEqual([]);
  });

  it('skips severity 0 (off) messages', () => {
    const json = JSON.stringify([{
      filePath: 'src/baz.ts',
      messages: [{
        ruleId: 'some-rule',
        line: 1,
        column: 1,
        message: 'disabled rule',
        severity: 0,
      }],
      suppressedMessages: [],
      errorCount: 0,
      warningCount: 0,
    }]);
    expect(parseLintJson(json)).toEqual([]);
  });

  it('handles null ruleId as "unknown"', () => {
    const json = JSON.stringify([{
      filePath: 'src/qux.ts',
      messages: [{
        ruleId: null,
        line: 1,
        column: 1,
        message: 'parse error',
        severity: 2,
      }],
      suppressedMessages: [],
      errorCount: 1,
      warningCount: 0,
    }]);
    const result = parseLintJson(json);
    expect(result[0].rule).toBe('unknown');
  });
});

describe('diffLintViolations', () => {
  const makeViolation = (overrides: Partial<LintViolation> = {}): LintViolation => ({
    file: 'src/foo.ts',
    rule: 'no-unused-vars',
    line: 10,
    column: 5,
    message: 'unused var',
    ...overrides,
  });

  it('returns empty array when no violations on either branch', () => {
    expect(diffLintViolations([], [])).toEqual([]);
  });

  it('filters out pre-existing violations in unchanged files', () => {
    const existing = makeViolation({ file: 'src/untouched.ts' });
    expect(diffLintViolations([existing], [existing])).toEqual([]);
  });

  it('filters out pre-existing violations on untouched lines in changed files', () => {
    const existing = makeViolation({ file: 'src/changed.ts', line: 50 });
    expect(diffLintViolations([existing], [existing])).toEqual([]);
  });

  it('reports new violations in changed files', () => {
    const newViolation = makeViolation({ line: 20, message: 'new issue' });
    expect(diffLintViolations([], [newViolation])).toEqual([newViolation]);
  });

  it('reports only new violations when both pre-existing and new exist', () => {
    const existing = makeViolation({ line: 10 });
    const newOne = makeViolation({ line: 20, message: 'new issue' });
    const result = diffLintViolations([existing], [existing, newOne]);
    expect(result).toEqual([newOne]);
  });

  it('reports line-shifted pre-existing violation as new (acceptable false positive)', () => {
    const onMain = makeViolation({ line: 10 });
    const shifted = makeViolation({ line: 12 }); // same violation, shifted by 2 lines
    const result = diffLintViolations([onMain], [shifted]);
    expect(result).toEqual([shifted]);
  });
});

describe('runDiffLintGate', () => {
  const eslintJson = (violations: Array<{ file: string; rule: string; line: number; col: number; msg: string }>) =>
    JSON.stringify(violations.map(v => ({
      filePath: v.file,
      messages: [{ ruleId: v.rule, line: v.line, column: v.col, message: v.msg, severity: 2 }],
      suppressedMessages: [], errorCount: 1, warningCount: 0,
    })));

  it('reports only new violations after successful branch/main lint', () => {
    const mainOutput = eslintJson([{ file: 'src/a.ts', rule: 'r1', line: 5, col: 1, msg: 'old' }]);
    const branchOutput = eslintJson([
      { file: 'src/a.ts', rule: 'r1', line: 5, col: 1, msg: 'old' }, // pre-existing
      { file: 'src/a.ts', rule: 'r2', line: 10, col: 1, msg: 'new' }, // new
    ]);

    const mockGit = vi.fn((cmd: string) => {
      if (cmd === 'merge-base') return 'abc123';
      if (cmd === 'branch') return 'feature/issue-42-test';
      return '';
    });
    let lintCall = 0;
    const mockRun = vi.fn(() => {
      lintCall++;
      return { ok: true, stdout: lintCall === 1 ? branchOutput : mainOutput, stderr: '' };
    });

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newViolations).toHaveLength(1);
      expect(result.newViolations[0].rule).toBe('r2');
      expect(result.newViolations[0].message).toBe('new');
    }
  });

  it('falls back when ESLint command fails with empty stdout', () => {
    const mockGit = vi.fn((cmd: string) => {
      if (cmd === 'merge-base') return 'abc123';
      if (cmd === 'branch') return 'feature/issue-42-test';
      return '';
    });
    const mockRun = vi.fn(() => ({
      ok: false,
      stdout: '', // no JSON output — ESLint config error
      stderr: 'Error: config not found',
    }));

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(false);
  });

  it('falls back when on main branch', () => {
    const mockGit = vi.fn((cmd: string) => {
      if (cmd === 'merge-base') return 'abc123';
      if (cmd === 'branch') return 'main';
      return '';
    });
    const mockRun = vi.fn();

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(false);
    // Should not have called ESLint at all
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('falls back when merge-base returns empty', () => {
    const mockGit = vi.fn(() => '');
    const mockRun = vi.fn();

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(false);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('falls back and restores stash when main-side ESLint fails after stashing', () => {
    const branchOutput = eslintJson([{ file: 'src/a.ts', rule: 'r1', line: 5, col: 1, msg: 'old' }]);
    const calls: string[][] = [];

    const mockGit = vi.fn((...args: string[]) => {
      calls.push(args);
      if (args[0] === 'merge-base') return 'abc123';
      if (args[0] === 'branch') return 'feature/issue-42-test';
      return '';
    });
    let lintCall = 0;
    const mockRun = vi.fn(() => {
      lintCall++;
      if (lintCall === 1) return { ok: true, stdout: branchOutput, stderr: '' };
      // Second call (main lint) fails without JSON
      return { ok: false, stdout: '', stderr: 'Error: config not found' };
    });

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(false);

    // Verify stash was popped after checkout restore
    const checkoutRestore = calls.findIndex(c => c[0] === 'checkout' && c[1] === 'feature/issue-42-test');
    const stashPop = calls.findIndex(c => c[0] === 'stash' && c[1] === 'pop');
    expect(checkoutRestore).toBeGreaterThanOrEqual(0);
    expect(stashPop).toBeGreaterThan(checkoutRestore);
  });

  it('returns empty newViolations when branch has no new lint issues', () => {
    const sameOutput = eslintJson([{ file: 'src/a.ts', rule: 'r1', line: 5, col: 1, msg: 'old' }]);

    const mockGit = vi.fn((cmd: string) => {
      if (cmd === 'merge-base') return 'abc123';
      if (cmd === 'branch') return 'feature/issue-42-test';
      return '';
    });
    const mockRun = vi.fn(() => ({ ok: true, stdout: sameOutput, stderr: '' }));

    const result = runDiffLintGate(mockGit, mockRun);
    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.newViolations).toHaveLength(0);
    }
  });
});
