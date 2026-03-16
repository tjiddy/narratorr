---
scope: [backend]
files: [src/server/utils/secret-codec.ts, src/server/index.ts]
issue: 315
source: review
date: 2026-03-11
---
Key generation without logging violates the principle that security-sensitive operations should be auditable. When a function has multiple code paths with different security implications (env var vs file vs generate), return metadata about which path was taken so callers can log appropriately. Don't bury observability inside utility functions.
