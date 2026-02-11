#!/usr/bin/env node
// Gitea CLI helper for Claude Code sessions
// Usage: node scripts/gitea.ts <command> [args]
//
// Commands:
//   issues [all]                List open (or all) issues
//   issue <id>                  Get issue details
//   issue-create <title> <body|--body-file path> [labels] [milestone]
//   issue-update <id> <state|labels|milestone|title|body> <value|--body-file path>
//   issue-comment <id> <body|--body-file path>
//   labels                      List all labels
//   label-create <name> <color> [description]
//   milestones                  List milestones
//   milestone-create <title> [description]
//   search <query>              Search issues
//   prs                         List open pull requests
//   pr-create <title> <body|--body-file path> <head> [base]

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- .env loading ---

function loadEnv(): Record<string, string> {
  const envPath = resolve(__dirname, "..", ".env");
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
    console.error(`ERROR: ${key} not set. Add it to .env`);
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

async function api(path: string, options?: RequestInit): Promise<any> {
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
  return text ? JSON.parse(text) : null;
}

// --- Formatters ---

interface GiteaLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
}

interface GiteaMilestone {
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
  head: { label: string };
  base: { label: string };
  html_url: string;
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

// --- Label resolution ---

async function resolveLabels(input: string): Promise<number[]> {
  // If already all numeric, pass through
  if (/^[\d]+(,[\d]+)*$/.test(input)) {
    return input.split(",").map(Number);
  }
  // Fetch all labels and resolve names → IDs
  const allLabels: GiteaLabel[] = await api("/labels");
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
    const data = await api(`/issues?state=${state}&type=issues&limit=50`);
    fmtIssues(data);
    break;
  }

  case "issue": {
    const id = args[0];
    if (!id) {
      console.error("Usage: gitea issue <id>");
      process.exit(1);
    }
    const data = await api(`/issues/${id}`);
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
    const payload: any = { title };
    if (body) payload.body = body;
    if (labels) payload.labels = await resolveLabels(labels);
    if (milestone) payload.milestone = Number(milestone);
    const data = await api("/issues", {
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
        const data = await api(`/issues/${id}`, {
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
        const data = await api(`/issues/${id}/labels`, {
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
        const data = await api(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ milestone: Number(value) }),
        });
        fmtIssue(data);
        break;
      }
      case "title": {
        const value = args[2];
        if (!value) { console.error("Usage: gitea issue-update <id> title <new-title>"); process.exit(1); }
        const data = await api(`/issues/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: value }),
        });
        fmtIssue(data);
        break;
      }
      case "body": {
        const [bodyContent] = extractBody(args.slice(2));
        if (!bodyContent) { console.error("Usage: gitea issue-update <id> body <text|--body-file path>"); process.exit(1); }
        const data = await api(`/issues/${id}`, {
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
    const data = await api("/labels");
    fmtLabels(data);
    break;
  }

  case "label-create": {
    const [name, color, desc] = args;
    if (!name || !color) {
      console.error("Usage: gitea label-create <name> <color> [description]");
      process.exit(1);
    }
    const payload: any = { name, color: `#${color}` };
    if (desc) payload.description = desc;
    await api("/labels", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`Created label: ${name}`);
    break;
  }

  case "milestones": {
    const data = await api("/milestones");
    fmtMilestones(data);
    break;
  }

  case "milestone-create": {
    const [title, desc] = args;
    if (!title) {
      console.error("Usage: gitea milestone-create <title> [description]");
      process.exit(1);
    }
    const payload: any = { title };
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
    const data = await api(`/issues?state=all&type=issues&q=${encodeURIComponent(query)}&limit=20`);
    fmtIssues(data);
    break;
  }

  case "prs": {
    const state = args[0] === "all" ? "all" : "open";
    const data = await api(`/pulls?state=${state}&limit=50`);
    fmtPRs(data);
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
    const payload: any = {
      title,
      body,
      head,
      base: base || "main",
    };
    const data = await api("/pulls", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    console.log(`PR #${data.number} created: ${data.html_url}`);
    break;
  }

  case "help":
  default:
    console.log(`Usage: node scripts/gitea.ts <command> [args]

Commands:
  issues [all]                List open (or all) issues
  issue <id>                  Get issue details
  issue-create <t> <b> [l] [m]  Create issue
  issue-update <id> <f> <v>  Update field (state/labels/milestone/title/body)
  issue-comment <id> <body>  Add comment
  labels                     List labels
  label-create <n> <c> [d]   Create label
  milestones                 List milestones
  milestone-create <t> [d]   Create milestone
  search <query>             Search issues
  prs [all]                  List pull requests
  pr-create <t> <b> <h> [base]  Create pull request

Body args accept --body-file <path> to read content from a file
instead of an inline argument (avoids shell escaping issues).`);
    break;
}
