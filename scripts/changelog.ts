#!/usr/bin/env node
// Generate a categorized changelog from git history and linked GitHub issues.
// Usage: node scripts/changelog.ts [since-ref]
// Output: markdown changelog.

import { git, ghSafe, JQ, GH_FIELDS } from "./lib.ts";

// 1. Determine since ref
let since = process.argv[2];
if (!since) {
  try {
    since = git("describe", "--tags", "--abbrev=0");
  } catch {
    since = "HEAD~20";
  }
}

// 2. Get commits
let commits: string[];
try {
  commits = git("log", "--oneline", `${since}..HEAD`).split("\n").filter(Boolean);
} catch {
  commits = git("log", "--oneline", "-20").split("\n").filter(Boolean);
}

if (commits.length === 0) {
  console.log("No commits since " + since);
  process.exit(0);
}

// 3. Extract unique issue IDs
const issueIds = new Set<string>();
for (const c of commits) {
  const matches = c.matchAll(/#(\d+)/g);
  for (const m of matches) issueIds.add(m[1]);
}

// 4. Fetch issue details
interface IssueInfo { id: string; title: string; type: string }
const issues = new Map<string, IssueInfo>();

for (const id of issueIds) {
  const { ok, output } = ghSafe("issue", "view", id, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
  if (!ok) continue;
  const titleMatch = output.match(/^#\d+\s+\[.+?\]\s+(.+)$/m);
  const title = titleMatch?.[1] ?? `Issue #${id}`;
  const labelMatch = output.match(/labels:\s*(.+)/i);
  const labels = labelMatch?.[1] ?? "";
  const type = labels.includes("type/feature") ? "feature"
    : labels.includes("type/bug") ? "bug"
    : labels.includes("type/chore") ? "chore"
    : "other";
  issues.set(id, { id, title, type });
}

// 5. Categorize
const features: string[] = [];
const bugs: string[] = [];
const chores: string[] = [];
const other: string[] = [];

for (const info of issues.values()) {
  const line = `- #${info.id} ${info.title}`;
  if (info.type === "feature") features.push(line);
  else if (info.type === "bug") bugs.push(line);
  else if (info.type === "chore") chores.push(line);
  else other.push(line);
}

// Commits without issue refs
for (const c of commits) {
  if (!/#\d+/.test(c)) other.push(`- ${c}`);
}

// 6. Output
const sections: string[] = [`# Changelog (${since}..HEAD)\n`];
if (features.length) sections.push(`## Features\n${features.join("\n")}\n`);
if (bugs.length) sections.push(`## Bug Fixes\n${bugs.join("\n")}\n`);
if (chores.length) sections.push(`## Chores\n${chores.join("\n")}\n`);
if (other.length) sections.push(`## Other\n${other.join("\n")}\n`);

console.log(sections.join("\n"));
