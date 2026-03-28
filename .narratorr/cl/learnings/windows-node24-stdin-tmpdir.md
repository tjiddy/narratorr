---
scope: [core, backend]
files: [scripts/capture-releases.ts]
issue: 118
date: 2026-02-23
---
Node v24 on Windows has two gotchas for scripting: (1) piping to `node -e` fails with `ENOENT: no such file or directory, open 'C:\dev\stdin'` — use temp files instead, and (2) `/tmp` doesn't exist — use the `$TEMP` environment variable. Also `tsx` isn't installed, but Node v24 runs `.ts` files natively via type stripping.
