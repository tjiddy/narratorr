---
scope: [scope/backend]
files: []
issue: 315
source: spec-review
date: 2026-03-11
---
Spec said encryption key was "derived from" an env var without specifying the format (hex? base64? passphrase?), validation rules, or error behavior for malformed input. This left the AC unimplementable — different implementers would choose incompatible encodings. Lesson: any AC that references external input (env vars, config files, user-provided values) must specify the exact format, validation rule, and error behavior. "Derived from" is not a spec — it's a hand-wave.
