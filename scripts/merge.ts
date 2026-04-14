#!/usr/bin/env node
// Merge an approved PR: check approval, CI, merge, cleanup, update issue.
// Usage: node scripts/merge.ts <pr-number>
// Output: "MERGED: PR #<n> — #<id> closed" on success, error otherwise.

import {
  gh, ghSafe, ghSetLabels, git, parseLabels, replaceLabel, removeLabel,
  parseLinkedIssue, parseAuthor, parseSha, parseState, parseHeadBranch,
  parseComments, withTempFile, die, JQ, GH_FIELDS,
} from "./lib.ts";

const prNum = process.argv[2];
if (!prNum) die("ERROR: usage: node scripts/merge.ts <pr-number>");

// 1. Fetch PR (two calls: formatted output for parsing, structured for linked issues)
const pr = gh("pr", "view", prNum, "--json", GH_FIELDS.PR, "--jq", JQ.PR);
const state = parseState(pr);
if (state !== "open") die(`ERROR: PR #${prNum} is not open (state: ${state})`);

const prAuthor = parseAuthor(pr);
const sha = parseSha(pr);
const headBranch = parseHeadBranch(pr);
const linkedIssueId = parseLinkedIssue(pr);

// Resolve closing issue IDs: GitHub formal links first, branch name fallback
const closingRefsJson = gh("pr", "view", prNum, "--json", "closingIssuesReferences", "--jq", "[.closingIssuesReferences[].number]");
let closingIssueIds: string[] = [];
try {
  closingIssueIds = (JSON.parse(closingRefsJson) as number[]).map(String);
} catch { /* empty or malformed — fall through to branch fallback */ }

if (closingIssueIds.length === 0) {
  const branchMatch = headBranch?.match(/^feature\/issue-(\d+)-/);
  if (branchMatch) closingIssueIds = [branchMatch[1]];
}

// 2. Check approval — find latest verdict from a non-author user
const commentsRaw = gh("api", `repos/{owner}/{repo}/issues/${prNum}/comments`, "--paginate", "--jq", JQ.COMMENTS);
const comments = parseComments(commentsRaw);

let approved = false;
for (let i = comments.length - 1; i >= 0; i--) {
  const c = comments[i];
  if (!c.body.includes("## Verdict:")) continue;
  if (c.username === prAuthor) continue; // skip self-reviews

  if (c.body.includes("## Verdict: approve")) {
    // Check no needs-work after this approve from a different reviewer
    const laterNeedsWork = comments.slice(i + 1).some(
      lc => lc.body.includes("## Verdict: needs-work") && lc.username !== prAuthor
    );
    if (laterNeedsWork) die("ERROR: stale approval — a later review said needs-work");
    approved = true;
    break;
  }
  if (c.body.includes("## Verdict: needs-work")) {
    die("ERROR: latest review verdict is needs-work — cannot merge");
  }
}
if (!approved) die("ERROR: no reviewer approval found");

// 3. Check for unresolved disputes
if (commentsRaw.includes("## Status: needs-human-input")) {
  // Check if there's been a review cycle after the dispute
  const disputeIdx = commentsRaw.lastIndexOf("## Status: needs-human-input");
  const afterDispute = commentsRaw.slice(disputeIdx);
  if (!afterDispute.includes("## Verdict: approve")) {
    die("ERROR: unresolved dispute (needs-human-input) — human must weigh in");
  }
}

// 4. Check mergeability — conflicts prevent CI from running, so check before CI gate
const mergeStateStatus = gh("pr", "view", prNum, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus").trim();

function routeConflict(): never {
  // Post a machine-parseable conflict verdict on the PR so /respond-to-pr-review
  // can find it via its standard verdict/findings parser. Issue status stays at
  // status/in-review — the stage/* label on the PR drives the review cycle.
  const conflictComment = [
    "## Verdict: needs-work",
    "",
    "## Findings",
    "```json",
    '[{"id":"F1","severity":"blocking","category":"rebase","description":"Branch has merge conflicts with main. Run `git fetch origin main && git rebase origin/main`, resolve all conflicts, and push.","files":[]}]',
    "```",
  ].join("\n");
  withTempFile(conflictComment, (p) => {
    gh("pr", "comment", prNum, "--body-file", p);
  });

  const prOut = gh("pr", "view", prNum, "--json", GH_FIELDS.PR, "--jq", JQ.PR);
  const prLabels = replaceLabel(parseLabels(prOut), "stage/", "stage/fixes-pr");
  ghSetLabels(prNum, prLabels);

  die(`REBASE_CONFLICT: PR #${prNum} has merge conflicts with main — conflict verdict posted, sent back to implementer`);
}

if (mergeStateStatus === "DIRTY") routeConflict();
if (mergeStateStatus === "BEHIND") {
  die(`REBASE: PR #${prNum} branch is behind main. Run: git fetch origin main && git rebase origin/main && git push --force-with-lease, then re-run node scripts/merge.ts ${prNum}`);
}

// 5. Check CI status (GitHub Actions uses check-runs API, not legacy statuses)
if (sha) {
  let ciResolved = false;

  // Try check-runs API first (GitHub Actions)
  const { ok: checkOk, output: checkOut } = ghSafe("api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq",
    `if .total_count == 0 then "CHECKS: none" else "CHECKS: \\(.check_runs | map(.conclusion // .status) | if all(. == "success") then "success" elif any(. == "in_progress" or . == "queued" or . == "pending") then "pending" else "failure" end) (\\(.total_count) runs)\\n\\(.check_runs[] | "  \\(.name): \\(.conclusion // .status)")" end`);

  if (checkOk && !checkOut.includes("CHECKS: none")) {
    ciResolved = true;
    if (checkOut.includes("CHECKS: pending")) die("ERROR: CI checks still running — wait and retry");
    if (checkOut.includes("CHECKS: failure")) {
      if (linkedIssueId) {
        const issueOut = gh("issue", "view", linkedIssueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
        const labels = parseLabels(issueOut);
        const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
        ghSetLabels(linkedIssueId, newLabels);
        withTempFile(`Merge blocked — CI checks failed on PR #${prNum}.`, (p) => {
          gh("issue", "comment", linkedIssueId, "--body-file", p);
        });
      }
      die(`ERROR: CI failed — issue flagged as blocked\n${checkOut}`);
    }
  }

  // Fall back to legacy commit status API (third-party CI tools)
  if (!ciResolved) {
    const { ok, output } = ghSafe("api", `repos/{owner}/{repo}/commits/${sha}/status`, "--jq", JQ.COMMIT_STATUS);
    if (ok) {
      if (output.includes("CI: pending")) die("ERROR: CI checks still running — wait and retry");
      if (output.includes("CI: failure") || output.includes("CI: error")) {
        if (linkedIssueId) {
          const issueOut = gh("issue", "view", linkedIssueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
          const labels = parseLabels(issueOut);
          const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
          ghSetLabels(linkedIssueId, newLabels);
          withTempFile(`Merge blocked — CI checks failed on PR #${prNum}.`, (p) => {
            gh("issue", "comment", linkedIssueId, "--body-file", p);
          });
        }
        die(`ERROR: CI failed — issue flagged as blocked\n${output}`);
      }
      if (output.includes("no status checks found")) {
        const hasVerify = comments.some(c => c.body.includes("OVERALL: pass") || c.body.includes("VERIFY: pass"));
        if (!hasVerify) die("ERROR: no CI checks and no /verify pass found — run /verify first");
      }
    }
  }
}

// 6. Merge
const { ok: mergeOk, output: mergeOut } = ghSafe("pr", "merge", prNum, "--squash", "--delete-branch");
if (!mergeOk) {
  // Route merge failures — mergeability was already checked in step 4,
  // but race conditions or GitHub API quirks can still surface conflicts here
  const err = mergeOut.toLowerCase();
  if (err.includes("conflict") || err.includes("dirty")) routeConflict();
  if (err.includes("not mergeable") || err.includes("try again")) {
    die(`REBASE: PR #${prNum} branch is behind main. Run: git fetch origin main && git rebase origin/main && git push --force-with-lease, then re-run node scripts/merge.ts ${prNum}`);
  }

  // Other failures: block the issue
  if (linkedIssueId) {
    const issueOut = gh("issue", "view", linkedIssueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
    const labels = parseLabels(issueOut);
    const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
    ghSetLabels(linkedIssueId, newLabels);
    withTempFile(`Merge failed on PR #${prNum}. ${mergeOut}`, (p) => {
      gh("issue", "comment", linkedIssueId, "--body-file", p);
    });
  }
  die(`ERROR: merge failed: ${mergeOut}`);
}

// 7. Update closing issues to status/done (before local cleanup — this is the critical side effect)
for (const issueId of closingIssueIds) {
  const issueOut = gh("issue", "view", issueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
  let labels = parseLabels(issueOut);
  labels = replaceLabel(labels, "status/", "status/done");
  labels = removeLabel(labels, "stage/"); // safety: remove any stale stage labels
  ghSetLabels(issueId, labels);
  ghSafe("issue", "close", issueId);
}

// 8. Update local repo
try {
  git("checkout", "main");
  git("pull", "origin", "main");
  if (headBranch) {
    try { git("branch", "-d", headBranch); } catch { /* already deleted or not local */ }
  }
} catch { /* local repo cleanup is best-effort — don't block on it */ }

const closedSummary = closingIssueIds.length > 0
  ? ` — ${closingIssueIds.map(id => `#${id}`).join(", ")} closed`
  : "";
console.log(`MERGED: PR #${prNum}${closedSummary}`);
