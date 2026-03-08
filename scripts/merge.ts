#!/usr/bin/env node
// Merge an approved PR: check approval, CI, merge, cleanup, update issue.
// Usage: node scripts/merge.ts <pr-number>
// Output: "MERGED: PR #<n> — #<id> closed" on success, error otherwise.

import {
  gitea, giteaSafe, git, parseLabels, replaceLabel, removeLabel,
  parseLinkedIssue, parseAuthor, parseSha, parseState, parseHeadBranch,
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
const issueId = parseLinkedIssue(pr);

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
      // Set issue to blocked
      if (issueId) {
        const issueOut = gitea("issue", issueId);
        const labels = replaceLabel(parseLabels(issueOut), "status/", "status/blocked");
        gitea("issue-update", issueId, "labels", labels.join(","));
        withTempFile(`Merge blocked — CI checks failed on PR #${prNum}.`, (p) => {
          gitea("issue-comment", issueId, "--body-file", p);
        });
      }
      die(`ERROR: CI failed — issue set to status/blocked\n${output}`);
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
  const errorType = err.includes("conflict") ? "merge conflict" : err.includes("status check") ? "CI failure" : "unknown error";

  if (issueId) {
    const issueOut = gitea("issue", issueId);
    const labels = parseLabels(issueOut);
    let newLabels: string[];
    if (errorType === "merge conflict") {
      newLabels = replaceLabel(labels, "stage/", "stage/fixes-pr");
    } else {
      newLabels = replaceLabel(labels, "status/", "status/blocked");
    }
    gitea("issue-update", issueId, "labels", newLabels.join(","));
    withTempFile(`Merge failed on PR #${prNum} — ${errorType}. ${mergeOut}`, (p) => {
      gitea("issue-comment", issueId, "--body-file", p);
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

// 7. Update issue
if (issueId) {
  const issueOut = gitea("issue", issueId);
  let labels = parseLabels(issueOut);
  labels = replaceLabel(labels, "status/", "status/done");
  labels = removeLabel(labels, "stage/");
  gitea("issue-update", issueId, "labels", labels.join(","));
  giteaSafe("issue-update", issueId, "state", "closed");
}

console.log(`MERGED: PR #${prNum}${issueId ? ` — #${issueId} closed` : ""}`);
