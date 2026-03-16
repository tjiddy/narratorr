---
scope: [scope/backend]
files: [src/server/routes/settings.ts]
issue: 263
source: review
date: 2026-03-08
---
Proxy URLs can contain embedded credentials (`http://user:pass@host:port`). Logging raw proxy URLs at info/warn level creates a plaintext secret exposure path. Always redact credentials from URLs before logging — use `new URL()` to parse and replace username/password with `***`.
