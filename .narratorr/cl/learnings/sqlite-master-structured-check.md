---
scope: [backend]
files: [src/server/services/backup.service.ts]
issue: 197
date: 2026-03-29
---
Use `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='X'` to check table existence instead of catching errors from `SELECT ... FROM X`. The structured check avoids string-matching on error messages (which vary by SQLite library) and makes the intent explicit. When the table check is separate from the data query, mock setup in tests needs `mockResolvedValueOnce` for each call.
