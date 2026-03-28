---
scope: [backend]
files: [src/server/server-utils.ts, src/server/plugins/helmet-options.ts]
issue: 7
date: 2026-03-19
---
CSP `script-src 'self'` already permits same-origin external scripts — nonces are only needed for inline `<script>` blocks. The original spec incorrectly targeted Vite asset tags (external, same-origin) when the real violation was the inline theme bootstrap IIFE. Always verify the actual CSP violation surface before designing the fix.
