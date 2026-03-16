---
scope: [scope/backend]
files: []
issue: 392
source: spec-review
date: 2026-03-15
---
Reviewer caught that the spec referenced `DeepPartial<Settings>` as if it already existed in the codebase. Root cause: the spec assumed a utility type without verifying it exists or specifying where to create it. Prevention: when an AC references a type that doesn't exist yet, explicitly state it needs to be created and where it should live.
