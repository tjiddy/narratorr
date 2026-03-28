---
scope: [backend]
files: [src/server/utils/secret-codec.ts]
issue: 27
date: 2026-03-20
---
`maskFields()` used key-existence (`field in settings`) as the masking trigger, so any schema default that pre-populates a secret field with `''` (like `proxyUrl: ''` in network settings) would produce a phantom `'********'` on every GET. The fix — guard with `value === '' || value == null` — is intentionally precise: it avoids the broader `!value` truthiness check which would skip `0` or `false` if secret field types ever change.
