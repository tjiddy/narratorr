#!/usr/bin/env node
// Merge an approved PR: check approval, CI, merge, cleanup, update issue.
// Usage: node scripts/merge.ts <pr-number>
// Output: "MERGED: PR #<n> — #<id> closed" on success, error otherwise.

import {
  gh, ghSafe, ghSetLabels, git, parseLabels, replaceLabel, removeLabel,
  parseLinkedIssue, parseClosingIssues, parseAuthor, parseSha, parseState, parseHeadBranch,
  parseComments, withTempFile, die, JQ, GH_FIELDS,
} from "./lib.ts";

const prNum = process.argv[2];
if (!prNum) die("ERROR: usage: node scripts/merge.ts <pr-number>");

// 1. Fetch PR
const pr = gh("pr", "view", prNum, "--json", GH_FIELDS.PR, "--jq", JQ.PR);
const state = parseState(pr);
if (state !== "open") die(`ERROR: PR #${prNum} is not open (state: ${state})`);

const prAuthor = parseAuthor(pr);
const sha = parseSha(pr);
const headBranch = parseHeadBranch(pr);
const linkedIssueId = parseLinkedIssue(pr);
const closingIssueIds = parseClosingIssues(pr);

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

// 4. Check CI status (GitHub Actions uses check-runs API, not legacy statuses)
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

// 5. Merge
const { ok: mergeOk, output: mergeOut } = ghSafe("pr", "merge", prNum, "--squash", "--delete-branch");
if (!mergeOk) {
  // Route merge failures
  const err = mergeOut.toLowerCase();
  const errorType = err.includes("conflict") ? "merge conflict"
    : err.includes("status check") ? "CI failure"
    : (err.includes("not mergeable") || err.includes("try again")) ? "branch behind base"
    : "unknown error";

  // Branch behind base: recoverable — caller should try a clean rebase
  if (errorType === "branch behind base") {
    die(`REBASE: PR #${prNum} branch is behind main. Run: git fetch origin main && git rebase origin/main && git push --force-with-lease, then re-run node scripts/merge.ts ${prNum}`);
  }

  // Merge conflict or branch behind with conflicts: send back to implementer
  if (errorType === "merge conflict") {
    const prOut = gh("pr", "view", prNum, "--json", GH_FIELDS.PR, "--jq", JQ.PR);
    const prLabels = replaceLabel(parseLabels(prOut), "stage/", "stage/fixes-pr");
    ghSetLabels(prNum, prLabels);

    if (linkedIssueId) {
      const issueOut = gh("issue", "view", linkedIssueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
      const newLabels = replaceLabel(parseLabels(issueOut), "status/", "status/in-progress");
      ghSetLabels(linkedIssueId, newLabels);
      withTempFile(
        `**Rebase needed** — PR #${prNum} has merge conflicts with main. Rebase onto main, resolve conflicts, push, and set \`stage/review-pr\` for a lightweight re-review.`,
        (p) => { gh("issue", "comment", linkedIssueId, "--body-file", p); }
      );
    }
    die(`REBASE_CONFLICT: PR #${prNum} has merge conflicts with main — sent back to implementer`);
  }

  // Other failures: block the issue
  if (linkedIssueId) {
    const issueOut = gh("issue", "view", linkedIssueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
    const labels = parseLabels(issueOut);
    const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
    ghSetLabels(linkedIssueId, newLabels);
    withTempFile(`Merge failed on PR #${prNum} — ${errorType}. ${mergeOut}`, (p) => {
      gh("issue", "comment", linkedIssueId, "--body-file", p);
    });
  }
  die(`ERROR: merge failed (${errorType}): ${mergeOut}`);
}

// 6. Update local repo
git("checkout", "main");
git("pull", "origin", "main");
if (headBranch) {
  try { git("branch", "-d", headBranch); } catch { /* already deleted or not local */ }
}

// 7. Update closing issues to status/done
for (const issueId of closingIssueIds) {
  const issueOut = gh("issue", "view", issueId, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
  let labels = parseLabels(issueOut);
  labels = replaceLabel(labels, "status/", "status/done");
  labels = removeLabel(labels, "stage/"); // safety: remove any stale stage labels
  ghSetLabels(issueId, labels);
  ghSafe("issue", "close", issueId);
}

const closedSummary = closingIssueIds.length > 0
  ? ` — ${closingIssueIds.map(id => `#${id}`).join(", ")} closed`
  : "";
console.log(`MERGED: PR #${prNum}${closedSummary}`);
