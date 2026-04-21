---
scope: [scope/infra]
files: [package.json]
issue: 662
source: review
date: 2026-04-21
---
Reviewer (and maintainer) flagged that a `"verify"` script alias was bundled
into an issue-scoped refactor PR. The alias is a legitimate fix — the
workflume postGate expected `pnpm verify` but the project only had
`node scripts/verify.ts` — but it's unrelated to #662's SABnzbd constant
extraction.

Why we missed it: when a postGate failure happens mid-flow, the fastest path
to unblock is "add the missing alias and move on". That pragmatism is correct
for the workflow but wrong for scope hygiene — it silently expands the PR's
blast radius.

Prevention: when a workflow gate fails because of missing project-level
infrastructure (missing script, missing config, missing env var), the fix
belongs in a SEPARATE commit on a SEPARATE branch, not bundled into the
currently-open issue branch. Guard: before `/handoff`, diff against main and
confirm every changed file is listed in the issue's acceptance criteria or
clearly in its blast radius. Drive-by fixes should be their own chore issue.
