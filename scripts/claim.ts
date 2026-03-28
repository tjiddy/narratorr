#!/usr/bin/env node
// Claim a GitHub issue: validate status, create branch, update labels, post comment.
// Usage: node scripts/claim.ts <issue-id>
// Output: "CLAIMED: #<id> — <branch>" on success, error otherwise.

import { gh, ghSafe, ghSetLabels, parseLabels, replaceLabel, slugify, withTempFile, die, checkoutOrCreateBranch, UnmergedFilesError, JQ, GH_FIELDS } from "./lib.ts";

const id = process.argv[2];
if (!id) die("ERROR: usage: node scripts/claim.ts <issue-id>");

// 1. Read issue
const issue = gh("issue", "view", id, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
const labels = parseLabels(issue);

// 2. Check status
const status = labels.find(l => l.startsWith("status/"));
if (status === "status/in-progress") die(`ERROR: #${id} is already in progress`);
if (labels.includes("blocked")) die(`ERROR: #${id} is blocked — run /resume ${id}`);
if (status !== "status/ready" && status !== "status/ready-for-dev") {
  // Check for spec review
  const { ok, output } = ghSafe("api", `repos/{owner}/{repo}/issues/${id}/comments`, "--paginate", "--jq", JQ.COMMENTS);
  if (ok && output.includes("## Spec Review")) {
    if (output.includes("Verdict: needs-work")) {
      die(`ERROR: #${id} has unresolved spec review findings — address them first`);
    }
  }
  die(`ERROR: #${id} is not ready (status: ${status || "none"}) — run /review-spec ${id} first`);
}

// 3. Check for existing PRs
const prs = ghSafe("pr", "list", "--json", GH_FIELDS.PRS_LIST, "--jq", JQ.PRS_LIST);
if (prs.ok && prs.output.includes(`#${id}`)) {
  die(`ERROR: PR already open for #${id}`);
}

// 4. Extract title for branch name
const titleMatch = issue.match(/^#\d+\s+\[.+?\]\s+(.+)$/m) || issue.match(/^#\d+.+?:\s*(.+)$/m);
const title = titleMatch?.[1] ?? `issue-${id}`;
const branch = `feature/issue-${id}-${slugify(title)}`;

// 5. Checkout existing branch or create new one
let finalBranch: string;
let resumed: boolean;
try {
  ({ branch: finalBranch, resumed } = checkoutOrCreateBranch(id, branch));
} catch (e: unknown) {
  if (e instanceof UnmergedFilesError) {
    die(`ERROR: Unmerged files detected — resolve each conflict, then stage with \`git add\`:\n${e.files.map(f => `  ${f}`).join("\n")}`);
  }
  throw e;
}

// 6. Update labels
const newLabels = replaceLabel(labels, "status/", "status/in-progress");
ghSetLabels(id, newLabels);

// 7. Post comment
withTempFile(`**Claiming #${id}** — branch: \`${finalBranch}\``, (path) => {
  gh("issue", "comment", id, "--body-file", path);
});

console.log(`CLAIMED: #${id} — ${finalBranch}${resumed ? " (resumed)" : ""}`);
