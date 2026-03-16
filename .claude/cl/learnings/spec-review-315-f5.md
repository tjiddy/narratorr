---
scope: [scope/backend, scope/services]
files: [src/server/services/auth.service.ts]
issue: 315
source: spec-review
date: 2026-03-11
---
Spec claimed auth session secret was "already hashed via scrypt" to justify excluding it from encryption scope. Actually, scrypt is only used for user passwords — sessionSecret is stored as plaintext hex from randomBytes(32), and apiKey is a plaintext UUID. Lesson: verify code assumptions before writing scope exclusion rationale. A false rationale undermines the scope decision even if the decision itself might be valid.
