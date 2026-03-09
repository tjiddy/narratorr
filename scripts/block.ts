#!/usr/bin/env node
// Mark a Gitea issue as blocked with a reason.
// Usage: node scripts/block.ts <issue-id> <reason>
// Output: "BLOCKED: #<id>" on success, error otherwise.

import { gitea, parseLabels, withTempFile, die } from "./lib.ts";

const id = process.argv[2];
const reason = process.argv.slice(3).join(" ");
if (!id || !reason) die("ERROR: usage: node scripts/block.ts <issue-id> <reason>");

// 1. Read issue
const issue = gitea("issue", id);
const labels = parseLabels(issue);

// 2. Post BLOCKED comment
const comment = `**BLOCKED — need input**\n\n${reason}`;
withTempFile(comment, (path) => {
  gitea("issue-comment", id, "--body-file", path);
});

// 3. Add blocked flag without changing status
const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
gitea("issue-update", id, "labels", newLabels.join(","));

console.log(`BLOCKED: #${id}`);
