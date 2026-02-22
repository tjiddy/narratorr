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
  // Status (lifecycle)
  { name: "status/backlog", color: "ededed", description: "Not yet ready for work" },
  { name: "status/ready", color: "0e8a16", description: "Spec complete, ready to claim" },
  { name: "status/in-progress", color: "1d76db", description: "Actively being worked on" },
  { name: "status/blocked", color: "b60205", description: "Blocked, needs resolution" },
  { name: "status/done", color: "5319e7", description: "Completed and merged" },

  // Stage (pipeline)
  { name: "stage/dev", color: "c2e0c6", description: "In development" },
  { name: "stage/review", color: "bfd4f2", description: "In code review" },
  { name: "stage/qa", color: "d4c5f9", description: "In QA / testing" },

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
