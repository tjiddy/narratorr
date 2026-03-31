---
scope: [backend]
files: [src/server/utils/import-helpers.ts]
issue: 237
date: 2026-03-31
---
When a recursive copy needs to validate cross-file constraints (like basename uniqueness), split into collect-then-act phases: first recursively enumerate all files, then validate the full set, then perform the mutations. This avoids partial state on validation failure and makes the validation logic trivially testable.
