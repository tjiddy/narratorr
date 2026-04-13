---
scope: [core]
files: [src/core/download-clients/types.ts]
issue: 527
date: 2026-04-13
---
Changing an adapter interface signature (`addDownload(url)` → `addDownload(artifact)`) requires updating every test file that mocks the adapter — not just the adapter implementation files. The blast radius was 11 test files. For interface changes, enumerate ALL mock callsites up front (grep for the method name in `**/*.test.ts*`) and budget time accordingly. Parallelizing subagents per adapter test file was effective for this scale.
