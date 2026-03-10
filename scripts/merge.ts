#!/usr/bin/env node
// Merge an approved PR: check approval, CI, merge, cleanup, update issue.
// Usage: node scripts/merge.ts <pr-number>
// Output: "MERGED: PR #<n> — #<id> closed" on success, error otherwise.

import {
  gitea, giteaSafe, git, parseLabels, replaceLabel, removeLabel,
  parseLinkedIssue, parseClosingIssues, parseAuthor, parseSha, parseState, parseHeadBranch,
  parseComments, withTempFile, die,
} from "./lib.ts";

const prNum = process.argv[2];
if (!prNum) die("ERROR: usage: node scripts/merge.ts <pr-number>");

// 1. Fetch PR
const pr = gitea("pr", prNum);
const state = parseState(pr);
if (state !== "open") die(`ERROR: PR #${prNum} is not open (state: ${state})`);

const prAuthor = parseAuthor(pr);
const sha = parseSha(pr);
const headBranch = parseHeadBranch(pr);
const linkedIssueId = parseLinkedIssue(pr);
const closingIssueIds = parseClosingIssues(pr);

// 2. Check approval — find latest verdict from a non-author user
const commentsRaw = gitea("pr-comments", prNum);
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

// 4. Check CI status
if (sha) {
  const { ok, output } = giteaSafe("commit-status", sha);
  if (ok) {
    if (output.includes("CI: pending")) die("ERROR: CI checks still running — wait and retry");
    if (output.includes("CI: failure") || output.includes("CI: error")) {
      // Add blocked flag to linked issue (don't change status)
      if (linkedIssueId) {
        const issueOut = gitea("issue", linkedIssueId);
        const labels = parseLabels(issueOut);
        const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
        gitea("issue-update", linkedIssueId, "labels", newLabels.join(","));
        withTempFile(`Merge blocked — CI checks failed on PR #${prNum}.`, (p) => {
          gitea("issue-comment", linkedIssueId, "--body-file", p);
        });
      }
      die(`ERROR: CI failed — issue flagged as blocked\n${output}`);
    }
    // CI: success or no status checks → proceed
    if (output.includes("no status checks found")) {
      // Check for recent /verify pass in PR comments
      const hasVerify = comments.some(c => c.body.includes("OVERALL: pass") || c.body.includes("VERIFY: pass"));
      if (!hasVerify) die("ERROR: no CI checks and no /verify pass found — run /verify first");
    }
  }
}

// 5. Merge
const { ok: mergeOk, output: mergeOut } = giteaSafe("pr-merge", prNum);
if (!mergeOk) {
  // Route merge failures
  const err = mergeOut.toLowerCase();
  const errorType = err.includes("conflict") ? "merge conflict"
    : err.includes("status check") ? "CI failure"
    : (err.includes("405") || err.includes("please try again")) ? "branch behind base"
    : "unknown error";

  // Branch behind base: recoverable — caller should try a clean rebase
  if (errorType === "branch behind base") {
    die(`REBASE: PR #${prNum} branch is behind main. Run: git fetch origin main && git rebase origin/main && git push --force-with-lease, then re-run node scripts/merge.ts ${prNum}`);
  }

  // Merge conflict or branch behind with conflicts: send back to implementer
  if (errorType === "merge conflict") {
    const prOut = gitea("pr", prNum);
    const prLabels = replaceLabel(parseLabels(prOut), "stage/", "stage/fixes-pr");
    gitea("pr-update-labels", prNum, prLabels.join(","));

    if (linkedIssueId) {
      const issueOut = gitea("issue", linkedIssueId);
      const newLabels = replaceLabel(parseLabels(issueOut), "status/", "status/in-progress");
      gitea("issue-update", linkedIssueId, "labels", newLabels.join(","));
      withTempFile(
        `**Rebase needed** — PR #${prNum} has merge conflicts with main. Rebase onto main, resolve conflicts, push, and set \`stage/review-pr\` for a lightweight re-review.`,
        (p) => { gitea("issue-comment", linkedIssueId, "--body-file", p); }
      );
    }
    die(`REBASE_CONFLICT: PR #${prNum} has merge conflicts with main — sent back to implementer`);
  }

  // Other failures: block the issue
  if (linkedIssueId) {
    const issueOut = gitea("issue", linkedIssueId);
    const labels = parseLabels(issueOut);
    const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
    gitea("issue-update", linkedIssueId, "labels", newLabels.join(","));
    withTempFile(`Merge failed on PR #${prNum} — ${errorType}. ${mergeOut}`, (p) => {
      gitea("issue-comment", linkedIssueId, "--body-file", p);
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
  const issueOut = gitea("issue", issueId);
  let labels = parseLabels(issueOut);
  labels = replaceLabel(labels, "status/", "status/done");
  labels = removeLabel(labels, "stage/"); // safety: remove any stale stage labels
  gitea("issue-update", issueId, "labels", labels.join(","));
  giteaSafe("issue-update", issueId, "state", "closed");
}

const closedSummary = closingIssueIds.length > 0
  ? ` — ${closingIssueIds.map(id => `#${id}`).join(", ")} closed`
  : "";
console.log(`MERGED: PR #${prNum}${closedSummary}`);
