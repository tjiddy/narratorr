---
scope: [backend]
files: [src/server/routes/auth.ts, src/server/routes/auth.test.ts]
issue: 382
source: review
date: 2026-03-15
---
Reviewer caught that logout cookie tests didn't assert the `secure` attribute which depends on `config.isDev`. The test environment defaults to `isDev=true`, so `Secure` is never emitted — removing `secure` from clearCookie would not fail any test. Fix: mock config, test both dev mode (no Secure) and prod mode (Secure present), and compare login vs logout. When testing env-dependent cookie attributes, always exercise both branches.
