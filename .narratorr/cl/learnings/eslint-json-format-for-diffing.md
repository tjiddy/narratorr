---
scope: [infra]
files: [scripts/verify.ts, scripts/lib.ts]
issue: 353
date: 2026-03-15
---
ESLint `--format json` produces structured output with filePath, messages[].ruleId/line/column/message/severity per file. This enables violation-level diffing between branches. Windows paths use backslashes in ESLint output and must be normalized to forward slashes before tuple comparison, otherwise the same file appears as two different violations.
