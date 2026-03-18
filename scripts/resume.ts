#!/usr/bin/env node
// Resume a blocked GitHub issue: restore branch, update labels, show context.
// Usage: node scripts/resume.ts <issue-id>
// Output: branch + blocker context for the LLM to present to user.

import { gh, ghSetLabels, git, parseLabels, parseComments, withTempFile, die, JQ, GH_FIELDS } from "./lib.ts";

const id = process.argv[2];
if (!id) die("ERROR: usage: node scripts/resume.ts <issue-id>");

// 1. Read issue, verify blocked
const issue = gh("issue", "view", id, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
const labels = parseLabels(issue);
if (!labels.includes("blocked")) die(`ERROR: #${id} is not blocked (labels: ${labels.join(", ")})`);

// 2. Find BLOCKED comment and post-blocker answers
const commentsRaw = gh("api", `repos/{owner}/{repo}/issues/${id}/comments`, "--paginate", "--jq", JQ.COMMENTS);
const comments = parseComments(commentsRaw);

let blockerIdx = -1;
let blockerBody = "";
for (let i = comments.length - 1; i >= 0; i--) {
  if (comments[i].body.includes("**BLOCKED")) {
    blockerIdx = i;
    blockerBody = comments[i].body;
    break;
  }
}

let answers = "";
if (blockerIdx >= 0 && blockerIdx < comments.length - 1) {
  const postBlocker = comments.slice(blockerIdx + 1);
  answers = postBlocker.map(c => `${c.username}: ${c.body}`).join("\n---\n");
}

// 3. Find or create branch
let branch = "";
try {
  const branches = git("branch", "--list", `feature/issue-${id}-*`);
  const match = branches.match(/(feature\/issue-\d+-\S+)/);
  if (match) {
    branch = match[1];
    git("checkout", branch);
  }
} catch { /* no matching branch */ }

if (!branch) {
  const titleMatch = issue.match(/^#\d+\s+\[.+?\]\s+(.+)$/m) || issue.match(/^#\d+.+?:\s*(.+)$/m);
  const slug = (titleMatch?.[1] ?? "resume")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  branch = `feature/issue-${id}-${slug}`;
  git("checkout", "main");
  git("pull", "origin", "main");
  git("checkout", "-b", branch);
}

// 4. Remove blocked flag (status unchanged)
const newLabels = labels.filter(l => l !== "blocked");
ghSetLabels(id, newLabels);

// 5. Post resume comment
const resolution = answers ? "answers found (see below)" : "proceeding with default approach";
withTempFile(
  `**Resuming #${id}**\n- Previous blocker: see below\n- Resolution: ${resolution}\n- Branch: \`${branch}\``,
  (path) => { gh("issue", "comment", id, "--body-file", path); }
);

// 6. Output context for LLM
console.log(`RESUMED: #${id} — ${branch}`);
if (blockerBody) {
  console.log(`\nBlocker:\n${blockerBody}`);
}
if (answers) {
  console.log(`\nAnswers:\n${answers}`);
} else if (blockerBody) {
  console.log("\nNo answers posted yet.");
}
