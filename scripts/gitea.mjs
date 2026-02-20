#!/usr/bin/env node
// Resolves and runs the gitea-workflow plugin CLI regardless of installed version.
// This proxy exists so multiple agents (main + PR reviewer) can share the same
// plugin but use different Gitea API keys via the project's .env file.
import { readdirSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";

const base = join(
  process.env.USERPROFILE || process.env.HOME,
  ".claude/plugins/cache/tjiddy-plugins/gitea-workflow"
);

const versions = readdirSync(base).sort((a, b) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
});
const version = versions[versions.length - 1];
if (!version) {
  console.error("gitea-workflow plugin not found. Install: claude plugin install gitea-workflow");
  process.exit(1);
}

execFileSync("node", [join(base, version, "scripts/gitea.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
