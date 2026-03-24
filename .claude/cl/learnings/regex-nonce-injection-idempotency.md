---
scope: [backend]
files: [src/server/server-utils.ts]
issue: 7
date: 2026-03-19
---
When injecting nonces into HTML via regex after already injecting a config script with a nonce, the regex must exclude tags that already have `nonce=` to avoid double-nonce. Use negative lookahead `(?![^>]*\bnonce\b)` alongside the `(?![^>]*\bsrc\b)` exclusion for external scripts. Order of operations matters: inject config script first (with nonce in template literal), then run global regex to nonce remaining inline scripts.
