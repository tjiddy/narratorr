#!/usr/bin/env node
// Post a review comment to a PR from the pre-written review.md file.
// Guards against double-posting and premature posting (before analysis is complete).
// Usage: node scripts/post-review.ts <pr-number> [--force]
//   --force: bypass the posted-marker guard (used by the rebase-conflict path
//            to post a second needs-work verdict after an approve was already posted)
// Output: "POSTED: <comment-url>" on success, "ERROR: ..." on failure.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gh, withTempFile, die } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const prNum = process.argv[2];
if (!prNum) die("ERROR: usage: node scripts/post-review.ts <pr-number> [--force]");
const force = process.argv.includes("--force");

const stateDir = join(root, ".narratorr", "state", `review-pr-${prNum}`);
const reviewPath = join(stateDir, "review.md");
const reviewCompleteMarker = join(stateDir, "review-complete");
const postedMarker = join(stateDir, "posted");

// Guard: state directory must exist
if (!existsSync(stateDir)) die(`ERROR: state directory not found: ${stateDir}`);

// Guard: review-complete marker must exist (analysis must finish before posting)
if (!existsSync(reviewCompleteMarker)) die("ERROR: review not complete — review-complete marker is missing");

// Guard: review.md must exist
if (!existsSync(reviewPath)) die("ERROR: review.md not found — nothing to post");

// Guard: posted marker must NOT exist (prevents double-post) — unless --force
if (!force && existsSync(postedMarker)) die("ERROR: already posted — posted marker exists (use --force to override)");

// Post the review comment
const body = readFileSync(reviewPath, "utf-8");
const commentUrl = withTempFile(body, (tmpPath) =>
  gh("pr", "comment", prNum, "--body-file", tmpPath),
);

// Write posted marker
writeFileSync(postedMarker, "done");

console.log(`POSTED: ${commentUrl}`);
