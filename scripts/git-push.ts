#!/usr/bin/env node
// Token-aware git push wrapper for skills.
// Usage: node scripts/git-push.ts <git-push-args>
// Falls back to regular git push when no GitHub App credentials configured.

import { gitPush } from "./lib.ts";

const args = process.argv.slice(2);
try {
  const output = gitPush(...args);
  if (output) console.log(output);
} catch (e: unknown) {
  const err = e as { stderr?: string; message?: string };
  console.error(err.stderr || err.message || "git push failed");
  process.exit(1);
}
