---
scope: [backend]
files: [src/server/services/quality-gate-orchestrator.ts]
issue: 358
source: review
date: 2026-04-05
---
When a method promotes a dependent entity's status (book → importing) before performing fallible operations, the generic catch block must revert that promotion — not just handle the primary entity (download → pending_review). The existing `holdForProbeFailure` and `dispatchSideEffects` methods already had revert logic for their specific error paths, but the outer catch (unhandled errors from processDownload/dispatchSideEffects) was missing it. The gap was in the implementation, not the spec — the spec explicitly covered the revert contract but the outer catch was a copy of the batch path which didn't need revert (batch path doesn't promote book).