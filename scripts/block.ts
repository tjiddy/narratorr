#!/usr/bin/env node
// Mark a GitHub issue as blocked with a reason.
// Usage: node scripts/block.ts <issue-id> <reason>
// Output: "BLOCKED: #<id>" on success, error otherwise.

import { gh, ghSetLabels, parseLabels, withTempFile, die, JQ, GH_FIELDS } from "./lib.ts";

const id = process.argv[2];
const reason = process.argv.slice(3).join(" ");
if (!id || !reason) die("ERROR: usage: node scripts/block.ts <issue-id> <reason>");

// 1. Read issue
const issue = gh("issue", "view", id, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
const labels = parseLabels(issue);

// 2. Post BLOCKED comment
const comment = `**BLOCKED — need input**\n\n${reason}`;
withTempFile(comment, (path) => {
  gh("issue", "comment", id, "--body-file", path);
});

// 3. Add blocked flag without changing status
const newLabels = labels.includes("blocked") ? labels : [...labels, "blocked"];
ghSetLabels(id, newLabels);

console.log(`BLOCKED: #${id}`);
