---
scope: [backend, services]
files: [src/server/services/library-scan.service.ts, src/server/utils/enrichment-utils.ts]
issue: 71
date: 2026-03-24
---
`enrichBookFromAudio` takes an optional `bookService?` parameter for writing narrator junction rows. When the parameter is omitted at a call site, narrator tags from audio files are silently dropped — no error, no warning. Self-review caught this bug at two call sites in library-scan.service.ts. Pattern: whenever adding an optional parameter that enables a side effect, grep all call sites immediately rather than assuming they'll be noticed during testing.
