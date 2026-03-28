---
scope: [infra]
files: [vitest.config.ts, scripts/verify.ts]
issue: 284
date: 2026-03-09
---
V8 coverage provider includes ALL files loaded during test execution in the JSON summary, even if they're in the vitest `coverage.exclude` list. The exclude only affects the report display, not the JSON output. If your verify script reads the JSON directly, you need a separate exclusion mechanism (we added an ENTRY_POINTS set to verify.ts).
