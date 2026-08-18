import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `ci.yml` runs only for `main`, so a develop-targeted PR never makes both workflows eligible on
// one ref. Every cross-workflow property this job has to hold — trigger coverage, concurrency
// isolation, absence of a `needs:` edge — is therefore checked statically here rather than by
// watching two runs that can never co-occur (#2358 F2, F4-F6).
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');

// The repo has no `.gitattributes`, so git's autocrlf checks these out CRLF on Windows and LF
// elsewhere. Every assertion below is about workflow CONTENT, and a pattern like `bash\n\s+run:`
// cannot match across a `\r`, so normalize on read — the alternative is that this file passes on
// Linux and reds on Windows, which is the exact failure the workflow it describes exists to catch.
const read = (name: string): string =>
  fs.readFileSync(path.join(workflowsDir, name), 'utf-8').split('\r\n').join('\n');

const windows = read('windows-tests.yml');
const ci = read('ci.yml');
const docker = read('docker.yml');

function concurrencyGroup(workflow: string): string {
  return /concurrency:\s*\n\s+group:\s*(\S.*)/.exec(workflow)?.[1]?.trim() ?? '';
}

/** The branch list of one `on:` event, as authored — `[]` when the event is absent. */
function triggerBranches(workflow: string, event: 'pull_request' | 'push'): string[] {
  const list = new RegExp(`${event}:\\s*\\n\\s+branches:\\s*\\[([^\\]]*)\\]`).exec(workflow)?.[1];
  return list === undefined ? [] : list.split(',').map((branch) => branch.trim());
}

/**
 * Every distinct value a workflow gives for one setting. Parity is asserted against these rather
 * than against a literal, so a Linux-side toolchain change reds the test that claims parity —
 * a literal on the Windows side alone silently drifts (F2).
 */
function distinctValues(workflow: string, pattern: RegExp): string[] {
  return [...new Set([...workflow.matchAll(pattern)].map((match) => match[1]!.trim()))];
}

const GUARD_STEP = 'scripts/check-vitest-selection.ts vitest-windows.json';
/** Each step's own YAML text, so an assertion about one step cannot be satisfied by another. */
const step = (name: string): string => {
  const start = windows.indexOf(`- name: ${name}`);
  const next = windows.indexOf('\n      - name:', start + 1);
  return windows.slice(start, next === -1 ? undefined : next);
};
const testStep = step('Test');
const guardStep = step('Assert non-empty per-project selection');
const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf-8');

const SETUP_NODE = /uses:\s*(actions\/setup-node@\S+)/g;
const NODE_VERSION = /node-version:\s*(\S+)/g;
const SETUP_PNPM = /uses:\s*(pnpm\/action-setup@\S+)/g;
const INSTALL = /run:\s*(pnpm install[^\n]*)/g;
/** A `version:` input under pnpm/action-setup; `node-version:` deliberately does not match. */
const PINNED_PNPM_VERSION = /^\s+(version:\s*\S+)/gm;

describe('Windows test workflow (.github/workflows/windows-tests.yml)', () => {
  describe('trigger coverage', () => {
    // Pre-release smoke (2026-08-18): version tags only. A pull_request or branch-push trigger
    // reintroduces the per-PR 22min run and the merge-gate false blocks that decision removed.
    it('runs on version tags and nothing continuous', () => {
      expect(windows).toMatch(/push:\s*\n\s+tags:\s*\['v\*'\]/);
      expect(windows).not.toContain('pull_request');
      expect(triggerBranches(windows, 'push')).toEqual([]);
    });

    it('confines the tag trigger to the release pattern rather than a catch-all', () => {
      expect(windows).not.toContain('branches-ignore');
      expect(windows).not.toContain("'**'");
      expect(windows).not.toContain('[**]');
    });

    // GitHub runs workflow_dispatch only for a workflow present on the default branch, so this is
    // an operator affordance for smoking a ref without cutting a tag.
    it('declares workflow_dispatch for manual runs', () => {
      expect(windows).toContain('workflow_dispatch:');
    });
  });

  describe('failure semantics', () => {
    it('lets a red test run fail the workflow', () => {
      expect(windows).not.toContain('continue-on-error');
      expect(windows).not.toContain('always()');
    });

    it('declares no dependency edge in either direction with the Linux workflows', () => {
      expect(windows).not.toContain('needs:');
      expect(ci).not.toContain('windows');
      expect(docker).not.toContain('windows');
    });
  });

  describe('concurrency isolation', () => {
    it('claims a group distinct from the repository-scoped group ci.yml already holds', () => {
      const windowsGroup = concurrencyGroup(windows);

      expect(windowsGroup).not.toBe('');
      expect(windowsGroup).not.toBe(concurrencyGroup(ci));
    });
  });

  describe('toolchain parity with the Linux job', () => {
    it('runs the tests on a Windows runner under an explicit timeout with headroom', () => {
      expect(windows).toContain('runs-on: windows-latest');

      const cap = Number(/timeout-minutes:\s*(\d+)/.exec(windows)?.[1]);

      expect(cap).toBeGreaterThanOrEqual(30);
    });

    it('uses the same setup-node action ref as every Linux job', () => {
      expect(distinctValues(windows, SETUP_NODE)).toEqual(distinctValues(ci, SETUP_NODE));
    });

    it('pins the same Node version as every Linux job, and not below the repo floor', () => {
      expect(distinctValues(windows, NODE_VERSION)).toEqual(distinctValues(ci, NODE_VERSION));
      // Independent floor: a joint downgrade would satisfy equality alone.
      expect(distinctValues(windows, NODE_VERSION)).toEqual(['24']);
    });

    it('uses the same pnpm/action-setup ref as every Linux job', () => {
      expect(distinctValues(windows, SETUP_PNPM)).toEqual(distinctValues(ci, SETUP_PNPM));
    });

    it('leaves pnpm unpinned on both sides so packageManager resolves it', () => {
      expect(distinctValues(windows, PINNED_PNPM_VERSION)).toEqual(
        distinctValues(ci, PINNED_PNPM_VERSION),
      );
      expect(distinctValues(windows, PINNED_PNPM_VERSION)).toEqual([]);
    });

    it('installs with the same command as every Linux job', () => {
      expect(distinctValues(windows, INSTALL)).toEqual(distinctValues(ci, INSTALL));
      expect(distinctValues(windows, INSTALL)).toEqual(['pnpm install --frozen-lockfile']);
    });

    it('keeps the store-path step on bash, where the runner default is pwsh', () => {
      expect(windows).toMatch(
        /shell: bash\n\s+run: echo "store=\$\(pnpm store path\)" >> \$GITHUB_OUTPUT/,
      );
    });

    it('keeps runner.os in the cache key so Windows cannot restore the Linux store', () => {
      expect(windows).toContain("key: pnpm-${{ runner.os }}-${{ hashFiles('**/pnpm-lock.yaml') }}");
      expect(windows).toContain('restore-keys: pnpm-${{ runner.os }}-');
    });
  });

  describe('scope', () => {
    it('runs the tests and nothing else the Linux gate already covers', () => {
      expect(windows).not.toMatch(/run: pnpm lint\b/);
      expect(windows).not.toMatch(/run: pnpm typecheck\b/);
      expect(windows).not.toMatch(/run: pnpm build\b/);
      expect(windows).not.toContain('curl');
    });
  });

  describe('non-empty selection guard', () => {
    it('writes the JSON report the guard reads, keeping the default reporter for the log', () => {
      expect(windows).toContain(
        'pnpm test --reporter=default --reporter=json --outputFile.json=vitest-windows.json',
      );
    });

    it('keeps every flag the guard and the runner budget depend on', () => {
      expect(windows).toContain('--maxWorkers=2');
    });

    it('asserts on that report after the run, so the guard reads a report that exists', () => {
      expect(windows).toContain(GUARD_STEP);
      expect(windows.indexOf('--outputFile.json')).toBeLessThan(windows.indexOf(GUARD_STEP));
    });

    it('invokes a guard script that exists', () => {
      expect(fs.existsSync(path.join(repoRoot, 'scripts', 'check-vitest-selection.ts'))).toBe(true);
    });

    it('keeps the report out of the working tree', () => {
      expect(gitignore).toContain('vitest-windows.json');
    });
  });

  // The fork pool crashes at teardown after a fully green suite roughly one run in four (#2445),
  // so the test step can no longer be the thing that reds the job — the guard has to see the exit
  // code and decide.
  describe('teardown-crash capture', () => {
    it('captures vitest exit code and combined output instead of failing the step', () => {
      expect(testStep).toContain('2>&1 | tee vitest-windows.log');
      expect(testStep).toContain('exit-code=${PIPESTATUS[0]}');
      expect(testStep).toContain('>> "$GITHUB_OUTPUT"');
    });

    // GitHub's bash default is `-eo pipefail`: without `set +e` a red suite aborts the step before
    // the guard runs, and `$?` after a pipe reports tee's status, not vitest's. Both mistakes make
    // the captured code silently always zero, which turns the guard into a no-op.
    it('runs the capture under bash with errexit disabled and reads PIPESTATUS', () => {
      expect(testStep).toContain('shell: bash');
      expect(testStep).toMatch(/set \+e\n/);
      expect(testStep).toContain('PIPESTATUS[0]');
      expect(testStep).not.toMatch(/exit-code=\$\?/);
    });

    it('hands the guard the captured exit code and the captured log', () => {
      expect(guardStep).toContain('--exit-code=');
      expect(guardStep).toContain('--log=vitest-windows.log');
      expect(guardStep).toContain('vitest-windows.json');
      expect(windows.indexOf('tee vitest-windows.log')).toBeLessThan(windows.indexOf(GUARD_STEP));
    });

    // Unconditional and ungated: the guard's exit code is the job's only verdict now.
    it('leaves the guard step unconditional so its exit code is the job verdict', () => {
      expect(guardStep).not.toMatch(/^\s+if:/m);
      expect(guardStep).not.toContain('continue-on-error');
    });

    it('keeps the captured log out of the working tree', () => {
      expect(gitignore).toContain('*.log');
      expect(windows).toContain('vitest-windows.log');
    });
  });
});
