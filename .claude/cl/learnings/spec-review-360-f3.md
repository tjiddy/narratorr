---
scope: [scope/backend]
files: [src/shared/indexer-registry.ts, src/shared/download-client-registry.ts, src/shared/import-list-registry.ts, src/shared/notifier-registry.ts]
issue: 360
source: spec-review
date: 2026-03-14
---
AC8 only named 2 of 4 registry files that share the duplicated `RequiredField` + metadata type pattern. The reviewer found `import-list-registry.ts` and `notifier-registry.ts` have the same structure. Root cause: the original debt scan finding (L-22) said "duplicated 4 times" but the /elaborate skill only verified two files. When a finding says "N times," verify all N instances by globbing for the pattern before writing the AC.
