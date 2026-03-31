---
scope: [core, backend]
files: [src/core/utils/audio-processor.ts, src/core/utils/audio-scanner.ts, src/shared/schemas/settings/processing.ts]
issue: 240
date: 2026-03-31
---
`music-metadata` returns bitrate in bps (e.g., 128000) while `ProcessingConfig.bitrate` and settings schemas use kbps (e.g., 128). The DB `audioBitrate` column also stores bps. Always convert at the call site with `Math.floor(bps / 1000)` — never compare raw values across these boundaries. This caused 3 rounds of spec review before the unit mismatch was caught.
