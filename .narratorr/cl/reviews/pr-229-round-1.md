---
skill: respond-to-pr-review
issue: 229
pr: 233
round: 1
date: 2026-03-30
fixed_findings: [F1, F2, F3]
---

### F1: Missing originalPath in resolved-save-path debug log
**What was caught:** The log omitted `originalPath` despite the AC requiring `{ downloadId, resolvedPath, originalPath }`.
**Why I missed it:** When `download.savePath` failed typecheck, I dropped the field entirely instead of investigating the correct source. The self-review checked that `resolvedPath` was present but didn't cross-check against the AC's full field list.
**Prompt fix:** Add to `/implement` step 4 general rules: "When a log field from the AC fails typecheck or doesn't exist on the obvious object, trace the data origin — the field may need to come from a different source (function return value, lookup, computed value). Never silently drop an AC-required field."

### F2: clientType instead of clientName in download log
**What was caught:** Used `clientType` (adapter type like "qbittorrent") instead of `clientName` (instance name like "qBit") in the download success log.
**Why I missed it:** The `sendToClient` return value had `clientType` readily available, and I used it without checking the AC's exact field name. The AC says `clientName` — a different semantic.
**Prompt fix:** Add to `/implement` step 4 general rules: "For log field ACs, match field names exactly — `clientType` is not `clientName`, `provider` is not `providerName`. If the data source doesn't expose the required field, modify the source to return it."

### F3: Missing clientType in torrent-removal log
**What was caught:** The torrent-removal log included `externalId` and `deleteFiles` but omitted `clientType` because `getAdapter()` doesn't return client metadata.
**Why I missed it:** I only logged data that was already in scope at the log site. Didn't check if a lookup was needed for the missing field.
**Prompt fix:** Add to `/handoff` step 2 self-review: "For each log statement added, verify every AC-required field is present in the assertion — not just 'some fields match'. Cross-check the AC field list against the actual `expect.objectContaining({})` call."
