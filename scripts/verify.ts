#!/usr/bin/env node
// Quality gates: lint → test+coverage → typecheck → build
// Usage: node scripts/verify.ts
// Output: "VERIFY: pass" on success, structured failures otherwise.

import { readFileSync, existsSync } from "node:fs";
import { run, git, firstLines, runDiffLintGate } from "./lib.ts";

interface Gate { name: string; result: string }
const gates: Gate[] = [];
let failed = false;

function addGate(name: string, result: string, ok: boolean) {
  gates.push({ name, result });
  if (!ok) failed = true;
}

// --- Lint (diff against main to ignore pre-existing violations) ---
let lintHandled = false;
try {
  const result = runDiffLintGate(git, run);
  if (result.handled) {
    if (result.newViolations.length === 0) {
      addGate("LINT", "pass", true);
    } else {
      const details = result.newViolations
        .map(v => `  ${v.file}:${v.line}:${v.column} ${v.rule} ${v.message}`)
        .slice(0, 10)
        .join("\n");
      addGate("LINT", `fail (${result.newViolations.length} new violations)\n${details}`, false);
    }
    lintHandled = true;
  }
} catch {
  // merge-base or JSON parse failed — fall back to full lint
}

if (!lintHandled) {
  // Fallback: full lint (on main branch or if diff approach failed)
  const lint = run("pnpm lint");
  if (lint.ok) {
    addGate("LINT", "pass", true);
  } else {
    const errors = firstLines(lint.stdout || lint.stderr, 5);
    addGate("LINT", `fail\n${errors}`, false);
  }
}

// --- Test + Coverage ---
if (!failed) {
  const test = run("pnpm exec vitest run --no-color --coverage --coverage.reporter=json-summary");
  const combined = [test.stdout, test.stderr].filter(Boolean).join("\n");
  if (test.ok) {
    const filesMatch = combined.match(/Test Files\s+(\d+)\s+passed/);
    const testsMatch = combined.match(/Tests\s+(\d+)\s+passed/);
    const suites = filesMatch?.[1] ?? "?";
    const tests = testsMatch?.[1] ?? "?";
    addGate("TEST", `pass (${suites} suites, ${tests} tests)`, true);
  } else {
    const failMatch = combined.match(/Tests\s+(\d+)\s+failed/);
    const failedLines = combined.split("\n")
      .filter(l => /^\s*FAIL\s/.test(l))
      .map(l => l.trim())
      .slice(0, 10);
    addGate("TEST", `fail (${failMatch?.[1] ?? "?"} failed)${failedLines.length ? "\n" + failedLines.join("\n") : ""}`, false);
  }
} else {
  addGate("TEST", "skipped", true);
}

// --- Typecheck ---
if (!failed) {
  const tc = run("pnpm typecheck");
  if (tc.ok) {
    addGate("TYPECHECK", "pass", true);
  } else {
    const errors = firstLines(tc.stdout || tc.stderr, 5);
    addGate("TYPECHECK", `fail\n${errors}`, false);
  }
} else {
  addGate("TYPECHECK", "skipped", true);
}

// --- Build ---
if (!failed) {
  const build = run("pnpm build");
  if (build.ok) {
    addGate("BUILD", "pass", true);
  } else {
    const errors = firstLines(build.stdout || build.stderr, 5);
    addGate("BUILD", `fail\n${errors}`, false);
  }
} else {
  addGate("BUILD", "skipped", true);
}

// --- Coverage analysis (only if all gates passed) ---
if (!failed) {
  const coveragePath = "coverage/coverage-summary.json";
  if (existsSync(coveragePath)) {
    try {
      const mergeBase = git("merge-base", "HEAD", "main");
      const changedRaw = git("diff", "--name-only", "--diff-filter=ACMR", `${mergeBase}..HEAD`);
      // Exclude test files, config files, scripts, and side-effect entry points
      // (entry points execute main()/render at import — untestable in isolation)
      const ENTRY_POINTS = new Set(["src/server/index.ts", "src/client/main.tsx"]);
      const changedFiles = changedRaw.split("\n").filter(f =>
        /\.(ts|tsx|js|jsx)$/.test(f) && !/\.(test|spec)\./i.test(f) && !f.includes("config") && !f.startsWith("scripts/") && !ENTRY_POINTS.has(f)
      );

      if (changedFiles.length > 0) {
        const coverage = JSON.parse(readFileSync(coveragePath, "utf-8"));
        const lowCoverage: string[] = [];

        for (const file of changedFiles) {
          // Coverage JSON uses absolute paths — try matching by suffix
          const entry = Object.keys(coverage).find(k => k.endsWith(file) || k.endsWith(file.replace(/\//g, "\\")));
          if (!entry) continue; // not in coverage data (may be untestable config)
          const pct = coverage[entry]?.lines?.pct ?? 0;
          if (pct <= 5) lowCoverage.push(`${file} (${pct}%)`);
        }

        if (lowCoverage.length > 0) {
          addGate("COVERAGE", `fail — ${lowCoverage.length} files ≤5%:\n  ${lowCoverage.join("\n  ")}`, false);
        } else {
          addGate("COVERAGE", "pass", true);
        }
      } else {
        addGate("COVERAGE", "pass (no changed source files)", true);
      }
    } catch {
      addGate("COVERAGE", "skip (could not analyze)", true);
    }
  } else {
    addGate("COVERAGE", "skip (no coverage data)", true);
  }
} else {
  addGate("COVERAGE", "skipped", true);
}

// --- Output ---
if (!failed) {
  // Sparse success — one line
  const testGate = gates.find(g => g.name === "TEST");
  console.log(`VERIFY: pass ${testGate?.result.match(/\(.+\)/)?.[0] ?? ""}`);
} else {
  // Show only failing gates with details
  console.log("VERIFY: fail");
  for (const g of gates) {
    if (g.result !== "pass" && g.result !== "skipped" && !g.result.startsWith("pass")) {
      console.log(`${g.name}: ${g.result}`);
    }
  }
}

process.exit(failed ? 1 : 0);
