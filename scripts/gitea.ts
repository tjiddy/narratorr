#!/usr/bin/env node
/* eslint-disable max-lines */
// Gitea CLI helper for Claude Code workflow plugin
// Usage: node gitea.ts <command> [args]
//
// Commands:
//   issues [all]                List open (or all) issues
//   issue <id>                  Get issue details
//   issue-create <title> <body|--body-file path> [labels] [milestone]
//   issue-update <id> <state|labels|milestone|title|body> <value|--body-file path>
//   issue-comments <id>         List all comments on an issue
//   issue-comment <id> <body|--body-file path>
//   labels                      List all labels
//   label-create <name> <color> [description]
//   milestones                  List milestones
//   milestone-create <title> [description]
//   search <query>              Search issues
//   prs                         List open pull requests
//   pr <number>                 Get PR details
//   pr-create <title> <body|--body-file path> <head> [base]
//   pr-comment <number> <body|--body-file path>
//   pr-comments <number>       List all comments on a PR
//   pr-merge <number> [merge|rebase|squash]  Merge a PR (default: squash)
//   runs [branch] [--limit N]  List recent CI runs (default: 10)
//   run-log <run-number>       Show logs for a CI run
//   commit-status <ref>        Get combined CI status (branch/tag/SHA)
//   whoami                     Print authenticated user's login name
//
// Reads GITEA_URL, GITEA_TOKEN, GITEA_OWNER, GITEA_REPO from
// environment variables or .env file in the current working directory.
// Optional: GITEA_USERNAME (avoids API call for whoami)

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- .env loading (reads from cwd, not script location) ---

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const dotenv = loadEnv();
function env(key: string): string {
  const val = process.env[key] || dotenv[key];
  if (!val) {
    console.error(`ERROR: ${key} not set. Add it to .env or export it.`);
    process.exit(1);
  }
  return val;
}

const GITEA_URL = env("GITEA_URL");
const GITEA_TOKEN = env("GITEA_TOKEN");
const GITEA_OWNER = env("GITEA_OWNER");
const GITEA_REPO = env("GITEA_REPO");

const API = `${GITEA_URL}/api/v1/repos/${GITEA_OWNER}/${GITEA_REPO}`;

// --- API helpers ---

async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `token ${GITEA_TOKEN}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function apiText(path: string): Promise<string> {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: `token ${GITEA_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`API error ${res.status}: ${text}`);
    process.exit(1);
  }
  return res.text();
}

/**
 * Fetch JSON without process.exit on failure — returns null instead.
 */
async function apiSafe<T = unknown>(path: string): Promise<T | null> {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${GITEA_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return null;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Find a job matching a given SHA by scanning the runs endpoint.
 * Gitea's tasks endpoint (workflow_runs) uses a different ID space than
 * the runs/jobs endpoints, so we estimate the internal run_id from the
 * task_id and fan out to find the matching SHA.
 */
async function findJobForSha(taskId: number, sha: string): Promise<GiteaJob | null> {
  // The internal run_id is typically task_id minus a fixed offset.
  // Fan out ±20 from the best estimate to account for drift.
  const estimate = taskId - 90;
  const candidates = [estimate];
  for (let i = 1; i <= 20; i++) {
    candidates.push(estimate + i, estimate - i);
  }
  for (const rid of candidates) {
    if (rid < 1) continue;
    const data = await apiSafe<GiteaJobList>(`/actions/runs/${rid}/jobs`);
    if (!data) continue;
    const match = data.jobs.find((j) => j.head_sha === sha);
    if (match) return match;
  }
  return null;
}

async function fetchAllComments(issuePath: string): Promise<GiteaComment[]> {
  const all: GiteaComment[] = [];
  let page = 1;
  const limit = 50;
  while (true) {
    const batch = await api<GiteaComment[]>(`${issuePath}/comments?limit=${limit}&page=${page}`);
    all.push(...batch);
    if (batch.length < limit) break;
    page++;
  }
  return all;
}

// --- Formatters ---

interface GiteaLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
}

interface GiteaMilestone {
  id: number;
  title: string;
  open_issues: number;
  closed_issues: number;
  description?: string;
}

interface GiteaIssue {
  number: number;
  state: string;
  title: string;
  body?: string;
  labels?: GiteaLabel[];
  milestone?: GiteaMilestone | null;
}

interface GiteaPR {
  number: number;
  state: string;
  title: string;
  body?: string;
  user: { login: string };
  head: { label: string; ref: string; sha: string };
  base: { label: string; ref: string };
  labels?: GiteaLabel[];
  html_url: string;
}

interface GiteaCommitStatus {
  id: number;
  status: string;
  context: string;
  description: string;
  target_url: string;
  created_at: string;
}

interface GiteaCombinedStatus {
  state: string;
  sha: string;
  total_count: number;
  statuses: GiteaCommitStatus[];
}

interface GiteaWorkflowRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  event: string;
  display_title: string;
  status: string;
  workflow_id: string;
  url: string;
  created_at: string;
  updated_at: string;
}

interface GiteaWorkflowRunList {
  workflow_runs: GiteaWorkflowRun[];
}

interface GiteaJob {
  id: number;
  url: string;
  html_url: string;
  run_id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string;
  created_at: string;
  started_at: string;
  completed_at: string;
}

interface GiteaJobList {
  jobs: GiteaJob[];
  total_count: number;
}

interface GiteaComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
}

function fmtIssues(issues: GiteaIssue[]): void {
  if (!issues.length) {
    console.log("No issues found");
    return;
  }
  for (const i of issues) {
    const labels = (i.labels || []).map((l) => l.name).join(", ");
    const ms = i.milestone?.title || "";
    console.log(`#${i.number} [${i.state}] ${i.title}`);
    const parts: string[] = [];
    if (labels) parts.push(`labels: ${labels}`);
    if (ms) parts.push(`milestone: ${ms}`);
    if (parts.length) console.log(`   ${parts.join(" | ")}`);
  }
}

function fmtIssue(i: GiteaIssue): void {
  const labels = (i.labels || []).map((l) => l.name).join(", ");
  const ms = i.milestone?.title || "";
  console.log(`#${i.number} [${i.state}] ${i.title}`);
  const parts: string[] = [];
  if (labels) parts.push(`labels: ${labels}`);
  if (ms) parts.push(`milestone: ${ms}`);
  if (parts.length) console.log(parts.join(" | "));
  if (i.body) {
    console.log();
    console.log(i.body);
  }
}

function fmtLabels(labels: GiteaLabel[]): void {
  if (!labels.length) {
    console.log("No labels");
    return;
  }
  for (const l of labels) {
    const desc = l.description ? ` - ${l.description}` : "";
    console.log(`  ${l.id}: ${l.name} (#${l.color})${desc}`);
  }
}

function fmtMilestones(milestones: GiteaMilestone[]): void {
  if (!milestones.length) {
    console.log("No milestones");
    return;
  }
  for (const m of milestones) {
    const desc = m.description ? ` - ${m.description}` : "";
    console.log(`  ${m.title} [open:${m.open_issues}/closed:${m.closed_issues}]${desc}`);
  }
}

function fmtPR(pr: GiteaPR): void {
  console.log(`#${pr.number} [${pr.state}] ${pr.title}`);
  console.log(`${pr.head.ref} → ${pr.base.ref} | author: ${pr.user.login} | sha: ${pr.head.sha} | ${pr.html_url}`);
  const labels = (pr.labels || []).map((l) => l.name).join(", ");
  if (labels) console.log(`labels: ${labels}`);
  if (pr.body) {
    console.log();
    console.log(pr.body);
  }
}

function fmtPRs(prs: GiteaPR[]): void {
  if (!prs.length) {
    console.log("No open pull requests");
    return;
  }
  for (const pr of prs) {
    console.log(`#${pr.number} [${pr.state}] ${pr.title}`);
    console.log(`   ${pr.head.label} → ${pr.base.label} | ${pr.html_url}`);
  }
}

function fmtRuns(runs: GiteaWorkflowRun[]): void {
  if (!runs.length) {
    console.log("No CI runs found");
    return;
  }
  for (const r of runs) {
    const icon = r.status === "success" ? "✓" : r.status === "failure" ? "✗" : "●";
    console.log(`${icon} #${r.run_number} ${r.display_title} ${r.head_sha.slice(0, 7)}`);
  }
}

/**
 * Strip Gitea runner timestamps and infrastructure noise from CI logs.
 * Extracts only the lint/typecheck/test/build output we care about.
 */
function stripLogNoise(raw: string): string {
  const lines = raw.split("\n").map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, ""));

  // Find where the actual build steps start (after pnpm install)
  // and skip all checkout/setup/install noise
  let buildStart = -1;
  let jobResult = "";
  for (let i = 0; i < lines.length; i++) {
    // The first "narratorr@" line after install is the real build output
    if (lines[i].includes("> narratorr@") && buildStart === -1) {
      buildStart = i;
    }
    if (lines[i].includes("Job failed") || lines[i].includes("Job succeeded")) {
      jobResult = lines[i];
    }
  }

  if (buildStart === -1) {
    // Fallback: couldn't find build start, return everything stripped
    return lines.filter((l) => l.trim()).join("\n");
  }

  // Find where the post-job cleanup starts
  let buildEnd = lines.length;
  for (let i = buildStart; i < lines.length; i++) {
    if (lines[i].includes("⭐ Run Post ") || lines[i].includes("Skipping step '")) {
      buildEnd = i;
      break;
    }
  }

  const buildLines = lines.slice(buildStart, buildEnd).filter((line) => {
    if (!line.trim()) return false;
    if (line.startsWith("  🐳")) return false;
    if (line.includes("evaluating expression")) return false;
    if (line.includes("expression '") && line.includes("evaluated to")) return false;
    if (line.includes("expression '") && line.includes("rewritten to")) return false;
    if (line.includes("Exec command '")) return false;
    if (line.includes("Working directory '")) return false;
    if (line.includes("Writing entry to tarball")) return false;
    if (line.includes("Extracting content")) return false;
    if (line.startsWith("exitcode '")) return false;
    return true;
  });

  if (jobResult && !buildLines[buildLines.length - 1]?.includes(jobResult)) {
    buildLines.push(jobResult);
  }

  return buildLines.join("\n");
}

function fmtComments(comments: GiteaComment[]): void {
  if (!comments.length) {
    console.log("No comments");
    return;
  }
  for (const c of comments) {
    console.log(`--- comment ${c.id} | ${c.user.login} | ${c.created_at} ---`);
    console.log(c.body);
    console.log();
  }
}

// --- Label resolution ---

async function resolveLabels(input: string): Promise<number[]> {
  // If already all numeric, pass through
  if (/^[\d]+(,[\d]+)*$/.test(input)) {
    return input.split(",").map(Number);
  }
  // Fetch all labels and resolve names → IDs
  const allLabels = await api<GiteaLabel[]>("/labels");
  const nameToId = new Map(allLabels.map((l) => [l.name, l.id]));
  const ids: number[] = [];
  for (const name of input.split(",")) {
    const trimmed = name.trim();
    const id = nameToId.get(trimmed);
    if (id !== undefined) {
      ids.push(id);
    } else {
      console.error(`Warning: label "${trimmed}" not found`);
    }
  }
  if (!ids.length) {
    console.error("ERROR: could not resolve any labels");
    process.exit(1);
  }
  return ids;
}

async function resolveMilestone(input: string): Promise<number> {
  if (/^\d+$/.test(input)) return Number(input);
  const all = await api<GiteaMilestone[]>("/milestones");
  const match = all.find((m) => m.title === input || m.title.startsWith(input));
  if (!match) {
    console.error(`ERROR: milestone "${input}" not found`);
    process.exit(1);
  }
  return match.id;
}

// --- String helpers ---

function unescapeBody(s: string): string {
  return s.replace(/\\+n/g, "\n");
}

/**
 * Resolve body content from args. Supports --body-file <path> to read from file,
 * which avoids all shell escaping issues with multiline content.
 * Returns [resolvedBody, remainingArgs].
 */
function extractBody(args: string[]): [string, string[]] {
  const idx = args.indexOf("--body-file");
  if (idx !== -1) {
    const filePath = args[idx + 1];
    if (!filePath) {
      console.error("ERROR: --body-file requires a file path argument");
      process.exit(1);
    }
    if (!existsSync(filePath)) {
      console.error(`ERROR: body file not found: ${filePath}`);
      process.exit(1);
    }
    const body = readFileSync(filePath, "utf-8");
    // Remove --body-file and its argument from args, return rest
    const remaining = [...args.slice(0, idx), ...args.slice(idx + 2)];
    return [body, remaining];
  }
  // No --body-file flag; first arg is the inline body (apply unescapeBody)
  const [body, ...rest] = args;
  return [body ? unescapeBody(body) : "", rest];
}

// --- Commands ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "issues": {
    const state = args[0] === "all" ? "all" : "open";
    const data = await api<GiteaIssue[]>(`/issues?state=${state}&type=issues&limit=50`);
    fmtIssues(data);
    break;
  }

  case "issue": {
    const id = args[0];
    if (!id) {
      console.error("Usage: gitea issue <id>");
      process.exit(1);
    }
    const data = await api<GiteaIssue>(`/issues/${id}`);
    fmtIssue(data);
    break;
  }

  case "issue-create": {
    const title = args[0];
    const [body, restArgs] = extractBody(args.slice(1));
    const [labels, milestone] = restArgs;
    if (!title) {
      console.error("Usage: gitea issue-create <title> <body|--body-file path> [labels] [milestone]");
      process.exit(1);
    }
    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels) payload.labels = await resolveLabels(labels);
    if (milestone) payload.milestone = await resolveMilestone(milestone);
    const data = await api<GiteaIssue>("/issues", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    fmtIssue(data);
    break;
  }

  case "issue-update": {
    const id = args[0];
    const field = args[1];
    if (!id || !field) {
      console.error("Usage: gitea issue-update <id> <state|labels|milestone|title|body> <value|--body-file path>");
      process.exit(1);
    }
    switch (field) {
      case "state": {
        const value = args[2];
        if (!value) { console.error("Usage: gitea issue-update <id> state <open|closed>"); process.exit(1); }
        const data = await api<GiteaIssue>(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ state: value }),
        });
        fmtIssue(data);
        break;
      }
      case "labels": {
        const value = args[2];
        if (!value) { console.error("Usage: gitea issue-update <id> labels <name1,name2>"); process.exit(1); }
        const labelIds = await resolveLabels(value);
        const data = await api<GiteaLabel[]>(`/issues/${id}/labels`, {
          method: "PUT",
          body: JSON.stringify({ labels: labelIds }),
        });
        if (Array.isArray(data)) {
          const names = data.map((l: GiteaLabel) => l.name);
          console.log("Labels set: " + names.join(", "));
        } else {
          console.error("ERROR: unexpected response");
          console.error(JSON.stringify(data));
          process.exit(1);
        }
        break;
      }
      case "milestone": {
        const value = args[2];
        if (!value) { console.error("Usage: gitea issue-update <id> milestone <name|id>"); process.exit(1); }
        const msId = await resolveMilestone(value);
        const data = await api<GiteaIssue>(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ milestone: msId }),
        });
        fmtIssue(data);
        break;
      }
      case "title": {
        const value = args[2];
        if (!value) { console.error("Usage: gitea issue-update <id> title <new-title>"); process.exit(1); }
        const data = await api<GiteaIssue>(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: value }),
        });
        fmtIssue(data);
        break;
      }
      case "body": {
        const [bodyContent] = extractBody(args.slice(2));
        if (!bodyContent) { console.error("Usage: gitea issue-update <id> body <text|--body-file path>"); process.exit(1); }
        const data = await api<GiteaIssue>(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ body: bodyContent }),
        });
        fmtIssue(data);
        break;
      }
      default:
        console.error(`Unknown field: ${field}. Use: state, labels, milestone, title, body`);
        process.exit(1);
    }
    break;
  }

  case "issue-comments": {
    const id = args[0];
    if (!id) {
      console.error("Usage: gitea issue-comments <id>");
      process.exit(1);
    }
    const comments = await fetchAllComments(`/issues/${id}`);
    fmtComments(comments);
    break;
  }

  case "issue-comment": {
    const id = args[0];
    const [body] = extractBody(args.slice(1));
    if (!id || !body) {
      console.error("Usage: gitea issue-comment <id> <body|--body-file path>");
      process.exit(1);
    }
    await api(`/issues/${id}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    console.log(`Comment added to #${id}`);
    break;
  }

  case "labels": {
    const data = await api<GiteaLabel[]>("/labels");
    fmtLabels(data);
    break;
  }

  case "label-create": {
    const [name, color, desc] = args;
    if (!name || !color) {
      console.error("Usage: gitea label-create <name> <color> [description]");
      process.exit(1);
    }
    const payload: Record<string, string> = { name, color: `#${color}` };
    if (desc) payload.description = desc;
    await api("/labels", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`Created label: ${name}`);
    break;
  }

  case "milestones": {
    const data = await api<GiteaMilestone[]>("/milestones");
    fmtMilestones(data);
    break;
  }

  case "milestone-create": {
    const [title, desc] = args;
    if (!title) {
      console.error("Usage: gitea milestone-create <title> [description]");
      process.exit(1);
    }
    const payload: Record<string, string> = { title };
    if (desc) payload.description = desc;
    await api("/milestones", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`Created milestone: ${title}`);
    break;
  }

  case "search": {
    const query = args[0];
    if (!query) {
      console.error("Usage: gitea search <query>");
      process.exit(1);
    }
    const data = await api<GiteaIssue[]>(`/issues?state=all&type=issues&q=${encodeURIComponent(query)}&limit=20`);
    fmtIssues(data);
    break;
  }

  case "prs": {
    const state = args[0] === "all" ? "all" : "open";
    const data = await api<GiteaPR[]>(`/pulls?state=${state}&limit=50`);
    fmtPRs(data);
    break;
  }

  case "pr": {
    const num = args[0];
    if (!num) {
      console.error("Usage: gitea pr <number>");
      process.exit(1);
    }
    const prData = await api<GiteaPR>(`/pulls/${num}`);
    fmtPR(prData);
    break;
  }

  case "pr-comment": {
    const num = args[0];
    const [commentBody] = extractBody(args.slice(1));
    if (!num || !commentBody) {
      console.error("Usage: gitea pr-comment <number> <body|--body-file path>");
      process.exit(1);
    }
    await api(`/issues/${num}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: commentBody }),
    });
    console.log(`Comment added to PR #${num}`);
    break;
  }

  case "pr-create": {
    const title = args[0];
    const [body, restArgs] = extractBody(args.slice(1));
    const [head, base] = restArgs;
    if (!title || !body || !head) {
      console.error("Usage: gitea pr-create <title> <body|--body-file path> <head> [base]");
      process.exit(1);
    }
    const payload = { title, body, head, base: base || "main" };
    const data = await api<GiteaPR>("/pulls", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`PR #${data.number} created: ${data.html_url}`);
    break;
  }

  case "pr-comments": {
    const num = args[0];
    if (!num) {
      console.error("Usage: gitea pr-comments <number>");
      process.exit(1);
    }
    const comments = await fetchAllComments(`/issues/${num}`);
    fmtComments(comments);
    break;
  }

  case "pr-update-labels": {
    const num = args[0];
    const value = args[1];
    if (!num || !value) {
      console.error("Usage: gitea pr-update-labels <number> <label1,label2,...>");
      process.exit(1);
    }
    const labelIds = await resolveLabels(value);
    const data = await api<GiteaLabel[]>(`/issues/${num}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels: labelIds }),
    });
    if (Array.isArray(data)) {
      const names = data.map((l: GiteaLabel) => l.name);
      console.log("Labels set: " + names.join(", "));
    } else {
      console.error("ERROR: unexpected response");
      console.error(JSON.stringify(data));
      process.exit(1);
    }
    break;
  }

  case "pr-merge": {
    const num = args[0];
    const method = args[1] || "squash";
    if (!num) {
      console.error("Usage: gitea pr-merge <number> [merge|rebase|squash]");
      process.exit(1);
    }
    if (!["merge", "rebase", "squash"].includes(method)) {
      console.error(`Invalid merge method: ${method}. Use: merge, rebase, squash`);
      process.exit(1);
    }
    await api(`/pulls/${num}/merge`, {
      method: "POST",
      body: JSON.stringify({ Do: method }),
    });
    console.log(`PR #${num} merged via ${method}`);
    break;
  }

  case "runs": {
    let limit = 10;
    let branch: string | undefined;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--limit" && args[i + 1]) {
        limit = parseInt(args[i + 1], 10);
        i++;
      } else {
        branch = args[i];
      }
    }
    const data = await api<GiteaWorkflowRunList>(`/actions/tasks?page=1&limit=${limit}`);
    let runs = data.workflow_runs;
    if (branch) {
      runs = runs.filter((r) => r.head_branch === branch || r.head_branch === `#${branch}`);
    }
    fmtRuns(runs);
    break;
  }

  case "run-log": {
    const runNum = args[0];
    if (!runNum) {
      console.error("Usage: gitea run-log <run-number>");
      process.exit(1);
    }
    // Find the run in the tasks list
    const tasksData = await api<GiteaWorkflowRunList>("/actions/tasks?page=1&limit=50");
    const targetRun = tasksData.workflow_runs.find((r) => r.run_number === parseInt(runNum, 10));
    if (!targetRun) {
      console.error(`ERROR: run #${runNum} not found in recent runs`);
      process.exit(1);
    }
    // Find the job by matching SHA
    const job = await findJobForSha(targetRun.id, targetRun.head_sha);
    if (!job) {
      console.error(`ERROR: could not find job for run #${runNum} (sha: ${targetRun.head_sha.slice(0, 10)})`);
      process.exit(1);
    }
    const logs = await apiText(`/actions/jobs/${job.id}/logs`);
    console.log(`--- #${runNum} ${targetRun.display_title} [${job.conclusion}] ${targetRun.head_sha.slice(0, 7)} ---`);
    console.log(stripLogNoise(logs));
    break;
  }

  case "commit-status": {
    const ref = args[0];
    if (!ref) {
      console.error("Usage: gitea commit-status <ref> (branch name, tag, or SHA)");
      process.exit(1);
    }
    const status = await api<GiteaCombinedStatus>(`/commits/${ref}/status`);
    if (status.total_count === 0) {
      console.log(`CI: no status checks found for ${ref}`);
    } else {
      console.log(`CI: ${status.state} (${status.total_count} checks)`);
      for (const s of status.statuses) {
        console.log(`  ${s.context}: ${s.status}`);
      }
    }
    break;
  }

  case "whoami": {
    // Return the authenticated user's login name.
    // Prefers GITEA_USERNAME from env/.env (avoids an API call),
    // falls back to querying the Gitea /user endpoint.
    const username = process.env["GITEA_USERNAME"] || dotenv["GITEA_USERNAME"];
    if (username) {
      console.log(username);
    } else {
      const res = await fetch(`${GITEA_URL}/api/v1/user`, {
        headers: { Authorization: `token ${GITEA_TOKEN}` },
      });
      if (!res.ok) {
        console.error(`Failed to fetch current user: ${res.status}`);
        process.exit(1);
      }
      const data = await res.json() as { login: string };
      console.log(data.login);
    }
    break;
  }

  case "help":
  default:
    console.log(`Gitea Workflow CLI

Usage: node gitea.ts <command> [args]

Commands:
  issues [all]                List open (or all) issues
  issue <id>                  Get issue details
  issue-create <t> <b> [l] [m]  Create issue
  issue-update <id> <f> <v>  Update field (state/labels/milestone/title/body)
  issue-comments <id>       List all comments on an issue
  issue-comment <id> <body>  Add comment
  labels                     List labels
  label-create <n> <c> [d]   Create label
  milestones                 List milestones
  milestone-create <t> [d]   Create milestone
  search <query>             Search issues
  prs [all]                  List pull requests
  pr <number>                Get PR details
  pr-create <t> <b> <h> [base]  Create pull request
  pr-comment <n> <body>      Add comment to PR
  pr-comments <number>       List all comments on a PR
  pr-update-labels <n> <l>   Set labels on a PR
  pr-merge <n> [method]      Merge PR (merge|rebase|squash, default: squash)
  runs [branch] [--limit N]  List recent CI runs (default: 10)
  run-log <run-number>       Show logs for a CI run
  commit-status <ref>        Get combined CI status for a ref (branch/tag/SHA)
  whoami                     Print authenticated user's login name

Body args accept --body-file <path> to read content from a file
instead of an inline argument (avoids shell escaping issues).

Environment: GITEA_URL, GITEA_TOKEN, GITEA_OWNER, GITEA_REPO
Optional: GITEA_USERNAME (avoids API call for whoami)
Reads from .env in current working directory, or from environment.`);
    break;
}
