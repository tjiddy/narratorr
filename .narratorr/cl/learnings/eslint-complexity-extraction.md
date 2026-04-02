---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 299
date: 2026-04-02
---
ESLint cyclomatic complexity limit (≤15) is easily hit when a method has nested try/catch + if/else for error isolation. Extract per-item processing into a private helper method, and further extract each side-effect category (adapter removal, filesystem deletion) into their own methods that return success/failure booleans. This keeps the orchestration logic clean and each method under the threshold.
