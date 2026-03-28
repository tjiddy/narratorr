---
scope: [backend, services]
files: [src/server/services/import.service.ts]
issue: 349
date: 2026-03-16
---
The import pipeline had 3 redundant `settingsService.get('processing')` calls mid-import (lines 188, 353, 386 in original). When extracting phases, snapshot all settings in a single `Promise.all()` at the top. This is both a correctness improvement (no mid-import setting changes) and a performance win.
