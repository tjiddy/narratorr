#!/usr/bin/env node
// Post a review comment from the pre-written review.md file.
// Supports both PR reviews (--kind pr) and spec reviews (--kind spec).
// Guards against double-posting and premature posting (before analysis is complete).
// Usage: node scripts/post-review.ts <number> [--kind spec|pr] [--force]
//   --kind: "pr" (default) posts to a PR, "spec" posts to an issue
//   --force: bypass the posted-marker guard (used by the rebase-conflict path
//            to post a second needs-work verdict after an approve was already posted)
// Output: "POSTED: <comment-url>" on success, "ERROR: ..." on failure.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gh, withTempFile, die } from "./lib.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const num = process.argv[2];
if (!num) die("ERROR: usage: node scripts/post-review.ts <number> [--kind spec|pr] [--force]");
const force = process.argv.includes("--force");
const kindIdx = process.argv.indexOf("--kind");
const kind = kindIdx !== -1 ? process.argv[kindIdx + 1] : "pr";
if (kind !== "pr" && kind !== "spec") die("ERROR: --kind must be 'pr' or 'spec'");

const stateDir = join(root, ".narratorr", "state", `review-${kind}-${num}`);
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
  kind === "pr"
    ? gh("pr", "comment", num, "--body-file", tmpPath)
    : gh("issue", "comment", num, "--body-file", tmpPath),
);

// Write posted marker
writeFileSync(postedMarker, "done");

console.log(`POSTED: ${commentUrl}`);
