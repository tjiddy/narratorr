---
scope: [core]
files: [src/core/utils/audio-processor.ts, src/core/utils/cover-art.ts]
issue: 424
date: 2026-04-08
---
When extracting a multi-step pipeline (detect → extract → encode → reattach) from an existing function, passing the spawn function as a parameter avoids circular imports and keeps the extraction clean. The `withCoverArtPipeline` wrapper pattern — accepting a `processFn` callback — lets both mergeFiles and convertFiles share the same cover art lifecycle without changing their caller signatures.
