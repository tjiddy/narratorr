---
scope: [backend]
files: [src/server/utils/enrich-usenet-languages.ts]
issue: 502
source: review
date: 2026-04-12
---
The original pre-#502 design deliberately short-circuited NZB fetch when newsgroup was present (comment: "Do not fall back to NZB fetch — same source"). The spec didn't explicitly call out changing this behavior — it focused on *parsing* the NZB name and *using* it for filtering, but didn't flag that the existing short-circuit would prevent the NZB from ever being fetched in the exact scenario described in the issue evidence. The spec review caught the caller surface gap but missed the short-circuit within `enrichUsenetLanguages` itself. Future specs should trace the full data flow from the triggering scenario to the new code path, not just the new functions being added.
