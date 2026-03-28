---
scope: [backend]
files: [apps/narratorr/src/server/__tests__/notifier-events.e2e.test.ts]
issue: 184
source: review
date: 2026-02-22
---
`new Date(ts).getTime() !== NaN` is too loose for ISO string validation — it passes non-ISO date formats like "Feb 22 2026". Use `new Date(ts).toISOString() === ts` to verify round-trip ISO 8601 format. When the spec says "valid ISO string", assert the format, not just parseability.
