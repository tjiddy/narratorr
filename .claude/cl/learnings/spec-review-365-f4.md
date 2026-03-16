---
scope: [scope/backend, scope/core]
files: [src/core/download-clients/types.ts, src/server/jobs/monitor.ts]
issue: 365
source: spec-review
date: 2026-03-15
---
Spec review caught that L-13 (mapDownloadStatus default branch) targets the wrong layer. `DownloadItemInfo.status` is a closed union (`'downloading' | 'seeding' | 'paused' | 'completed' | 'error'`) enforced at the adapter level. Each adapter normalizes raw upstream states before returning, so the default branch in `mapDownloadStatus` is unreachable under the type contract.

Root cause: `/elaborate` accepted the finding that the default branch "silently hides new upstream states" without checking the input type. The type contract makes the branch unreachable — the real risk (if any) is at the adapter mapping layer, not at `mapDownloadStatus`.

Prevention: When a spec targets a switch/map default branch, check the input type first. If the input is a closed union with no escape hatch, the default is unreachable and the finding should be retargeted to where unknown values are actually normalized.
