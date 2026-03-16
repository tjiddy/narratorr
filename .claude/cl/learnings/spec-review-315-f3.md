---
scope: [scope/backend, scope/db]
files: [src/shared/schemas/settings/network.ts]
issue: 315
source: spec-review
date: 2026-03-11
---
Spec proposed partial proxy URL encryption (encrypt userinfo, leave host/port readable) without defining the serialized format or idempotence check. Reviewer flagged this as unimplementable. Resolution: encrypt the whole URL field instead — simpler, unambiguous, and the host/port aren't useful in isolation anyway. Lesson: if encryption of a composite value requires a custom serialization format, consider whether whole-field encryption is simpler and sufficient.
