// Shared helpers for workflow scripts
// Usage: import { gitea, git, run, ... } from "./lib.ts"

import { execFileSync, execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GITEA_CLI = resolve(__dirname, "gitea.ts");

const EXEC_OPTS = { encoding: "utf-8" as const, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };

// Run a gitea CLI command, return stdout. Throws on failure.
// Retries up to 3 times on ECONNREFUSED (Gitea connectivity is intermittent).
export function gitea(...args: string[]): string {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync("node", [GITEA_CLI, ...args], EXEC_OPTS).trim();
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      const msg = (err.stderr || err.message || "").toString();
      if (msg.includes("ECONNREFUSED") && attempt < 3) continue;
      throw e;
    }
  }
  throw new Error("unreachable");
}

// Run a git command, return stdout. Throws on failure.
export function git(...args: string[]): string {
  return execFileSync("git", args, EXEC_OPTS).trim();
}

// Run a shell command, return structured result (never throws).
export function run(cmd: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execSync(cmd, EXEC_OPTS);
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || "").toString().trim(),
    };
  }
}

// Run a gitea command, return structured result (never throws).
export function giteaSafe(...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: gitea(...args) };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: (err.stderr || err.stdout || err.message || "").toString().trim() };
  }
}

// Write content to temp file, call fn with path, clean up.
export function withTempFile<T>(content: string, fn: (path: string) => T): T {
  const path = join(tmpdir(), `narratorr-${process.pid}-${Date.now()}.md`);
  writeFileSync(path, content);
  try {
    return fn(path);
  } finally {
    try { unlinkSync(path); } catch { /* ignore cleanup errors */ }
  }
}

// Parse label names from gitea issue/PR output.
export function parseLabels(output: string): string[] {
  const match = output.match(/labels:\s*(.+?)(?:\s*\||\s*$)/im);
  if (!match) return [];
  return match[1].split(",").map(l => l.trim()).filter(Boolean);
}

// Replace all labels with a given prefix, add newLabel.
export function replaceLabel(labels: string[], prefix: string, newLabel: string): string[] {
  return [...labels.filter(l => !l.startsWith(prefix)), newLabel];
}

// Remove all labels with a given prefix.
export function removeLabel(labels: string[], prefix: string): string[] {
  return labels.filter(l => !l.startsWith(prefix));
}

// Parse linked issue ID from PR body (Refs #123, closes #123, fixes #123, resolves #123).
// Prefers closing keywords over Refs.
export function parseLinkedIssue(output: string): string | null {
  const closing = output.match(/(?:closes|fixes|resolves)\s+#(\d+)/i);
  if (closing) return closing[1];
  const refs = output.match(/Refs\s+#(\d+)/i);
  return refs ? refs[1] : null;
}

// Parse all linked issue IDs from PR body (closes #N, fixes #N, resolves #N, refs #N).
export function parseClosingIssues(output: string): string[] {
  const matches = output.matchAll(/(?:closes|fixes|resolves|refs)\s+#(\d+)/gi);
  return [...matches].map(m => m[1]);
}

// Parse PR/issue author from gitea output.
export function parseAuthor(output: string): string | null {
  const match = output.match(/author:\s*(\S+)/i);
  return match ? match[1] : null;
}

// Parse SHA from gitea PR output.
export function parseSha(output: string): string | null {
  const match = output.match(/sha:\s*(\S+)/i);
  return match ? match[1] : null;
}

// Parse state from gitea output.
export function parseState(output: string): string | null {
  const match = output.match(/^#\d+\s+\[(\w+)]/m);
  return match ? match[1] : null;
}

// Parse head branch from gitea PR output.
export function parseHeadBranch(output: string): string | null {
  const match = output.match(/^(\S+)\s*→/m);
  return match ? match[1] : null;
}

// Slugify a title for branch names.
export function slugify(title: string, maxLen = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLen)
    .replace(/-$/, "");
}

// Find an existing branch matching the issue pattern (local or remote).
// Returns { branch, source: "local" | "remote" } or null.
export function findExistingBranch(
  issueId: string,
  gitFn: (...args: string[]) => string = git
): { branch: string; source: "local" | "remote" } | null {
  const pattern = `feature/issue-${issueId}-*`;

  // Check local branches first
  try {
    const local = gitFn("branch", "--list", pattern);
    const match = local.match(/(feature\/issue-\d+-\S+)/);
    if (match) return { branch: match[1], source: "local" };
  } catch { /* no local match */ }

  // Check remote branches
  try {
    const remote = gitFn("branch", "-r", "--list", `origin/${pattern}`);
    const match = remote.match(/origin\/(feature\/issue-\d+-\S+)/);
    if (match) return { branch: match[1], source: "remote" };
  } catch { /* no remote match */ }

  return null;
}

// Checkout or create a branch for an issue. Returns { branch, resumed }.
// If an existing branch is found (local or remote), checks it out.
// Otherwise creates a new branch from main.
export function checkoutOrCreateBranch(
  issueId: string,
  newBranch: string,
  gitFn: (...args: string[]) => string = git
): { branch: string; resumed: boolean } {
  const existing = findExistingBranch(issueId, gitFn);

  try { gitFn("stash", "--include-untracked"); } catch { /* no changes */ }

  let resumed = false;
  let finalBranch = newBranch;

  if (existing) {
    if (existing.source === "remote") {
      gitFn("fetch", "origin", existing.branch);
    }
    gitFn("checkout", existing.branch);
    resumed = true;
    finalBranch = existing.branch;
  } else {
    gitFn("checkout", "main");
    gitFn("pull", "origin", "main");
    gitFn("checkout", "-b", newBranch);
  }

  try { gitFn("stash", "pop"); } catch { /* no stash */ }

  return { branch: finalBranch, resumed };
}

// Normalized lint violation tuple for diffing.
export interface LintViolation {
  file: string;
  rule: string;
  line: number;
  column: number;
  message: string;
}

// Parse ESLint JSON output into normalized violation tuples.
export function parseLintJson(jsonOutput: string): LintViolation[] {
  const results = JSON.parse(jsonOutput) as Array<{
    filePath: string;
    messages: Array<{
      ruleId: string | null;
      line: number;
      column: number;
      message: string;
      severity: number;
    }>;
  }>;
  const violations: LintViolation[] = [];
  for (const file of results) {
    for (const msg of file.messages) {
      if (msg.severity === 0) continue; // skip "off" rules
      violations.push({
        file: file.filePath.replace(/\\/g, "/"), // normalize path separators
        rule: msg.ruleId ?? "unknown",
        line: msg.line,
        column: msg.column,
        message: msg.message,
      });
    }
  }
  return violations;
}

// Diff lint violations: return only violations present in `branch` but not in `main`.
export function diffLintViolations(
  mainViolations: LintViolation[],
  branchViolations: LintViolation[]
): LintViolation[] {
  const mainSet = new Set(
    mainViolations.map(v => `${v.file}|${v.rule}|${v.line}|${v.column}|${v.message}`)
  );
  return branchViolations.filter(
    v => !mainSet.has(`${v.file}|${v.rule}|${v.line}|${v.column}|${v.message}`)
  );
}

// Run diff-based lint gate: lint branch and main, return only new violations.
// Returns { handled: true, newViolations } on success, { handled: false } on fallback needed.
export function runDiffLintGate(
  gitFn: (...args: string[]) => string,
  runFn: (cmd: string) => { ok: boolean; stdout: string; stderr: string }
): { handled: true; newViolations: LintViolation[] } | { handled: false } {
  const mergeBase = gitFn("merge-base", "HEAD", "main");
  if (!mergeBase) return { handled: false };

  const currentBranch = gitFn("branch", "--show-current");
  if (!currentBranch || currentBranch === "main") return { handled: false };

  // Lint current branch with JSON output
  const branchLint = runFn("pnpm exec eslint . --format json --no-error-on-unmatched-pattern");
  if (!branchLint.ok && !branchLint.stdout.trim().startsWith("[")) {
    return { handled: false }; // ESLint failed without JSON — fallback
  }
  const branchJson = branchLint.stdout || "[]";

  // Stash, checkout merge-base to lint, then return to branch
  try { gitFn("stash", "--include-untracked"); } catch { /* no changes */ }
  let mainJson = "[]";
  let mainLintFailed = false;
  try {
    gitFn("checkout", mergeBase);
    const mainLint = runFn("pnpm exec eslint . --format json --no-error-on-unmatched-pattern");
    if (!mainLint.ok && !mainLint.stdout.trim().startsWith("[")) {
      mainLintFailed = true;
    } else {
      mainJson = mainLint.stdout || "[]";
    }
  } finally {
    try { gitFn("checkout", currentBranch); } catch { /* best effort */ }
    try { gitFn("stash", "pop"); } catch { /* no stash */ }
  }
  if (mainLintFailed) return { handled: false };

  const mainViolations = parseLintJson(mainJson);
  const branchViolations = parseLintJson(branchJson);
  const newViolations = diffLintViolations(mainViolations, branchViolations);

  return { handled: true, newViolations };
}

// Print message and exit with code 1.
export function die(msg: string): never {
  console.log(msg);
  process.exit(1);
}

// Truncate string to first N lines.
export function firstLines(s: string, n: number): string {
  return s.split("\n").slice(0, n).join("\n");
}

// Parse gitea comments output into individual comments.
export interface ParsedComment {
  id: string;
  username: string;
  date: string;
  body: string;
}

export function parseComments(output: string): ParsedComment[] {
  const comments: ParsedComment[] = [];
  const parts = output.split(/^--- comment /m).filter(Boolean);
  for (const part of parts) {
    const headerEnd = part.indexOf("\n");
    if (headerEnd === -1) continue;
    const header = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + 1).trim();
    const match = header.match(/(\d+)\s*\|\s*(\S+)\s*\|\s*(.+?)---?\s*$/);
    if (!match) continue;
    comments.push({ id: match[1], username: match[2], date: match[3].trim(), body });
  }
  return comments;
}
