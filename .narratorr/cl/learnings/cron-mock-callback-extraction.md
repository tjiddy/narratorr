---
scope: [backend]
files: [apps/narratorr/src/server/jobs/import.ts, apps/narratorr/src/server/jobs/import.test.ts]
issue: 256
date: 2026-03-05
---
To test cron job callbacks, mock `node-cron` with `vi.mock`, then extract the callback from `cron.schedule.mock.calls[0][1]` and invoke it directly. This avoids needing to wait for real timers and lets you test both success and error paths synchronously.
