---
scope: [scope/frontend, scope/api]
files: []
issue: 418
source: spec-review
date: 2026-03-17
---
Reviewer caught that AC7/AC8 were too narrow — they covered `FILTER_OPTIONS` and `SuggestionRow.reason` but missed `DiscoverStats` interface keys and `ReasonFilter` type, both of which also hardcode reason values. Root cause: I listed one artifact per file rather than auditing all exports from each file that reference reason values. Prevention: when writing AC for "derive from shared source", audit every exported symbol in each affected file, not just the most obvious one.