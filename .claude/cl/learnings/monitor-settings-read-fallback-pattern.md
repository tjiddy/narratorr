---
scope: [backend]
files: [src/server/jobs/monitor.ts]
issue: 118
date: 2026-03-25
---
When reading settings inside `handleDownloadFailure` (or any similar job-level function), wrap the settings read in a try/catch and initialize the flag to the safe fallback BEFORE the try block. Pattern: `let redownloadFailed = true; try { redownloadFailed = (await settingsService.get('import')).redownloadFailed; } catch (err) { log.warn(...) }`. This ensures an unhandled exception from the settings DB doesn't propagate to the outer `monitorDownloads` catch — which would skip the intended `recoverBookStatus` call and leave the book in a bad state.
