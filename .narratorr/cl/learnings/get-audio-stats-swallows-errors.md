---
scope: [backend, services]
files: [src/server/services/library-scan.helpers.ts]
issue: 618
date: 2026-04-17
---
`getAudioStats` wraps its entire body in try/catch and returns `{ fileCount: 0, totalSize: 0 }` on error. When writing tests that need `processOneImport` to fail, mocking `readdir` to reject does NOT work — the error is swallowed. Instead, mock `enrichBookFromAudio` to reject, since `orchestrateBookEnrichment` propagates errors to the caller.
