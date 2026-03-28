---
scope: [scope/backend]
files: [apps/narratorr/src/server/services/library-scan.service.ts]
issue: 202
date: 2026-02-24
---
When implementing an in-memory concurrency lock (`this.scanning = true`), set it immediately after the check — before any `await` calls. If you set the lock after async validation (settings fetch, fs.access), a second concurrent call can slip through during the async gap. The lock and its check must be synchronous back-to-back. The `finally` block still clears it correctly either way.
