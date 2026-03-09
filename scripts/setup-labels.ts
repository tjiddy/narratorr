#!/usr/bin/env node
// Creates all workflow labels in a Gitea repo.
// Usage: node setup-labels.ts
//
// Reads GITEA_URL, GITEA_TOKEN, GITEA_OWNER, GITEA_REPO from
// environment variables or .env file in the current working directory.

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const giteaCli = resolve(__dirname, "gitea.ts");

const labels: Array<{ name: string; color: string; description: string }> = [
  // Status (lifecycle — exclusive, one at a time on issue)
  { name: "status/backlog", color: "ededed", description: "Not yet ready for work" },
  { name: "status/review-spec", color: "7c4dff", description: "Spec under review" },
  { name: "status/fixes-spec", color: "ea80fc", description: "Spec needs fixes from review" },
  { name: "status/ready-for-dev", color: "00c853", description: "Spec approved, ready for implementation" },
  { name: "status/in-progress", color: "1d76db", description: "Actively being worked on" },
  { name: "status/in-review", color: "ff6d00", description: "PR exists, waiting on reviewer" },
  { name: "status/done", color: "5319e7", description: "Completed and merged" },

  // Stage (pipeline — exclusive, one at a time on PR)
  { name: "stage/review-pr", color: "ff6d00", description: "PR under review" },
  { name: "stage/fixes-pr", color: "ff9100", description: "PR needs fixes from review" },
  { name: "stage/approved", color: "00e676", description: "PR approved, ready to merge" },

  // Standalone flags (additive, not exclusive)
  { name: "blocked", color: "b60205", description: "Blocked, needs resolution" },
  { name: "yolo", color: "5c007b", description: "Automate this!" },

  // Type
  { name: "type/feature", color: "0075ca", description: "New feature" },
  { name: "type/bug", color: "d73a4a", description: "Bug fix" },
  { name: "type/chore", color: "fef2c0", description: "Maintenance / cleanup" },

  // Priority
  { name: "priority/high", color: "b60205", description: "High priority" },
  { name: "priority/medium", color: "fbca04", description: "Medium priority" },
  { name: "priority/low", color: "0e8a16", description: "Low priority" },
];

console.log("Creating workflow labels...\n");

let created = 0;
let failed = 0;

for (const label of labels) {
  try {
    execFileSync("node", [giteaCli, "label-create", label.name, label.color, label.description], {
      stdio: "pipe",
      cwd: process.cwd(),
    });
    console.log(`  + ${label.name}`);
    created++;
  } catch (e: unknown) {
    const msg = e instanceof Error && "stderr" in e ? (e as { stderr: Buffer }).stderr?.toString().trim() : String(e);
    // Gitea returns 409 if label already exists
    if (msg.includes("409")) {
      console.log(`  ~ ${label.name} (already exists)`);
    } else {
      console.log(`  x ${label.name} — ${msg}`);
      failed++;
    }
  }
}

console.log(`\nDone: ${created} created, ${labels.length - created - failed} skipped, ${failed} failed`);
if (failed > 0) process.exit(1);
