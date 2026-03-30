---
scope: [backend]
files: [src/server/utils/paths.ts]
issue: 231
date: 2026-03-30
---
Conditional spread `...(condition && { key: value })` is the cleanest pattern for optional token injection in token maps. When the condition is false, the spread evaluates to `...false` which adds nothing. This mirrors the existing `isSingleFile` pattern in `tagging.service.ts:307-324`. The naming pipeline (`renderFilename` → `resolveTokens`) handles missing tokens by returning empty strings, and `sanitizePath` normalizes fully-empty stems to `Unknown` — so omitting tokens is safe as long as the template has at least one non-track token.
