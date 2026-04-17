#!/usr/bin/env node
// Guard against self-review: exit non-zero if the authenticated identity is
// the PR author. Works under GitHub App installation tokens (where `gh api
// user` returns 403) and under personal auth.
//
// Usage: node scripts/check-self-review.ts <pr-author>
// Exits 0 with "OK: ..." if identities differ (safe to review).
// Exits 1 with "SELF-REVIEW: ..." or "ERROR: ..." otherwise.

import { getSelfIdentity, die } from "./lib.ts";

const prAuthor = process.argv[2];
if (!prAuthor) die("ERROR: usage: node scripts/check-self-review.ts <pr-author>");

let selfId: string;
try {
  selfId = getSelfIdentity();
} catch (error: unknown) {
  const err = error as { message?: string; stderr?: string };
  const detail = err.stderr?.toString().trim() || err.message || String(error);
  die(`ERROR: identity lookup failed: ${detail}`);
}

if (!selfId) die("ERROR: identity lookup returned empty string");

if (selfId === prAuthor) {
  die(`SELF-REVIEW: authenticated identity '${selfId}' matches PR author. Cannot self-review — run under a different identity.`);
}

console.log(`OK: '${selfId}' != '${prAuthor}'`);
