---
scope: [backend, core]
files: [src/core/utils/audio-processor.ts, src/server/services/settings.service.ts]
issue: 66
date: 2026-03-24
---
`detectFfmpegPath` must be a standalone helper (not in SettingsService) because it calls `probeFfmpeg` which uses Node's `execFile` — a runtime dependency that SettingsService shouldn't own. The spec was clarified in round 2 of spec review to distinguish path *discovery* (detectFfmpegPath) from path *validation* (probeFfmpeg). Discovery tries `/usr/bin/ffmpeg` first via probe, then falls back to `which ffmpeg` — both can be mocked in tests via the existing `execFile` mock pattern.
