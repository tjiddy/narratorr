---
scope: [core]
files: [src/core/download-clients/retry.ts, src/core/download-clients/transmission.ts, src/core/download-clients/deluge.ts]
issue: 558
date: 2026-04-15
---
When extracting per-adapter retry logic into a shared utility, adapter-specific retry conditions (e.g., Transmission's 409 session ID rotation vs Deluge's RPC error code 1) can be distinguished using closure variables (`was409`, `wasAuthFailure`) set inside the request function and read by `shouldRetry`. This avoids needing custom error subclasses or adding fields to errors just for retry routing.
