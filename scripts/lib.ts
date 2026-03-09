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

const EXEC_OPTS = { encoding: "utf-8" as const, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] as const };

// Run a gitea CLI command, return stdout. Throws on failure.
// Retries up to 3 times on ECONNREFUSED (Gitea connectivity is intermittent).
export function gitea(...args: string[]): string {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync("tsx", [GITEA_CLI, ...args], EXEC_OPTS).trim();
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
  const match = output.match(/labels:\s*(.+)/i);
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

// Parse linked issue ID from PR body (Refs #123).
export function parseLinkedIssue(output: string): string | null {
  const match = output.match(/Refs\s+#(\d+)/i);
  return match ? match[1] : null;
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
  const match = output.match(/state:\s*(\S+)/i);
  return match ? match[1] : null;
}

// Parse head branch from gitea PR output.
export function parseHeadBranch(output: string): string | null {
  const match = output.match(/head:\s*(\S+)/i);
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
