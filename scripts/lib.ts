// Shared helpers for workflow scripts
// Usage: import { gh, git, run, ... } from "./lib.ts"

import { execFileSync, execSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createSign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXEC_OPTS = { encoding: "utf-8" as const, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };

// ---------------------------------------------------------------------------
// GitHub App token management
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

const tokenCache = new Map<string, CachedToken>();

// Build a GitHub App JWT (RS256, 10-min expiry). No external deps.
function makeJwt(appId: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: appId })).toString("base64url");
  const sign = createSign("RSA-SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

// Get a valid GH_TOKEN, refreshing if needed. Returns undefined when no app
// credentials are configured (falls back to user's `gh auth`).
function getGhToken(): string | undefined {
  const appId = process.env.GH_APP_ID;
  const installationId = process.env.GH_INSTALLATION_ID;
  const privateKeyPath = process.env.GH_APP_PRIVATE_KEY_PATH;
  const privateKeyEnv = process.env.GH_APP_PRIVATE_KEY;

  if (!appId || !installationId || (!privateKeyPath && !privateKeyEnv)) return undefined;

  const cached = tokenCache.get(appId);
  const fiveMinMs = 5 * 60 * 1000;
  if (cached && cached.expiresAt - Date.now() > fiveMinMs) return cached.token;

  // Synchronous wrapper — scripts are sync, and this runs at most once per ~55 min.
  // We shell out to a temp script because fetch() is async and lib functions are sync.
  const privateKey = privateKeyEnv || readFileSync(privateKeyPath!, "utf-8");
  const jwt = makeJwt(appId, privateKey);
  const scriptContent = [
    `const res = await fetch("https://api.github.com/app/installations/${installationId}/access_tokens", {`,
    `  method: "POST",`,
    `  headers: {`,
    `    Authorization: "Bearer " + process.argv[2],`,
    `    Accept: "application/vnd.github+json",`,
    `    "X-GitHub-Api-Version": "2022-11-28",`,
    `  },`,
    `});`,
    `if (!res.ok) { process.stderr.write(await res.text()); process.exit(1); }`,
    `const d = await res.json();`,
    `process.stdout.write(JSON.stringify({ token: d.token, expires_at: d.expires_at }));`,
  ].join("\n");

  // Write as .mjs so Node treats it as ESM (top-level await support).
  const scriptPath = join(tmpdir(), `narratorr-ghtoken-${process.pid}.mjs`);
  writeFileSync(scriptPath, scriptContent);
  try {
    const result = execFileSync("node", [scriptPath, jwt],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    const data = JSON.parse(result) as { token: string; expires_at: string };
    const entry: CachedToken = { token: data.token, expiresAt: new Date(data.expires_at).getTime() };
    tokenCache.set(appId, entry);
    return entry.token;
  } finally {
    try { unlinkSync(scriptPath); } catch { /* cleanup */ }
  }
}

// Exported for testing.
export { makeJwt as _makeJwt, tokenCache as _tokenCache };

// ---------------------------------------------------------------------------
// JQ output templates — contract between `gh` output and parsers
// ---------------------------------------------------------------------------

export const JQ = {
  // gh issue view <id> --json number,state,title,labels,milestone,body --jq '...'
  ISSUE: `"#\\(.number) [\\(.state | ascii_downcase)] \\(.title)\\nlabels: \\([.labels[].name] | join(", "))\\(.milestone.title // "" | if . != "" then " | milestone: \\(.)" else "" end)\\n\\n\\(.body // "")"`,

  // gh issue list --json number,state,title,labels,milestone --jq '...'
  ISSUES_LIST: `.[] | "#\\(.number) [\\(.state | ascii_downcase)] \\(.title)\\n   labels: \\([.labels[].name] | join(", "))\\(.milestone.title // "" | if . != "" then " | milestone: \\(.)" else "" end)"`,

  // gh pr view <n> --json number,state,title,headRefName,baseRefName,author,headRefOid,url,labels,body --jq '...'
  PR: `"#\\(.number) [\\(.state | ascii_downcase)] \\(.title)\\n\\(.headRefName) → \\(.baseRefName) | author: \\(.author.login) | sha: \\(.headRefOid) | \\(.url)\\nlabels: \\([.labels[].name] | join(", "))\\n\\n\\(.body // "")"`,

  // gh pr list --json number,state,title,headRefName,baseRefName,url --jq '...'
  PRS_LIST: `.[] | "#\\(.number) [\\(.state | ascii_downcase)] \\(.title)\\n   \\(.headRefName) → \\(.baseRefName) | \\(.url)"`,

  // gh api repos/{owner}/{repo}/issues/<id>/comments --paginate --jq '...'
  COMMENTS: `.[] | "--- comment \\(.id) | \\(.user.login) | \\(.created_at) ---\\n\\(.body)\\n"`,

  // gh api repos/{owner}/{repo}/commits/<ref>/status --jq '...'
  COMMIT_STATUS: `if .total_count == 0 then "CI: no status checks found" else "CI: \\(.state) (\\(.total_count) checks)\\n\\(.statuses[] | "  \\(.context): \\(.state)")" end`,
} as const;

// JSON field sets for --json flags (keep in sync with JQ templates above)
export const GH_FIELDS = {
  ISSUE: "number,state,title,labels,milestone,body",
  ISSUES_LIST: "number,state,title,labels,milestone",
  PR: "number,state,title,headRefName,baseRefName,author,headRefOid,url,labels,body",
  PRS_LIST: "number,state,title,headRefName,baseRefName,url",
} as const;

// ---------------------------------------------------------------------------
// gh CLI wrappers
// ---------------------------------------------------------------------------

// Run a gh CLI command, return stdout. Throws on failure.
export function gh(...args: string[]): string {
  const token = getGhToken();
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  return execFileSync("gh", args, { ...EXEC_OPTS, env }).trim();
}

// Run a gh command, return structured result (never throws).
export function ghSafe(...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: gh(...args) };
  } catch (e: unknown) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    return { ok: false, output: (err.stderr || err.stdout || err.message || "").toString().trim() };
  }
}

// Atomically replace all labels on an issue or PR.
// GitHub's `gh issue edit` only has --add-label/--remove-label; this uses the
// REST API's PUT endpoint for atomic replacement.
export function ghSetLabels(issueOrPrNumber: string, labels: string[]): string {
  return withTempFile(JSON.stringify({ labels }), (path) =>
    gh("api", `repos/{owner}/{repo}/issues/${issueOrPrNumber}/labels`, "-X", "PUT", "--input", path,
      "--jq", `[.[].name] | join(", ")`)
  );
}

// ---------------------------------------------------------------------------
// Deprecated — fail loudly if any callsite was missed
// ---------------------------------------------------------------------------

/** @deprecated Use gh() instead */
export function gitea(..._args: string[]): never {
  throw new Error(`gitea() removed — use gh(). Caller:\n${new Error().stack}`);
}

/** @deprecated Use ghSafe() instead */
export function giteaSafe(..._args: string[]): never {
  throw new Error(`giteaSafe() removed — use ghSafe(). Caller:\n${new Error().stack}`);
}

// ---------------------------------------------------------------------------
// Shell / git helpers (unchanged)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Output parsers (unchanged — JQ templates produce matching format)
// ---------------------------------------------------------------------------

// Parse label names from issue/PR output.
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

// Parse PR/issue author from output.
export function parseAuthor(output: string): string | null {
  const match = output.match(/author:\s*(\S+)/i);
  return match ? match[1] : null;
}

// Parse SHA from PR output.
export function parseSha(output: string): string | null {
  const match = output.match(/sha:\s*(\S+)/i);
  return match ? match[1] : null;
}

// Parse state from output.
export function parseState(output: string): string | null {
  const match = output.match(/^#\d+\s+\[(\w+)]/m);
  return match ? match[1] : null;
}

// Parse head branch from PR output.
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

// Unmerged porcelain status codes — covers all conflict states from git status --porcelain.
const UNMERGED_CODES = new Set(["UU", "AA", "AU", "UA", "DD", "UD", "DU"]);

// Thrown when checkoutOrCreateBranch detects unmerged files in the working tree.
export class UnmergedFilesError extends Error {
  readonly files: string[];
  constructor(files: string[]) {
    const list = files.map(f => `  ${f}`).join("\n");
    super(
      `Unmerged files detected — resolve each conflict, then stage with \`git add\`:\n${list}`
    );
    this.name = "UnmergedFilesError";
    this.files = files;
  }
}

// Checkout or create a branch for an issue. Returns { branch, resumed }.
// If an existing branch is found (local or remote), checks it out.
// Otherwise creates a new branch from main.
export function checkoutOrCreateBranch(
  issueId: string,
  newBranch: string,
  gitFn: (...args: string[]) => string = git
): { branch: string; resumed: boolean } {
  // Pre-flight: detect unmerged files before any stash/checkout/pull operations
  const status = gitFn("status", "--porcelain");
  if (status) {
    const unmerged = status.split("\n")
      .filter(line => UNMERGED_CODES.has(line.slice(0, 2)))
      .map(line => line.slice(3));
    if (unmerged.length > 0) {
      throw new UnmergedFilesError(unmerged);
    }
  }

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

// Parse comments output into individual comments.
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
