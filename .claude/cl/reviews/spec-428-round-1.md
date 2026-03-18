---
skill: respond-to-spec-review
issue: 428
round: 1
date: 2026-03-17
fixed_findings: [F1, F2, F3]
---

### F1: Docker runner-stage AC impossible on Alpine 3.21
**What was caught:** `apk add 'nodejs~=24'` fails on Alpine 3.21 because the repo only ships Node 22.
**Why I missed it:** Assumed Alpine package availability without running a live verification against the base image. The spec was written by analogy with the existing `nodejs~=22` pattern without checking that the pattern extends to v24.
**Prompt fix:** Add to `/spec` Touch Points checklist: "For Docker package version changes, run `docker run --rm <base-image> apk add --no-cache '<pkg>~=<version>'` to verify package availability before writing the AC."

### F2: Vague @types/node AC
**What was caught:** "Node 24-compatible version" is not a crisp pass/fail criterion.
**Why I missed it:** Used qualitative language ("compatible") instead of quantitative ("^24.x in package.json, 24.x in lockfile"). Version-related ACs need concrete ranges.
**Prompt fix:** Add to `/spec` AC quality checklist: "Version-bump ACs must specify the exact semver range and where it appears (package.json field, lockfile resolution), not just 'compatible' or 'updated'."

### F3: Missing test file from touch points
**What was caught:** `docker/s6-service.test.ts` hardcodes Node 22 assertions and was not listed in touch points.
**Why I missed it:** Only audited production files (Dockerfile, CI workflows) for version references, not test files. Didn't grep for the old version string across the full repo.
**Prompt fix:** Add to `/spec` Touch Points step: "Grep the entire repo for the old value being replaced (e.g., `22` in version strings) to catch test files, fixtures, and assertions that reference it — not just production code."
