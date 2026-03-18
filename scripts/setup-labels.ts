#!/usr/bin/env node
// Creates all workflow labels in a GitHub repo.
// Usage: node setup-labels.ts
//
// Uses `gh` CLI (authenticated via gh auth login or GH_TOKEN env var).

import { gh } from "./lib.ts";

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
  { name: "automate", color: "5c007b", description: "Automate this!" },

  // Type
  { name: "type/feature", color: "0075ca", description: "New feature" },
  { name: "type/bug", color: "d73a4a", description: "Bug fix" },
  { name: "type/chore", color: "fef2c0", description: "Maintenance / cleanup" },

  // Priority
  { name: "priority/high", color: "b60205", description: "High priority" },
  { name: "priority/medium", color: "fbca04", description: "Medium priority" },
  { name: "priority/low", color: "0e8a16", description: "Low priority" },

  // Scope
  { name: "scope/backend", color: "c5def5", description: "Backend changes" },
  { name: "scope/frontend", color: "bfdadc", description: "Frontend changes" },
  { name: "scope/services", color: "d4c5f9", description: "Service layer changes" },
  { name: "scope/core", color: "f9d0c4", description: "Core adapters" },
  { name: "scope/infra", color: "e6e6e6", description: "Infrastructure / CI / Docker" },
];

console.log("Creating workflow labels...\n");

let created = 0;
let failed = 0;

for (const label of labels) {
  try {
    // --force creates or updates if the label already exists
    gh("label", "create", label.name, "--color", label.color, "--description", label.description, "--force");
    console.log(`  + ${label.name}`);
    created++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  x ${label.name} — ${msg}`);
    failed++;
  }
}

console.log(`\nDone: ${created} created/updated, ${failed} failed`);
if (failed > 0) process.exit(1);
