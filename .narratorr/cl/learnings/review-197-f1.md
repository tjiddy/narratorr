---
scope: [backend]
files: [src/server/services/backup.service.ts]
issue: 197
source: review
date: 2026-03-29
---
When replacing string-based error classification with a blanket catch, don't collapse all errors into one category. System-level I/O errors (with `NodeJS.ErrnoException.code`) should propagate unchanged — only library-level parse/format errors should be translated. Check for `.code` property to distinguish system errors from library errors.
