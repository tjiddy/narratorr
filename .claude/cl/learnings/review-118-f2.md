---
scope: [core]
files: [packages/core/src/utils/parse.ts]
issue: 118
source: review
date: 2026-02-23
---
The parser's `stripSceneSuffix` stripped standalone format tokens (`MP3`, `M4B`) without brackets, leaving `[` and `]` behind when the token was bracketed (e.g., `[MP3]` → `[]`). The fix was updating the regex to optionally match surrounding brackets: `[[(]?(?:MP3|...)[)\]]?`. When stripping tokens that can appear both standalone and bracketed, always account for both forms in the regex.
