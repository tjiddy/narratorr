---
scope: [backend, core]
files: [src/server/services/import.service.ts, src/server/services/bulk-operation.service.ts, src/core/utils/audio-processor.ts]
issue: 210
source: review
date: 2026-03-29
---
When fixing a review finding about missing tests for parameter forwarding, fix ALL sibling branches — not just the first one. Round 1 asked for service-level propagation tests. We added tests for buildTargetPath, countRenameEligible, and mergeFiles, but missed: (1) import service forwarding to runAudioProcessing + renameFilesWithTemplate, (2) bulk-operation's startRenameJob (sibling of countRenameEligible), (3) audio-processor's convertFiles (sibling of mergeFiles). Pattern: when a function has multiple call sites or a class has multiple methods calling the same helper, test EVERY call site, not just the first one you find.
