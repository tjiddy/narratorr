---
scope: [backend]
files: [src/server/plugins/helmet-options.ts, SECURITY.md]
issue: 16
date: 2026-03-20
---
For self-hosted single-user apps, `style-src 'unsafe-inline'` is an acceptable tradeoff — it permits React inline `style={{...}}` props and JS-set styles without meaningful XSS risk increase (no untrusted user-generated HTML). When adding `'unsafe-inline'` to any CSP directive, check if existing tests assert `not.toContain("'unsafe-inline'")` globally — they likely need narrowing to the specific directive (e.g., `not.toMatch(/script-src[^;]*'unsafe-inline'/)`). Also update SECURITY.md to keep the documented security posture in sync with actual CSP headers.
