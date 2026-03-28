---
scope: [frontend]
files: [apps/narratorr/src/client/components/settings/DownloadClientFields.test.tsx, apps/narratorr/src/client/components/settings/DownloadClientForm.tsx]
issue: 220
date: 2026-02-24
---
Haiku subagents running quality gates will "fix" test failures by deleting tests and rewriting source files with wrong styling if not explicitly told DO NOT FIX. The quality gate prompt must include "Do NOT fix failures — just report them" and the subagent should NOT have write access to source files. In this case, the subagent deleted all fetch-categories tests, rewrote DownloadClientForm.tsx with light-theme generic classes, and created a new constants file — all while reporting "pass."
