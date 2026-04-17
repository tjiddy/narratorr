---
scope: [infra]
files: [e2e/global-setup.ts, e2e/playwright.config.ts]
issue: 616
source: review
date: 2026-04-17
---
When introducing a file-based state handoff in the E2E harness, the file must live inside a per-run temp directory (e.g., configPath) — not at a repo-global location. The harness's design contract (temp-dirs.ts:25) explicitly avoids shared state files to prevent concurrent-run collisions. To make per-run state available to workers: set `process.env.E2E_RUN_STATE_DIR` at config-load time in playwright.config.ts (config-time env vars propagate to workers), then read the state file from that directory. This pattern preserves isolation while solving the worker-env-propagation problem.
