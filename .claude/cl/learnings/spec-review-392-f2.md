---
scope: [scope/backend]
files: []
issue: 392
source: spec-review
date: 2026-03-15
---
Reviewer caught that the fixture blast radius inventory was already stale — `NetworkSettingsSection.test.tsx` was listed but its 12+ callsites weren't quantified, and the fixed "13/13" count created a false sense of completeness. Root cause: the inventory was snapshot-based rather than criteria-based. Prevention: when AC requires "all X are migrated", define verification as a grep command or pattern match, not a fixed file list. File lists go stale between spec-writing and implementation.
