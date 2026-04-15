---
scope: [core, backend]
files: [src/server/plugins/error-handler.ts, src/core/download-clients/errors.ts]
issue: 558
date: 2026-04-15
---
ERROR_REGISTRY uses `instanceof` checks in Map iteration order. When registering an error class hierarchy (e.g., `DownloadClientAuthError extends DownloadClientError`), subclasses MUST appear before the base class in the Map — otherwise the base class entry catches all subclass instances first. This is the same pattern as catch blocks but less obvious in a Map.
