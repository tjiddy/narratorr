#!/usr/bin/env node
// Update labels on a GitHub issue or PR using deterministic replaceLabel logic.
// Usage: node scripts/update-labels.ts <id> [--pr] --replace <prefix> <new-label> [--replace ...]
// Example: node scripts/update-labels.ts 269 --replace "stage/" "stage/review-pr"
// Example: node scripts/update-labels.ts 42 --pr --replace "stage/" "stage/approved"
// Output: Updated labels list, or error.

import { gh, ghSetLabels, parseLabels, replaceLabel, removeLabel, die, JQ, GH_FIELDS } from "./lib.ts";

const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith("--")) die("ERROR: usage: node scripts/update-labels.ts <id> [--pr] --replace <prefix> <new-label> [--remove <prefix>] ...");

// Parse flags and operations
type Op = { type: "replace"; prefix: string; newLabel: string } | { type: "remove"; prefix: string };
const ops: Op[] = [];
let isPR = false;

let i = 1;
while (i < args.length) {
  if (args[i] === "--pr") {
    isPR = true;
    i += 1;
  } else if (args[i] === "--replace" && args[i + 1] && args[i + 2]) {
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

// Read current labels (issue or PR)
const entity = isPR
  ? gh("pr", "view", id, "--json", GH_FIELDS.PR, "--jq", JQ.PR)
  : gh("issue", "view", id, "--json", GH_FIELDS.ISSUE, "--jq", JQ.ISSUE);
let labels = parseLabels(entity);

// Apply operations
for (const op of ops) {
  if (op.type === "replace") {
    labels = replaceLabel(labels, op.prefix, op.newLabel);
  } else {
    labels = removeLabel(labels, op.prefix);
  }
}

// Update — ghSetLabels works for both issues and PRs (same GitHub API endpoint)
const result = ghSetLabels(id, labels);
console.log(result);
