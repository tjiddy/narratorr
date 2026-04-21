---
scope: [scope/infra]
files: [.gitignore]
issue: 662
source: review
date: 2026-04-21
---
Same root cause as F3: a `.gitignore` tweak (dropping the trailing slash on
`.agents` so the symlink gets ignored instead of just the directory pattern)
was bundled into a scoped SABnzbd PR. Correct fix, wrong PR.

Why we missed it: the postGate "no-uncommitted-files" check rejected the
implementation payload because `.agents` was untracked. The path of least
resistance was to edit `.gitignore` and recommit. Same pragmatism-vs-scope
tension as F3.

Prevention: when a workflume gate rejects because of an ENVIRONMENT file
(symlinks, local tooling artifacts, editor caches), the environment config
belongs in a separate infrastructure commit, not in the issue branch. The
unblock path for an issue PR should only ever touch files listed in that
issue's AC. If a gate fails on an environment file, surface it to workflume/
humans rather than silently fixing it in-branch.
