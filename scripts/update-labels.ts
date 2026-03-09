#!/usr/bin/env node
// Update labels on a Gitea issue using deterministic replaceLabel logic.
// Usage: node scripts/update-labels.ts <issue-id> --replace <prefix> <new-label> [--replace ...]
// Example: node scripts/update-labels.ts 269 --replace "stage/" "stage/review-pr"
// Output: Updated labels list, or error.

import { gitea, parseLabels, replaceLabel, removeLabel, die } from "./lib.ts";

const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith("--")) die("ERROR: usage: node scripts/update-labels.ts <issue-id> --replace <prefix> <new-label> [--remove <prefix>] ...");

// Parse operations
type Op = { type: "replace"; prefix: string; newLabel: string } | { type: "remove"; prefix: string };
const ops: Op[] = [];

let i = 1;
while (i < args.length) {
  if (args[i] === "--replace" && args[i + 1] && args[i + 2]) {
    ops.push({ type: "replace", prefix: args[i + 1], newLabel: args[i + 2] });
    i += 3;
  } else if (args[i] === "--remove" && args[i + 1]) {
    ops.push({ type: "remove", prefix: args[i + 1] });
    i += 2;
  } else {
    die(`ERROR: unknown arg: ${args[i]}`);
  }
}

if (ops.length === 0) die("ERROR: no operations specified");

// Read current labels
const issue = gitea("issue", id);
let labels = parseLabels(issue);

// Apply operations
for (const op of ops) {
  if (op.type === "replace") {
    labels = replaceLabel(labels, op.prefix, op.newLabel);
  } else {
    labels = removeLabel(labels, op.prefix);
  }
}

// Update
const result = gitea("issue-update", id, "labels", labels.join(","));
console.log(result);
