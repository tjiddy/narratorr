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

const version = readdirSync(base)[0];
if (!version) {
  console.error("gitea-workflow plugin not found. Install: claude plugin install gitea-workflow");
  process.exit(1);
}

execFileSync("node", [join(base, version, "scripts/gitea.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
