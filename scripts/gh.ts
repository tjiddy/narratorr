// Thin CLI wrapper around lib.ts's gh() — drop-in replacement for bare `gh`.
// Handles GitHub App token minting/refresh automatically.
// Usage: node scripts/gh.ts issue view 123 --json title

import { gh } from "./lib.ts";

try {
  const output = gh(...process.argv.slice(2));
  if (output) console.log(output);
} catch (error: unknown) {
  const err = error as { stderr?: string; stdout?: string; status?: number };
  if (err.stderr) process.stderr.write(err.stderr);
  process.exit(typeof err.status === "number" ? err.status : 1);
}
