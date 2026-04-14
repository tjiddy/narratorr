---
scope: [backend]
files: [src/server/services/discovery.service.ts]
issue: 554
date: 2026-04-14
---
Drizzle's `onConflictDoUpdate` supports `sql` template literals in the `set` clause, enabling CASE/WHEN conditional updates per-row. This allows a single INSERT ON CONFLICT statement to handle both snooze-preserving and full-field updates, avoiding the need for separate UPDATE statements. The key pattern: `reason: sql\`CASE WHEN ${suggestions.snoozeUntil} IS NOT NULL THEN ${suggestions.reason} ELSE excluded.reason END\``.
